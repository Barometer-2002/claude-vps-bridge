import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { inspectBridge } from './bridge-installation.mjs';

const execFileAsync = promisify(execFile);
const nativeDir = path.dirname(fileURLToPath(import.meta.url));
const INSTANCE_ID = 'claude-vps';
const DISPLAY_NAME = 'Claude VPS';
const VERSION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SHIM_NAME = 'claude-vps-shim.exe';
const VERSION_CACHE_NAME = 'vps-version-cache.json';

const SCRIPT_ASSETS = [
  { name: 'bridge-installation.mjs', src: path.join(nativeDir, 'bridge-installation.mjs') },
  { name: 'mcp-policy.mjs', src: path.join(nativeDir, 'mcp-policy.mjs') },
  { name: 'http-mcp-client.mjs', src: path.join(nativeDir, 'http-mcp-client.mjs') },
  { name: 'claude-vps-shim.mjs', src: path.join(nativeDir, 'claude-vps-shim.mjs') },
];

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function normalizePath(value) {
  try { return realpathSync.native(value).toLowerCase(); } catch {}
  return path.normalize(value).toLowerCase();
}

async function readOptional(file) {
  try {
    return await readFile(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function cleanupRetiredFiles(dir) {
  try {
    const entries = await readdir(dir);
    for (const name of entries) {
      if (/^claude-vps-shim\.exe\.[0-9a-f-]+\.old$/i.test(name)) {
        await rm(path.join(dir, name), { force: true }).catch(() => {});
      }
    }
  } catch {
    // Best-effort cleanup of retired in-use executables.
  }
}

async function writeAtomic(file, payload, expected) {
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

async function removeExpectedFile(file, expected) {
  const current = await readOptional(file);
  if (current === null) return false;
  if (!current.equals(expected)) throw new Error(`文件已被另一进程修改，请重试。${file}`);
  await rm(file);
  return true;
}

async function rollbackFiles(changes, error) {
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

function findCsc() {
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

function usesShim(provider, exePath) {
  return typeof provider?.config?.binaryPath === 'string'
    && path.isAbsolute(provider.config.binaryPath)
    && normalizePath(provider.config.binaryPath) === normalizePath(exePath);
}

function ownsProvider(provider, exePath) {
  return provider?.driver === 'claudeAgent' && usesShim(provider, exePath);
}

function checkProviderOwnership(providers, exePath) {
  const provider = providers[INSTANCE_ID];
  if (Object.hasOwn(providers, INSTANCE_ID) && !ownsProvider(provider, exePath)) {
    throw new Error(`T3 Provider ID ${INSTANCE_ID} 已被其他配置使用。`);
  }
  for (const [id, entry] of Object.entries(providers)) {
    if (id !== INSTANCE_ID && usesShim(entry, exePath)) {
      throw new Error(`T3 Provider ${id} 也使用此 Shim，请先核对其配置。`);
    }
  }
  return provider;
}

async function readSettings(home) {
  const requested = path.join(home, 'userdata', 'settings.json');
  let file;
  try {
    file = await realpath(requested);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`找不到 T3 设置文件。请先打开本机 T3 Code 一次。${requested}`);
    throw error;
  }
  const original = await readFile(file);
  const source = original.toString('utf8');
  const data = JSON.parse(source.replace(/^\uFEFF/, ''));
  if (!isObject(data) || (data.providerInstances !== undefined && !isObject(data.providerInstances))) {
    throw new Error('T3 设置格式与预期不符。');
  }
  return { file, requested, original, data };
}

async function assertSettingsUnchanged({ file, requested, original }) {
  if ((await realpath(requested)) !== file || !(await readOptional(file))?.equals(original)) {
    throw new Error('T3 设置在操作期间发生变化，请重试。');
  }
}

async function saveSettings(settings) {
  const { file, original, data } = settings;
  const source = original.toString('utf8');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  await assertSettingsUnchanged(settings);
  await writeAtomic(file, bom + JSON.stringify(data, null, 2).replaceAll('\n', newline) + newline, original);
}

async function readCachedVersion(installDir) {
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

async function runExeSelfTest(exePath, timeoutMs = 15_000) {
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

async function runLiveVersionProbe(exePath, timeoutMs = 20_000) {
  try {
    const { stdout } = await execFileAsync(exePath, ['--version', '--live'], { windowsHide: true, timeout: timeoutMs });
    const version = stdout.trim();
    if (!version) return { ok: false, version: null, error: 'Empty live version response from VPS' };
    return { ok: true, version, error: null };
  } catch (err) {
    return { ok: false, version: null, error: err?.stderr?.trim() || err?.message || 'Live VPS connectivity probe failed' };
  }
}

async function install(t3Home, { offline = false } = {}) {
  const bridge = await inspectBridge();
  const installDir = path.join(t3Home, 'integrations', 'claude-vps-native');
  const homeDir = path.join(installDir, 'claude-home');
  const exePath = path.join(installDir, SHIM_NAME);
  const settings = await readSettings(t3Home);

  settings.data.providerInstances ??= {};
  const providers = settings.data.providerInstances;
  const prior = checkProviderOwnership(providers, exePath);

  await mkdir(homeDir, { recursive: true });
  await cleanupRetiredFiles(installDir);
  const stagingDir = path.join(installDir, `.staging-${randomUUID()}`);
  const changes = [];
  let liveVersionOut = null;

  try {
    // 1. Stage all assets and compile shim executable inside isolated staging directory first.
    await mkdir(stagingDir, { recursive: true });
    const scriptFiles = [];
    for (const asset of SCRIPT_ASSETS) {
      const payload = await readFile(asset.src);
      const stagedPath = path.join(stagingDir, asset.name);
      await writeFile(stagedPath, payload);
      scriptFiles.push({ target: path.join(installDir, asset.name), payload });
    }

    const csc = findCsc();
    const csSource = path.join(nativeDir, 'claude-vps-shim.cs');
    const stagedExe = path.join(stagingDir, SHIM_NAME);
    await execFileAsync(csc, ['/nologo', '/optimize+', '/target:exe', `/out:${stagedExe}`, csSource], { windowsHide: true });
    const executable = { target: exePath, payload: await readFile(stagedExe) };
    const stagedFiles = [...scriptFiles, executable];

    // 2. Self-test the staged installed layout BEFORE touching any live file or settings.json.
    const selfTest = await runExeSelfTest(stagedExe);
    if (!selfTest.ok) {
      throw new Error(`暂存版本离线自检失败，已中止升级（旧安装与设置未改动）：${selfTest.error}`);
    }
    if (!offline) {
      const liveProbe = await runLiveVersionProbe(stagedExe);
      if (!liveProbe.ok) {
        throw new Error(`暂存版本远端实时连通校验失败，已中止升级（旧安装与设置未改动）：${liveProbe.error}`);
      }
      liveVersionOut = liveProbe.version;
    }

    for (const item of stagedFiles) item.before = await readOptional(item.target);
    await assertSettingsUnchanged(settings);

    if (!prior) {
      const conflict = scriptFiles.find(item => item.before && !item.before.equals(item.payload));
      if (conflict) throw new Error(`安装目录已有同名文件，请先核对其来源。${conflict.target}`);
      if (executable.before && !executable.before.equals(executable.payload)) {
        // Framework csc changes PE metadata on each build. Recover an unregistered
        // layout only when all package scripts match, and preserve the previous EXE.
        if (!scriptFiles.every(item => item.before?.equals(item.payload))) {
          throw new Error(`安装目录已有同名文件，请先核对其来源。${exePath}`);
        }
        const backup = `${exePath}.before-reinstall-${randomUUID()}`;
        await writeFile(backup, executable.before, { flag: 'wx' });
        console.log(`已保留旧 Shim：${backup}`);
      }
    }

    // 3. Atomically switch staged files into installDir with rollback tracking.
    for (const item of stagedFiles) {
      const before = item.before;
      if (before?.equals(item.payload)) continue;
      await writeAtomic(item.target, item.payload, before);
      changes.push({ file: item.target, before, after: item.payload });
    }
    const installedSelfTest = await runExeSelfTest(exePath);
    if (!installedSelfTest.ok) throw new Error(`安装布局离线自检失败，正在回滚：${installedSelfTest.error}`);

    // 4. Preserve user customizations in settings.json and save with concurrency check.
    const updated = {
      ...prior,
      driver: 'claudeAgent',
      displayName: prior?.displayName ?? DISPLAY_NAME,
      enabled: prior?.enabled ?? true,
      config: {
        ...prior?.config,
        enabled: prior?.config?.enabled ?? true,
        binaryPath: exePath,
        homePath: prior?.config?.homePath ?? homeDir,
      },
    };
    if (JSON.stringify(updated) !== JSON.stringify(prior)) {
      providers[INSTANCE_ID] = updated;
      await saveSettings(settings);
    } else await assertSettingsUnchanged(settings);

    // Refresh cache file cleanly after successful switch.
    const stagedCache = await readOptional(path.join(stagingDir, VERSION_CACHE_NAME));
    if (stagedCache) {
      await writeFile(path.join(installDir, VERSION_CACHE_NAME), stagedCache).catch(() => {});
    }
  } catch (error) {
    await rollbackFiles(changes, error);
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`已注册独立原生 Claude 实例 "${DISPLAY_NAME}" (${INSTANCE_ID})，底层复用 Bridge ${bridge.version}。`);
  console.log(`Shim 可执行文件：${exePath}`);
  console.log(`独立配置目录：${homeDir}`);
  if (offline) {
    console.log('远端实时版本探测：已跳过（--offline 模式，离线安装布局自检通过）');
  } else {
    console.log(`远端实时版本探测：${liveVersionOut}`);
  }
  console.log('未修改默认 claudeAgent 实例与本机 ~/.claude。');
}

async function status(t3Home, { offline = false } = {}) {
  const installDir = path.join(t3Home, 'integrations', 'claude-vps-native');
  const exePath = path.join(installDir, SHIM_NAME);
  const settings = await readSettings(t3Home);
  const entry = settings.data.providerInstances?.[INSTANCE_ID];
  const owns = ownsProvider(entry, exePath);

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
  const cachedVersion = await readCachedVersion(installDir);
  const offlineSelfTest = binaryPresent ? await runExeSelfTest(exePath) : { ok: false, error: 'Binary missing' };
  const liveCheck = offline
    ? { skipped: true, ok: null, version: null, error: null }
    : binaryPresent
      ? await runLiveVersionProbe(exePath)
      : { ok: false, version: null, error: 'Binary missing' };

  console.log(JSON.stringify({
    t3Home,
    instanceId: INSTANCE_ID,
    provider: !entry ? 'absent' : !owns ? 'id-in-use'
      : (entry.enabled === false || entry.config?.enabled === false ? 'disabled' : 'enabled'),
    registered: Boolean(entry && owns),
    driver: entry?.driver ?? null,
    enabled: Boolean(entry && owns && entry.enabled !== false && entry.config?.enabled !== false),
    binaryPath: exePath,
    binaryPresent,
    matchesThisPackage: Object.fromEntries(assetMatches),
    offlineSelfTest: { ok: offlineSelfTest.ok, ...(offlineSelfTest.error ? { error: offlineSelfTest.error } : {}) },
    cachedVersion,
    liveCheck,
    bridge,
  }, null, 2));
}

async function uninstall(t3Home) {
  const installDir = path.join(t3Home, 'integrations', 'claude-vps-native');
  const exePath = path.join(installDir, SHIM_NAME);
  const settings = await readSettings(t3Home);
  const providers = settings.data.providerInstances ?? {};
  if (!checkProviderOwnership(providers, exePath)) {
    console.log(`T3 实例 "${INSTANCE_ID}" 未注册。`);
    return;
  }

  const files = [SHIM_NAME, ...SCRIPT_ASSETS.map(asset => asset.name), VERSION_CACHE_NAME];
  const changes = [];
  try {
    await assertSettingsUnchanged(settings);
    for (const name of files) {
      const file = path.join(installDir, name);
      const before = await readOptional(file);
      if (before !== null && await removeExpectedFile(file, before)) {
        changes.push({ file, before, after: null });
      }
    }
    delete providers[INSTANCE_ID];
    await saveSettings(settings);
  } catch (error) {
    await rollbackFiles(changes, error);
  }
  await cleanupRetiredFiles(installDir);
  console.log(`已移除独立原生 Claude 实例 "${INSTANCE_ID}"（保留 claude-home，未影响其他 Provider）。`);
}

async function main() {
  const { values, positionals: [action = 'help', ...unexpected] } = parseArgs({
    allowPositionals: true,
    options: {
      't3-home': { type: 'string' },
      offline: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help || action === 'help') {
    console.log('用法  node manage-native.mjs <install|status|uninstall> [--t3-home <目录>] [--offline]');
    return;
  }
  if (unexpected.length || !['install', 'status', 'uninstall'].includes(action)) {
    throw new Error('参数无效。运行 node manage-native.mjs --help 查看用法。');
  }
  if (process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) < 24) {
    throw new Error('此安装包需要 Windows 和 Node.js 24 或更新版本。');
  }

  const requestedHome = path.resolve(values['t3-home'] ?? process.env.T3CODE_HOME ?? path.join(os.homedir(), '.t3'));
  const t3Home = await realpath(requestedHome).catch(error => {
    if (error.code === 'ENOENT') return requestedHome;
    throw error;
  });
  if (action === 'status') {
    await status(t3Home, { offline: values.offline });
    return;
  }

  const installDir = path.join(t3Home, 'integrations', 'claude-vps-native');
  await mkdir(installDir, { recursive: true });
  const lock = path.join(installDir, '.manage.lock');
  try {
    await writeFile(lock, String(process.pid), { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`安装目录有正在使用的管理锁。${lock}`);
    throw error;
  }
  try {
    if (action === 'install') await install(t3Home, { offline: values.offline });
    else await uninstall(t3Home);
  } finally {
    await rm(lock, { force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
