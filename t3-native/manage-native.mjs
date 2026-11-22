import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { inspectBridge } from '../t3/bridge-installation.mjs';

const execFileAsync = promisify(execFile);
const nativeDir = path.dirname(fileURLToPath(import.meta.url));
const t3Dir = path.resolve(nativeDir, '..', 't3');
const INSTANCE_ID = 'claude-vps';
const DISPLAY_NAME = 'Claude VPS';

function parseArgs(argv) {
  const action = argv[0];
  let t3Home = process.env.T3CODE_HOME || path.join(os.homedir(), '.t3');
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--t3-home' && argv[i + 1]) {
      t3Home = argv[++i];
    }
  }
  return { action, t3Home: path.resolve(t3Home) };
}

function findCsc() {
  const candidates = [
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error('Windows .NET csc.exe not found; cannot build claude-vps-shim.exe');
}

async function readSettings(settingsPath) {
  try {
    return JSON.parse(await readFile(settingsPath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

async function writeSettings(settingsPath, settings) {
  await mkdir(path.dirname(settingsPath), { recursive: true });
  const tmp = `${settingsPath}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  await rename(tmp, settingsPath);
}

async function install(t3Home) {
  const bridge = await inspectBridge();
  const installDir = path.join(t3Home, 'integrations', 'claude-vps-native');
  const homeDir = path.join(installDir, 'claude-home');
  const exePath = path.join(installDir, 'claude-vps-shim.exe');
  const settingsPath = path.join(t3Home, 'userdata', 'settings.json');

  await mkdir(homeDir, { recursive: true });
  await copyFile(path.join(t3Dir, 'bridge-installation.mjs'), path.join(installDir, 'bridge-installation.mjs'));
  await copyFile(path.join(nativeDir, 'http-mcp-client.mjs'), path.join(installDir, 'http-mcp-client.mjs'));
  await copyFile(path.join(nativeDir, 'claude-vps-shim.mjs'), path.join(installDir, 'claude-vps-shim.mjs'));

  const csc = findCsc();
  const csSource = path.join(nativeDir, 'claude-vps-shim.cs');
  await execFileAsync(csc, ['/nologo', '/optimize+', '/target:exe', `/out:${exePath}`, csSource], { windowsHide: true });

  // Clear stale version cache and run a quick --version self-test
  await rm(path.join(installDir, 'vps-version-cache.json'), { force: true });
  const { stdout: versionOut } = await execFileAsync(exePath, ['--version'], { windowsHide: true, timeout: 20000 });

  const settings = await readSettings(settingsPath);
  settings.providerInstances ??= {};
  settings.providerInstances[INSTANCE_ID] = {
    driver: 'claudeAgent',
    displayName: DISPLAY_NAME,
    enabled: true,
    config: {
      enabled: true,
      binaryPath: exePath,
      homePath: homeDir,
    },
  };
  await writeSettings(settingsPath, settings);

  console.log(`已注册独立原生 Claude 实例 "${DISPLAY_NAME}" (${INSTANCE_ID})，底层复用 Bridge ${bridge.version}。`);
  console.log(`Shim 可执行文件：${exePath}`);
  console.log(`独立配置目录：${homeDir}`);
  console.log(`远端版本探测：${versionOut.trim()}`);
  console.log('未修改默认 claudeAgent 与现有 claude-vps-bridge (ACP) 实例。');
}

async function status(t3Home) {
  const installDir = path.join(t3Home, 'integrations', 'claude-vps-native');
  const exePath = path.join(installDir, 'claude-vps-shim.exe');
  const settingsPath = path.join(t3Home, 'userdata', 'settings.json');
  const settings = await readSettings(settingsPath);
  const entry = settings.providerInstances?.[INSTANCE_ID];
  let version = null;
  if (existsSync(exePath)) {
    try {
      const { stdout } = await execFileAsync(exePath, ['--version'], { windowsHide: true, timeout: 15000 });
      version = stdout.trim();
    } catch (err) {
      version = `ERROR: ${err.message}`;
    }
  }
  console.log(JSON.stringify({
    t3Home,
    instanceId: INSTANCE_ID,
    registered: Boolean(entry),
    driver: entry?.driver ?? null,
    enabled: entry?.enabled ?? false,
    binaryPath: exePath,
    binaryPresent: existsSync(exePath),
    remoteClaudeVersion: version,
  }, null, 2));
}

async function uninstall(t3Home) {
  const installDir = path.join(t3Home, 'integrations', 'claude-vps-native');
  const settingsPath = path.join(t3Home, 'userdata', 'settings.json');
  const settings = await readSettings(settingsPath);
  if (settings.providerInstances && Object.hasOwn(settings.providerInstances, INSTANCE_ID)) {
    delete settings.providerInstances[INSTANCE_ID];
    await writeSettings(settingsPath, settings);
  }
  for (const name of ['claude-vps-shim.exe', 'claude-vps-shim.mjs', 'http-mcp-client.mjs', 'bridge-installation.mjs', 'vps-version-cache.json']) {
    await rm(path.join(installDir, name), { force: true });
  }
  console.log(`已移除独立原生 Claude 实例 "${INSTANCE_ID}"（保留 claude-home，未影响其他 Provider）。`);
}

const { action, t3Home } = parseArgs(process.argv.slice(2));
if (action === 'install') await install(t3Home);
else if (action === 'status') await status(t3Home);
else if (action === 'uninstall') await uninstall(t3Home);
else {
  console.error('Usage: node t3-native/manage-native.mjs <install|status|uninstall> [--t3-home <path>]');
  process.exit(2);
}
