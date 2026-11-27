import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  NODE_PATH_NAME,
  SCRIPT_ASSETS,
  SHIM_NAME,
  VERSION_CACHE_NAME,
  cleanupRetiredExeFiles,
  defaultShimDir,
  installShim,
  normalizePath,
  readOptional,
  registerShimConsumer,
  shimStatus,
  uninstallShim,
  unregisterShimConsumer,
  withDirectoryLock,
  writeAtomic,
} from '../shim/manage-shim.mjs';

const INSTANCE_ID = 'claude-vps';
const DISPLAY_NAME = 'Claude VPS';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function usesAnyShim(provider, exePaths) {
  if (typeof provider?.config?.binaryPath !== 'string' || !path.isAbsolute(provider.config.binaryPath)) return false;
  const target = normalizePath(provider.config.binaryPath);
  return exePaths.some(candidate => normalizePath(candidate) === target);
}

function ownsProvider(provider, exePaths) {
  return provider?.driver === 'claudeAgent' && usesAnyShim(provider, exePaths);
}

function checkProviderOwnership(providers, exePaths) {
  const provider = providers[INSTANCE_ID];
  if (Object.hasOwn(providers, INSTANCE_ID) && !ownsProvider(provider, exePaths)) {
    throw new Error(`T3 Provider ID ${INSTANCE_ID} 已被其他配置使用。`);
  }
  for (const [id, entry] of Object.entries(providers)) {
    if (id !== INSTANCE_ID && usesAnyShim(entry, exePaths)) {
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

async function cleanupLegacyShimFiles(legacyDir, neutralDir) {
  if (normalizePath(legacyDir) === normalizePath(neutralDir)) return [];
  if (!existsSync(legacyDir)) return [];
  // Copy version cache into neutral shim dir if neutral dir has none yet.
  const legacyCache = path.join(legacyDir, VERSION_CACHE_NAME);
  const neutralCache = path.join(neutralDir, VERSION_CACHE_NAME);
  const legacyCacheBytes = await readOptional(legacyCache);
  if (legacyCacheBytes && !existsSync(neutralCache)) {
    await writeFile(neutralCache, legacyCacheBytes).catch(() => {});
  }
  const retired = [];
  const legacyExe = path.join(legacyDir, SHIM_NAME);
  if (existsSync(legacyExe)) {
    try {
      await rm(legacyExe);
      retired.push(SHIM_NAME);
    } catch {
      // Legacy executable is still in use by an active process; keep its sibling scripts intact until restart.
      return retired;
    }
  }
  const legacyFiles = [NODE_PATH_NAME, ...SCRIPT_ASSETS.map(a => a.name), VERSION_CACHE_NAME];
  for (const name of legacyFiles) {
    const file = path.join(legacyDir, name);
    if (!existsSync(file)) continue;
    try {
      await rm(file, { force: true });
      retired.push(name);
    } catch {
      // Best-effort cleanup of non-locked legacy files; claude-home is never touched.
    }
  }
  await cleanupRetiredExeFiles(legacyDir, SHIM_NAME);
  return retired;
}

async function install(t3Home, { shimDir = defaultShimDir(), offline = false } = {}) {
  const legacyDir = path.join(t3Home, 'integrations', 'claude-vps-native');
  const legacyExePath = path.join(legacyDir, SHIM_NAME);
  const defaultHomeDir = path.join(legacyDir, 'claude-home');

  // 1. Validate T3 settings ownership BEFORE installing or modifying anything.
  const settings = await readSettings(t3Home);
  settings.data.providerInstances ??= {};
  const providers = settings.data.providerInstances;
  const targetExePath = path.join(path.resolve(shimDir), SHIM_NAME);
  const allowedExePaths = [targetExePath, legacyExePath];
  const prior = checkProviderOwnership(providers, allowedExePaths);

  // 2. Install/upgrade shared neutral Shim into %USERPROFILE%\.claude-vps\shim\.
  const shimResult = await installShim({ shimDir, offline });
  const exePath = shimResult.exePath;
  const homeDir = prior?.config?.homePath ?? defaultHomeDir;
  await mkdir(homeDir, { recursive: true });

  // 3. Atomically update T3 settings.json pointing to the neutral Shim, preserving user customizations.
  const migratedFromLegacy = Boolean(prior && normalizePath(prior.config?.binaryPath ?? '') === normalizePath(legacyExePath)
    && normalizePath(exePath) !== normalizePath(legacyExePath));
  const updated = {
    ...prior,
    driver: 'claudeAgent',
    displayName: prior?.displayName ?? DISPLAY_NAME,
    enabled: prior?.enabled ?? true,
    config: {
      ...prior?.config,
      enabled: prior?.config?.enabled ?? true,
      binaryPath: exePath,
      homePath: homeDir,
    },
  };
  if (JSON.stringify(updated) !== JSON.stringify(prior)) {
    providers[INSTANCE_ID] = updated;
    await saveSettings(settings);
  } else {
    await assertSettingsUnchanged(settings);
  }

  await registerShimConsumer(shimResult.installDir, 't3-native', {
    t3Home,
    checkPath: settings.file,
  });

  // 4. Best-effort cleanup of retired legacy Shim binaries in .t3/integrations/claude-vps-native (never touches claude-home).
  const retiredLegacy = await cleanupLegacyShimFiles(legacyDir, shimResult.installDir);

  console.log(`已注册独立原生 Claude 实例 "${DISPLAY_NAME}" (${INSTANCE_ID})，底层复用 Bridge ${shimResult.bridge.version}。`);
  console.log(`中立 Shim 可执行文件：${exePath}`);
  console.log(`独立配置目录：${homeDir}`);
  if (migratedFromLegacy) {
    console.log(`已平滑迁移旧安装（保留 claude-home，清理旧 Shim 文件 ${retiredLegacy.length} 项）。`);
  }
  if (offline) {
    console.log('远端实时版本探测：已跳过（--offline 模式，离线安装布局自检通过）');
  } else {
    console.log(`远端实时版本探测：${shimResult.liveVersionOut}`);
  }
  console.log('未修改默认 claudeAgent 实例与本机 ~/.claude。');
}

async function status(t3Home, { shimDir = defaultShimDir(), offline = false } = {}) {
  const legacyDir = path.join(t3Home, 'integrations', 'claude-vps-native');
  const legacyExePath = path.join(legacyDir, SHIM_NAME);
  const shim = await shimStatus({ shimDir, offline });
  const allowedExePaths = [shim.binaryPath, legacyExePath];

  const settings = await readSettings(t3Home);
  const entry = settings.data.providerInstances?.[INSTANCE_ID];
  const owns = ownsProvider(entry, allowedExePaths);
  const configuredBinary = entry?.config?.binaryPath ?? null;
  const usesLegacyLocation = Boolean(
    owns
    && typeof configuredBinary === 'string'
    && normalizePath(configuredBinary) === normalizePath(legacyExePath)
    && normalizePath(shim.binaryPath) !== normalizePath(legacyExePath),
  );

  console.log(JSON.stringify({
    t3Home,
    instanceId: INSTANCE_ID,
    provider: !entry ? 'absent' : !owns ? 'id-in-use'
      : (entry.enabled === false || entry.config?.enabled === false ? 'disabled' : 'enabled'),
    registered: Boolean(entry && owns),
    driver: entry?.driver ?? null,
    enabled: Boolean(entry && owns && entry.enabled !== false && entry.config?.enabled !== false),
    binaryPath: configuredBinary ?? shim.binaryPath,
    neutralShimPath: shim.binaryPath,
    usesLegacyLocation,
    binaryPresent: shim.binaryPresent,
    matchesThisPackage: shim.matchesThisPackage,
    offlineSelfTest: shim.offlineSelfTest,
    cachedVersion: shim.cachedVersion,
    liveCheck: shim.liveCheck,
    bridge: shim.bridge,
  }, null, 2));
}

async function uninstall(t3Home, { shimDir = defaultShimDir(), removeShim = false, force = false } = {}) {
  const legacyDir = path.join(t3Home, 'integrations', 'claude-vps-native');
  const legacyExePath = path.join(legacyDir, SHIM_NAME);
  const targetExePath = path.join(path.resolve(shimDir), SHIM_NAME);
  const allowedExePaths = [targetExePath, legacyExePath];

  const settings = await readSettings(t3Home);
  const providers = settings.data.providerInstances ?? {};
  if (!checkProviderOwnership(providers, allowedExePaths)) {
    console.log(`T3 实例 "${INSTANCE_ID}" 未注册。`);
    return;
  }

  delete providers[INSTANCE_ID];
  await saveSettings(settings);
  await cleanupLegacyShimFiles(legacyDir, path.resolve(shimDir));
  await unregisterShimConsumer(shimDir, 't3-native');

  if (removeShim) {
    const removed = await uninstallShim({ shimDir, force, excludeConsumer: 't3-native' });
    console.log(`已移除独立原生 Claude 实例 "${INSTANCE_ID}" 及中立 Shim（${removed.removed.length} 项，保留 claude-home）。`);
  } else {
    console.log(`已移除独立原生 Claude 实例 "${INSTANCE_ID}"（保留 claude-home 与共享中立 Shim：${path.resolve(shimDir)}）。`);
  }
}

async function main() {
  const { values, positionals: [action = 'help', ...unexpected] } = parseArgs({
    allowPositionals: true,
    options: {
      't3-home': { type: 'string' },
      'shim-dir': { type: 'string' },
      'remove-shim': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      offline: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help || action === 'help') {
    console.log('用法  node t3-native/manage-native.mjs <install|status|uninstall> [--t3-home <目录>] [--shim-dir <目录>] [--remove-shim] [--force] [--offline]');
    return;
  }
  if (unexpected.length || !['install', 'status', 'uninstall'].includes(action)) {
    throw new Error('参数无效。运行 node t3-native/manage-native.mjs --help 查看用法。');
  }
  if (process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) < 24) {
    throw new Error('此安装包需要 Windows 和 Node.js 24 或更新版本。');
  }

  const requestedHome = path.resolve(values['t3-home'] ?? process.env.T3CODE_HOME ?? path.join(os.homedir(), '.t3'));
  const t3Home = await realpath(requestedHome).catch(error => {
    if (error.code === 'ENOENT') return requestedHome;
    throw error;
  });
  const shimDir = values['shim-dir'] ?? defaultShimDir();

  if (action === 'status') {
    await status(t3Home, { shimDir, offline: values.offline });
    return;
  }

  const lockDir = path.join(t3Home, 'integrations', 'claude-vps-native');
  await withDirectoryLock(lockDir, async () => {
    if (action === 'install') await install(t3Home, { shimDir, offline: values.offline });
    else await uninstall(t3Home, { shimDir, removeShim: values['remove-shim'], force: values.force });
  });
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
