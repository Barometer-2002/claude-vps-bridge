import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { buildWindowsBatchSpawn } from '../shim/http-mcp-client.mjs';
import {
  NODE_PATH_NAME,
  cleanupRetiredExeFiles,
  defaultShimDir,
  findCsc,
  installShim,
  readOptional,
  registerShimConsumer,
  removeExpectedFile,
  rollbackFiles,
  shimStatus,
  uninstallShim,
  unregisterShimConsumer,
  withDirectoryLock,
  writeAtomic,
} from '../shim/manage-shim.mjs';

const execFileAsync = promisify(execFile);
const acpSourceDir = path.dirname(fileURLToPath(import.meta.url));

export const ACP_EXE_NAME = 'claude-vps-acp.exe';
export const SHIM_PATH_NAME = 'shim-path.txt';
export const ACP_SCRIPT_ASSETS = [
  { name: 'workspace-presenter.mjs', src: path.join(acpSourceDir, 'workspace-presenter.mjs') },
  { name: 'claude-vps-acp.mjs', src: path.join(acpSourceDir, 'claude-vps-acp.mjs') },
  { name: 'package.json', src: path.join(acpSourceDir, 'package.json') },
  { name: 'package-lock.json', src: path.join(acpSourceDir, 'package-lock.json') },
];

export function defaultAcpDir(env = process.env) {
  return path.resolve(env?.CLAUDE_VPS_ACP_DIR || path.join(os.homedir(), '.claude-vps', 'acp'));
}

function findNpmCmd() {
  const nodeDir = path.dirname(process.execPath);
  const sibling = path.join(nodeDir, 'npm.cmd');
  if (existsSync(sibling)) return sibling;
  return 'npm.cmd';
}

async function runAcpExeSelfTest(exePath, { pure = false, env = process.env } = {}, timeoutMs = 15_000) {
  try {
    const args = pure ? ['--self-test', '--pure'] : ['--self-test'];
    const { stdout } = await execFileAsync(exePath, args, { env, windowsHide: true, timeout: timeoutMs });
    const parsed = JSON.parse(stdout.trim());
    return parsed?.ok === true
      ? { ok: true, detail: parsed }
      : { ok: false, error: `ACP self-test reported ok=false: ${stdout.trim().slice(0, 300)}` };
  } catch (err) {
    return { ok: false, error: err?.stderr?.trim() || err?.message || 'ACP self-test failed' };
  }
}

async function runAcpStdioHandshakeTest(exePath, { shimExe, env = process.env } = {}, timeoutMs = 15_000) {
  return new Promise(resolve => {
    const child = spawn(exePath, [], {
      env: {
        ...env,
        ...(shimExe ? { CLAUDE_VPS_SHIM_PATH: shimExe } : {}),
      },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let settled = false;
    let initResp = null;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      try { child.stdin.end(); } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, error: `ACP stdio handshake timed out (${stderr.trim().slice(0, 200)})` });
    }, timeoutMs);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1000); });
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', line => {
      try {
        const msg = JSON.parse(line);
        if (msg?.id === 1 && msg?.result) {
          initResp = msg.result;
          try { child.stdin.end(); } catch {}
        }
      } catch {}
    });
    child.on('error', err => finish({ ok: false, error: err?.message || 'Failed to spawn ACP executable' }));
    child.on('close', code => {
      if (!initResp) {
        finish({ ok: false, error: `ACP exited (${code}) before initialize response${stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : ''}` });
        return;
      }
      const caps = initResp.agentCapabilities;
      const valid = initResp.protocolVersion === 1
        && caps?.mcpCapabilities?.sse === false
        && caps?.mcpCapabilities?.acp === false
        && caps?.loadSession === false
        && !('providers' in (caps ?? {}));
      finish(valid
        ? { ok: true, upstreamVersion: initResp.agentInfo?.version ?? null }
        : { ok: false, error: `ACP initialize capabilities check failed: ${JSON.stringify(caps)}` });
    });
    try {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: true }, terminal: true },
        },
      })}\n`);
    } catch (err) {
      finish({ ok: false, error: err?.message || 'Failed to write initialize frame' });
    }
  });
}

async function resolveDirPath(dir) {
  const resolved = path.resolve(dir);
  return realpath(resolved).catch(error => {
    if (error.code === 'ENOENT') return resolved;
    throw error;
  });
}

async function installAcp({ acpDir = defaultAcpDir(), shimDir = defaultShimDir(), offline = false, skipNpm = false } = {}) {
  const installDir = await resolveDirPath(acpDir);
  const exePath = path.join(installDir, ACP_EXE_NAME);
  const resolvedShimDir = await resolveDirPath(shimDir);
  const targetShimExe = path.join(resolvedShimDir, 'claude-vps-shim.exe');

  return withDirectoryLock(installDir, async () => {
    await cleanupRetiredExeFiles(installDir, ACP_EXE_NAME);
    const stagingDir = path.join(installDir, `.staging-${randomUUID()}`);
    const liveNodeModules = path.join(installDir, 'node_modules');
    const backupNodeModules = path.join(installDir, `.node_modules.previous-${randomUUID()}`);
    let movedPreviousNodeModules = false;
    let swappedNodeModules = false;
    const changes = [];
    let shimResult = null;

    try {
      await mkdir(stagingDir, { recursive: true });
      const scriptFiles = [];
      for (const asset of ACP_SCRIPT_ASSETS) {
        const payload = await readFile(asset.src);
        await writeFile(path.join(stagingDir, asset.name), payload);
        scriptFiles.push({ target: path.join(installDir, asset.name), payload });
      }

      const nodePathPayload = Buffer.from(`${process.execPath}\n`, 'utf8');
      await writeFile(path.join(stagingDir, NODE_PATH_NAME), nodePathPayload);
      const nodePathAsset = { target: path.join(installDir, NODE_PATH_NAME), payload: nodePathPayload };

      const shimPathPayload = Buffer.from(`${targetShimExe}\n`, 'utf8');
      await writeFile(path.join(stagingDir, SHIM_PATH_NAME), shimPathPayload);
      const shimPathAsset = { target: path.join(installDir, SHIM_PATH_NAME), payload: shimPathPayload };

      const csc = findCsc();
      const csSource = path.join(acpSourceDir, 'claude-vps-acp.cs');
      const stagedExe = path.join(stagingDir, ACP_EXE_NAME);
      await execFileAsync(csc, ['/nologo', '/optimize+', '/target:exe', `/out:${stagedExe}`, csSource], { windowsHide: true });
      const executable = { target: exePath, payload: await readFile(stagedExe) };
      const stagedFiles = [...scriptFiles, nodePathAsset, shimPathAsset, executable];

      // Pure self-test staged wrapper before touching live files or shared Shim.
      const stagedSelfTest = await runAcpExeSelfTest(stagedExe, { pure: true });
      if (!stagedSelfTest.ok) {
        throw new Error(`暂存 ACP 包装离线自检失败，已中止升级：${stagedSelfTest.error}`);
      }

      // Install pinned upstream package inside stagingDir FIRST so failures never corrupt live node_modules.
      if (!skipNpm) {
        const npmCmd = findNpmCmd();
        const batch = buildWindowsBatchSpawn(npmCmd, [
          '--prefix',
          stagingDir,
          'ci',
          '--omit=optional',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
        ]);
        await execFileAsync(
          batch.executable,
          batch.args,
          { windowsHide: true, windowsVerbatimArguments: batch.windowsVerbatimArguments, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 },
        );
        const stagedHandshake = await runAcpStdioHandshakeTest(stagedExe, { shimExe: targetShimExe });
        if (!stagedHandshake.ok) {
          throw new Error(`暂存 ACP 真实 stdio 握手校验失败，已中止升级：${stagedHandshake.error}`);
        }
      }

      // Stage and verify shared neutral Shim before switching live ACP files.
      shimResult = await installShim({ shimDir: resolvedShimDir, offline });

      if (!skipNpm) {
        if (existsSync(liveNodeModules)) {
          await rename(liveNodeModules, backupNodeModules);
          movedPreviousNodeModules = true;
        }
        await rename(path.join(stagingDir, 'node_modules'), liveNodeModules);
        swappedNodeModules = true;
      }

      for (const item of stagedFiles) item.before = await readOptional(item.target);
      for (const item of stagedFiles) {
        if (item.before?.equals(item.payload)) continue;
        await writeAtomic(item.target, item.payload, item.before);
        changes.push({ file: item.target, before: item.before, after: item.payload });
      }

      const finalSelfTest = await runAcpExeSelfTest(exePath, { pure: skipNpm });
      if (!finalSelfTest.ok) {
        throw new Error(`安装布局 ACP 自检失败，正在回滚：${finalSelfTest.error}`);
      }
      if (!skipNpm) {
        const finalHandshake = await runAcpStdioHandshakeTest(exePath, {});
        if (!finalHandshake.ok) {
          throw new Error(`安装布局 ACP 真实 stdio 握手校验失败，正在回滚：${finalHandshake.error}`);
        }
      }

      await registerShimConsumer(resolvedShimDir, 'acp', {
        acpDir: installDir,
        checkPath: exePath,
      });
      if (movedPreviousNodeModules) {
        await rm(backupNodeModules, { recursive: true, force: true }).catch(() => {});
      }
    } catch (error) {
      if (swappedNodeModules) {
        await rm(liveNodeModules, { recursive: true, force: true }).catch(() => {});
      }
      if (movedPreviousNodeModules && existsSync(backupNodeModules)) {
        await rename(backupNodeModules, liveNodeModules).catch(() => {});
      }
      await rollbackFiles(changes, error);
    } finally {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }

    return { installDir, exePath, scriptPath: path.join(installDir, 'claude-vps-acp.mjs'), shim: shimResult };
  });
}

async function statusAcp({ acpDir = defaultAcpDir(), shimDir = defaultShimDir(), offline = false } = {}) {
  const installDir = await resolveDirPath(acpDir);
  const exePath = path.join(installDir, ACP_EXE_NAME);
  const agentEntry = path.join(installDir, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js');
  let resolvedShimDir = shimDir;
  const pinnedShim = await readOptional(path.join(installDir, SHIM_PATH_NAME));
  if (pinnedShim) {
    const pinnedText = pinnedShim.toString('utf8').trim();
    if (pinnedText && path.isAbsolute(pinnedText)) resolvedShimDir = path.dirname(pinnedText);
  }
  const shim = await shimStatus({ shimDir: resolvedShimDir, offline });

  const assetMatches = await Promise.all(ACP_SCRIPT_ASSETS.map(async asset => {
    const installed = await readOptional(path.join(installDir, asset.name));
    const source = await readFile(asset.src);
    return [asset.name, installed?.equals(source) ?? false];
  }));

  const binaryPresent = existsSync(exePath);
  const upstreamRuntimePresent = existsSync(agentEntry);
  const selfTest = binaryPresent
    ? await runAcpExeSelfTest(exePath, { pure: !upstreamRuntimePresent })
    : { ok: false, error: 'Binary missing' };

  return {
    acpDir: installDir,
    binaryPath: exePath,
    scriptPath: path.join(installDir, 'claude-vps-acp.mjs'),
    binaryPresent,
    upstreamRuntimePresent,
    shimPathPinned: Boolean(pinnedShim),
    matchesThisPackage: Object.fromEntries(assetMatches),
    selfTest: { ok: selfTest.ok, ...(selfTest.error ? { error: selfTest.error } : {}), ...(selfTest.detail ? { upstreamVersion: selfTest.detail.upstreamVersion } : {}) },
    shim,
  };
}

async function uninstallAcp({ acpDir = defaultAcpDir(), shimDir = defaultShimDir(), removeShim = false, force = false } = {}) {
  const installDir = await resolveDirPath(acpDir);
  let resolvedShimDir = shimDir;
  const pinnedShim = await readOptional(path.join(installDir, SHIM_PATH_NAME));
  if (pinnedShim) {
    const pinnedText = pinnedShim.toString('utf8').trim();
    if (pinnedText && path.isAbsolute(pinnedText)) resolvedShimDir = path.dirname(pinnedText);
  }
  const removed = [];
  if (existsSync(installDir)) {
    await withDirectoryLock(installDir, async () => {
      const files = [ACP_EXE_NAME, NODE_PATH_NAME, SHIM_PATH_NAME, ...ACP_SCRIPT_ASSETS.map(a => a.name)];
      const changes = [];
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
      await rm(path.join(installDir, 'node_modules'), { recursive: true, force: true }).catch(() => {});
      await cleanupRetiredExeFiles(installDir, ACP_EXE_NAME);
    });
  }
  await unregisterShimConsumer(resolvedShimDir, 'acp');
  let removedShim = null;
  if (removeShim) {
    removedShim = await uninstallShim({ shimDir: resolvedShimDir, force, excludeConsumer: 'acp' });
  }
  return { installDir, resolvedShimDir, removed, removedShim };
}

async function main() {
  const { values, positionals: [action = 'help', ...unexpected] } = parseArgs({
    allowPositionals: true,
    options: {
      'acp-dir': { type: 'string' },
      'shim-dir': { type: 'string' },
      offline: { type: 'boolean', default: false },
      'skip-npm': { type: 'boolean', default: false },
      'remove-shim': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help || action === 'help') {
    console.log('用法  node acp/manage-acp.mjs <install|status|uninstall> [--acp-dir <目录>] [--shim-dir <目录>] [--offline] [--remove-shim] [--force]');
    return;
  }
  if (unexpected.length || !['install', 'status', 'uninstall'].includes(action)) {
    throw new Error('参数无效。运行 node acp/manage-acp.mjs --help 查看用法。');
  }
  if (process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) < 24) {
    throw new Error('此工具需要 Windows 和 Node.js 24 或更新版本。');
  }

  const acpDir = values['acp-dir'] ?? defaultAcpDir();
  const shimDir = values['shim-dir'] ?? defaultShimDir();

  if (action === 'install') {
    const result = await installAcp({ acpDir, shimDir, offline: values.offline, skipNpm: values['skip-npm'] });
    console.log(`已安装标准 ACP 协议包装（底层复用中立 Shim：${result.shim.exePath}）。`);
    console.log(`ACP 可执行入口：${result.exePath}`);
    console.log(`ACP 脚本入口：node "${result.scriptPath}"`);
    return;
  }
  if (action === 'status') {
    console.log(JSON.stringify(await statusAcp({ acpDir, shimDir, offline: values.offline }), null, 2));
    return;
  }
  const result = await uninstallAcp({ acpDir, shimDir, removeShim: values['remove-shim'], force: values.force });
  console.log(`已移除标准 ACP 协议包装（${result.removed.length} 项）：${result.installDir}`);
  if (!values['remove-shim']) {
    console.log(`共享中立 Shim 已保留：${path.resolve(result.resolvedShimDir)}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
