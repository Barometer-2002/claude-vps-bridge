import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { inspectBridge } from './bridge-installation.mjs';

const execFileAsync = promisify(execFile);
const shimSourceDir = path.dirname(fileURLToPath(import.meta.url));
const VERSION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export const SHIM_NAME = 'claude-vps-shim.exe';
export const NODE_PATH_NAME = 'node-path.txt';
export const VERSION_CACHE_NAME = 'vps-version-cache.json';
export const CONSUMERS_NAME = 'consumers.json';

export const SCRIPT_ASSETS = [
  { name: 'bridge-installation.mjs', src: path.join(shimSourceDir, 'bridge-installation.mjs') },
  { name: 'mcp-policy.mjs', src: path.join(shimSourceDir, 'mcp-policy.mjs') },
  { name: 'http-mcp-client.mjs', src: path.join(shimSourceDir, 'http-mcp-client.mjs') },
  { name: 'claude-vps-shim.mjs', src: path.join(shimSourceDir, 'claude-vps-shim.mjs') },
];

export function defaultShimDir(env = process.env) {
  return path.resolve(env?.CLAUDE_VPS_SHIM_DIR || path.join(os.homedir(), '.claude-vps', 'shim'));
}

export function normalizePath(value) {
  try { return realpathSync.native(value).toLowerCase(); } catch {}
  return path.normalize(value).toLowerCase();
}

export async function readOptional(file) {
  try {
    return await readFile(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function cleanupRetiredExeFiles(dir, exeBaseName = SHIM_NAME) {
  const escaped = exeBaseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}\\.[0-9a-f-]+\\.old$`, 'i');
  try {
    const entries = await readdir(dir);
    for (const name of entries) {
      if (pattern.test(name)) {
        await rm(path.join(dir, name), { force: true }).catch(() => {});
      }
    }
  } catch {
    // Best-effort cleanup of retired in-use executables.
  }
}

export async function writeAtomic(file, payload, expected) {
  const staging = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(staging, payload, { flag: 'wx' });
    const current = await readOptional(file);
    const matches = expected === null ? current === null : current?.equals(expected);
    if (!matches) throw new Error(`文件已被另一进程修改，请重试。${file}`);
    try {
      await rename(staging, file);
    } catch (err) {
      // On Windows, a running .exe cannot be overwritten in-place (EPERM/EBUSY),
      // but it can be renamed aside so active sessions keep running while new sessions use the upgrade.
      if (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'EBUSY') && expected !== null && file.toLowerCase().endsWith('.exe')) {
        const retired = `${file}.${randomUUID()}.old`;
        await rename(file, retired);
        try {
          await rename(staging, file);
        } catch (swapErr) {
          await rename(retired, file).catch(() => {});
          throw swapErr;
        }
        await rm(retired, { force: true }).catch(() => {});
      } else {
        throw err;
      }
    }
  } finally {
    await rm(staging, { force: true });
  }
}

export async function removeExpectedFile(file, expected) {
  const current = await readOptional(file);
  if (current === null) return false;
  if (!current.equals(expected)) throw new Error(`文件已被另一进程修改，请重试。${file}`);
  await rm(file);
  return true;
}

export async function rollbackFiles(changes, error) {
  const failures = [];
  for (const { file, before, after } of changes.reverse()) {
    try {
      if (before !== null) await writeAtomic(file, before, after);
      else await removeExpectedFile(file, after);
    } catch (rollbackError) {
      failures.push(rollbackError.message);
    }
  }
  if (failures.length) {
    throw new Error(`${error.message}\n文件回滚未完成：\n${failures.join('\n')}`);
  }
  throw error;
}

export function findCsc() {
  const override = process.env.CLAUDE_VPS_CSC;
  if (override) {
    if (existsSync(override)) return override;
    throw new Error(`CLAUDE_VPS_CSC points to missing compiler: ${override}`);
  }
  const candidates = [
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error('Windows .NET csc.exe not found; cannot build claude-vps-shim.exe');
}

function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== 'ESRCH';
  }
}

async function isLockStale(lockPath) {
  try {
    const raw = (await readFile(lockPath, 'utf8')).trim();
    const pid = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (Number.isSafeInteger(pid) && pid > 0) {
      return !isPidAlive(pid);
    }
    const st = await stat(lockPath);
    return Date.now() - st.mtimeMs > 5000;
  } catch (err) {
    return err?.code === 'ENOENT';
  }
}

export async function acquireManageLock(lockPath) {
  const reapLock = `${lockPath}.reap`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(lockPath, String(process.pid), { flag: 'wx' });
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt < 2) {
        let haveReapLock = false;
        try {
          await writeFile(reapLock, String(process.pid), { flag: 'wx' });
          haveReapLock = true;
        } catch (reapErr) {
          if (reapErr?.code === 'EEXIST' && await isLockStale(reapLock)) {
            await rm(reapLock, { force: true }).catch(() => {});
          }
        }
        if (haveReapLock) {
          try {
            if (await isLockStale(lockPath)) {
              await rm(lockPath, { force: true }).catch(() => {});
              try {
                await writeFile(lockPath, String(process.pid), { flag: 'wx' });
                return;
              } catch {
                // Another process grabbed it cleanly; fall through.
              }
            }
          } finally {
            await rm(reapLock, { force: true }).catch(() => {});
          }
        }
      }
      if (attempt === 0) {
        await new Promise(resolve => setTimeout(resolve, 40));
        continue;
      }
      throw new Error(`安装目录有正在使用的管理锁。${lockPath}`);
    }
  }
}

export async function withDirectoryLock(dir, fn) {
  await mkdir(dir, { recursive: true });
  const lock = path.join(dir, '.manage.lock');
  await acquireManageLock(lock);
  try {
    return await fn();
  } finally {
    await rm(lock, { force: true });
  }
}

export async function readCachedVersion(installDir) {
  const cacheFile = path.join(installDir, VERSION_CACHE_NAME);
  const raw = await readOptional(cacheFile);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (!parsed || typeof parsed.version !== 'string') return null;
    const ageMs = typeof parsed.cachedAt === 'number' ? Date.now() - parsed.cachedAt : Infinity;
    return {
      version: parsed.version.trim(),
      sshHost: parsed.sshHost ?? null,
      cachedAt: typeof parsed.cachedAt === 'number' ? new Date(parsed.cachedAt).toISOString() : null,
      fresh: ageMs >= 0 && ageMs < VERSION_CACHE_TTL_MS,
    };
  } catch {
    return null;
  }
}

export async function runExeSelfTest(exePath, timeoutMs = 15_000) {
  try {
    const { stdout } = await execFileAsync(exePath, ['--self-test'], { windowsHide: true, timeout: timeoutMs });
    const parsed = JSON.parse(stdout.trim());
    return parsed?.ok === true
      ? { ok: true, detail: parsed }
      : { ok: false, error: `Self-test reported ok=false: ${stdout.trim().slice(0, 300)}` };
  } catch (err) {
    return { ok: false, error: err?.stderr?.trim() || err?.message || 'Offline self-test failed' };
  }
}

export async function runLiveVersionProbe(exePath, timeoutMs = 20_000) {
  try {
    const { stdout } = await execFileAsync(exePath, ['--version', '--live'], { windowsHide: true, timeout: timeoutMs });
    const version = stdout.trim();
    if (!version) return { ok: false, version: null, error: 'Empty live version response from VPS' };
    return { ok: true, version, error: null };
  } catch (err) {
    return { ok: false, version: null, error: err?.stderr?.trim() || err?.message || 'Live VPS connectivity probe failed' };
  }
}

async function resolveDirPath(dir) {
  const resolved = path.resolve(dir);
  return realpath(resolved).catch(error => {
    if (error.code === 'ENOENT') return resolved;
    throw error;
  });
}

export async function installShim({ shimDir = defaultShimDir(), offline = false } = {}) {
  const bridge = await inspectBridge();
  const installDir = await resolveDirPath(shimDir);
  const exePath = path.join(installDir, SHIM_NAME);

  return withDirectoryLock(installDir, async () => {
    await cleanupRetiredExeFiles(installDir, SHIM_NAME);
    const stagingDir = path.join(installDir, `.staging-${randomUUID()}`);
    const changes = [];
    let liveVersionOut = null;

    try {
      await mkdir(stagingDir, { recursive: true });
      const scriptFiles = [];
      for (const asset of SCRIPT_ASSETS) {
        const payload = await readFile(asset.src);
        const stagedPath = path.join(stagingDir, asset.name);
        await writeFile(stagedPath, payload);
        scriptFiles.push({ target: path.join(installDir, asset.name), payload });
      }

      const nodePathPayload = Buffer.from(`${process.execPath}\n`, 'utf8');
      await writeFile(path.join(stagingDir, NODE_PATH_NAME), nodePathPayload);
      const nodePathAsset = { target: path.join(installDir, NODE_PATH_NAME), payload: nodePathPayload };

      const csc = findCsc();
      const csSource = path.join(shimSourceDir, 'claude-vps-shim.cs');
      const stagedExe = path.join(stagingDir, SHIM_NAME);
      await execFileAsync(csc, ['/nologo', '/optimize+', '/target:exe', `/out:${stagedExe}`, csSource], { windowsHide: true });
      const executable = { target: exePath, payload: await readFile(stagedExe) };
      const stagedFiles = [...scriptFiles, nodePathAsset, executable];

      // Self-test staged layout before touching live files.
      const selfTest = await runExeSelfTest(stagedExe);
      if (!selfTest.ok) {
        throw new Error(`暂存 Shim 离线自检失败，已中止升级（旧安装未改动）：${selfTest.error}`);
      }
      if (!offline) {
        const liveProbe = await runLiveVersionProbe(stagedExe);
        if (!liveProbe.ok) {
          throw new Error(`暂存 Shim 远端实时连通校验失败，已中止升级（旧安装未改动）：${liveProbe.error}`);
        }
        liveVersionOut = liveProbe.version;
      }

      for (const item of stagedFiles) item.before = await readOptional(item.target);

      for (const item of stagedFiles) {
        const before = item.before;
        if (before?.equals(item.payload)) continue;
        await writeAtomic(item.target, item.payload, before);
        changes.push({ file: item.target, before, after: item.payload });
      }

      const installedSelfTest = await runExeSelfTest(exePath);
      if (!installedSelfTest.ok) {
        throw new Error(`安装布局离线自检失败，正在回滚：${installedSelfTest.error}`);
      }

      const stagedCache = await readOptional(path.join(stagingDir, VERSION_CACHE_NAME));
      if (stagedCache) {
        await writeFile(path.join(installDir, VERSION_CACHE_NAME), stagedCache).catch(() => {});
      }
    } catch (error) {
      await rollbackFiles(changes, error);
    } finally {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }

    return { installDir, exePath, bridge, liveVersionOut, offline };
  });
}

export async function shimStatus({ shimDir = defaultShimDir(), offline = false } = {}) {
  const installDir = await resolveDirPath(shimDir);
  const exePath = path.join(installDir, SHIM_NAME);

  let bridge;
  try {
    const installed = await inspectBridge();
    bridge = { version: installed.version, apiVersion: installed.apiVersion };
  } catch (err) {
    bridge = { error: err.message };
  }

  const assetMatches = await Promise.all(SCRIPT_ASSETS.map(async asset => {
    const installed = await readOptional(path.join(installDir, asset.name));
    const source = await readFile(asset.src);
    return [asset.name, installed?.equals(source) ?? false];
  }));

  const binaryPresent = existsSync(exePath);
  const nodePathPresent = existsSync(path.join(installDir, NODE_PATH_NAME));
  const cachedVersion = await readCachedVersion(installDir);
  const offlineSelfTest = binaryPresent ? await runExeSelfTest(exePath) : { ok: false, error: 'Binary missing' };
  const liveCheck = offline
    ? { skipped: true, ok: null, version: null, error: null }
    : binaryPresent
      ? await runLiveVersionProbe(exePath)
      : { ok: false, version: null, error: 'Binary missing' };

  return {
    shimDir: installDir,
    binaryPath: exePath,
    binaryPresent,
    nodePathPresent,
    matchesThisPackage: Object.fromEntries(assetMatches),
    offlineSelfTest: { ok: offlineSelfTest.ok, ...(offlineSelfTest.error ? { error: offlineSelfTest.error } : {}) },
    cachedVersion,
    liveCheck,
    bridge,
  };
}

async function readConsumersUnlocked(installDir) {
  const file = path.join(installDir, CONSUMERS_NAME);
  const raw = await readOptional(file);
  if (!raw) return { version: 1, consumers: {} };
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (parsed && typeof parsed === 'object' && parsed.consumers && typeof parsed.consumers === 'object') {
      return { version: 1, consumers: { ...parsed.consumers } };
    }
  } catch {}
  return { version: 1, consumers: {} };
}

export async function registerShimConsumer(shimDir, consumerId, info = {}) {
  const installDir = await resolveDirPath(shimDir);
  return withDirectoryLock(installDir, async () => {
    const file = path.join(installDir, CONSUMERS_NAME);
    const before = await readOptional(file);
    const doc = await readConsumersUnlocked(installDir);
    doc.consumers[consumerId] = { ...info, updatedAt: new Date().toISOString() };
    await writeAtomic(file, Buffer.from(`${JSON.stringify(doc, null, 2)}\n`, 'utf8'), before);
    return doc.consumers;
  });
}

export async function unregisterShimConsumer(shimDir, consumerId) {
  const installDir = await resolveDirPath(shimDir);
  if (!existsSync(installDir)) return {};
  return withDirectoryLock(installDir, async () => {
    const file = path.join(installDir, CONSUMERS_NAME);
    const before = await readOptional(file);
    if (!before) return {};
    const doc = await readConsumersUnlocked(installDir);
    delete doc.consumers[consumerId];
    if (Object.keys(doc.consumers).length === 0) {
      await removeExpectedFile(file, before).catch(() => {});
      return {};
    }
    await writeAtomic(file, Buffer.from(`${JSON.stringify(doc, null, 2)}\n`, 'utf8'), before);
    return doc.consumers;
  });
}

export async function listShimConsumers(shimDir) {
  const installDir = await resolveDirPath(shimDir);
  const doc = await readConsumersUnlocked(installDir);
  const active = {};
  for (const [id, entry] of Object.entries(doc.consumers)) {
    const checkPath = typeof entry?.checkPath === 'string' ? entry.checkPath : null;
    if (checkPath && !existsSync(checkPath)) continue;
    active[id] = entry;
  }
  return active;
}

export async function uninstallShim({ shimDir = defaultShimDir(), force = false, excludeConsumer = null } = {}) {
  const installDir = await resolveDirPath(shimDir);
  if (!existsSync(installDir)) {
    return { installDir, removed: [] };
  }
  return withDirectoryLock(installDir, async () => {
    const doc = await readConsumersUnlocked(installDir);
    const blocking = Object.entries(doc.consumers).filter(([id, entry]) => {
      if (id === excludeConsumer) return false;
      const checkPath = typeof entry?.checkPath === 'string' ? entry.checkPath : null;
      return !checkPath || existsSync(checkPath);
    });
    if (!force && blocking.length > 0) {
      throw new Error(`共享中立 Shim 仍被其他组件引用（${blocking.map(([id]) => id).join(', ')}），已保留。如需强制移除请附加 --force。`);
    }
    const files = [SHIM_NAME, NODE_PATH_NAME, ...SCRIPT_ASSETS.map(asset => asset.name), VERSION_CACHE_NAME, CONSUMERS_NAME];
    const changes = [];
    const removed = [];
    try {
      for (const name of files) {
        const file = path.join(installDir, name);
        const before = await readOptional(file);
        if (before !== null && await removeExpectedFile(file, before)) {
          changes.push({ file, before, after: null });
          removed.push(name);
        }
      }
    } catch (error) {
      await rollbackFiles(changes, error);
    }
    await cleanupRetiredExeFiles(installDir, SHIM_NAME);
    return { installDir, removed };
  });
}

async function main() {
  const { values, positionals: [action = 'help', ...unexpected] } = parseArgs({
    allowPositionals: true,
    options: {
      'shim-dir': { type: 'string' },
      offline: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help || action === 'help') {
    console.log('用法  node shim/manage-shim.mjs <install|status|uninstall> [--shim-dir <目录>] [--offline] [--force]');
    return;
  }
  if (unexpected.length || !['install', 'status', 'uninstall'].includes(action)) {
    throw new Error('参数无效。运行 node shim/manage-shim.mjs --help 查看用法。');
  }
  if (process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) < 24) {
    throw new Error('此工具需要 Windows 和 Node.js 24 或更新版本。');
  }

  const shimDir = values['shim-dir'] ?? defaultShimDir();
  if (action === 'install') {
    const result = await installShim({ shimDir, offline: values.offline });
    console.log(`已安装中立 Claude VPS Shim，底层复用 Bridge ${result.bridge.version}。`);
    console.log(`Shim 可执行文件：${result.exePath}`);
    if (result.offline) {
      console.log('远端实时版本探测：已跳过（--offline 模式，离线自检通过）');
    } else {
      console.log(`远端实时版本探测：${result.liveVersionOut}`);
    }
    return;
  }
  if (action === 'status') {
    const status = await shimStatus({ shimDir, offline: values.offline });
    status.consumers = await listShimConsumers(shimDir);
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  const result = await uninstallShim({ shimDir, force: values.force });
  console.log(`已清理中立 Shim 目录中的托管文件（${result.removed.length} 项）：${result.installDir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
