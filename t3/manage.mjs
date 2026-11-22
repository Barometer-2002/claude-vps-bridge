import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { inspectBridge } from './bridge-installation.mjs';

const providerId = 'claude-vps-bridge';
const assets = ['bridge-installation.mjs', 'mcp-policy.mjs', 'acp-helpers.mjs', 'claude-vps-acp.mjs'];
const assetSources = new Map(assets.map(name => [name, new URL(name, import.meta.url)]));
assetSources.set('http-mcp-client.mjs', new URL('../t3-native/http-mcp-client.mjs', import.meta.url));
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const normalizePath = value => path.normalize(value).toLowerCase();

async function readOptional(file) {
  try {
    return await readFile(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeAtomic(file, payload, expected) {
  const staging = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(staging, payload, { flag: 'wx' });
    const current = await readOptional(file);
    const matches = expected === null ? current === null : current?.equals(expected);
    if (!matches) throw new Error(`文件已被另一进程修改，请重试。${file}`);
    await rename(staging, file);
  } finally {
    await rm(staging, { force: true });
  }
}

function ownsProvider(provider, adapter) {
  const args = provider?.config?.commandArgs;
  return provider?.driver === 'acpRegistry' && provider?.config?.source === 'local' &&
    Array.isArray(args) && args.length === 1 && typeof args[0] === 'string' &&
    path.isAbsolute(args[0]) && normalizePath(args[0]) === normalizePath(adapter);
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
  return { file, original, data };
}

async function saveSettings({ file, original, data }) {
  const source = original.toString('utf8');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  await writeAtomic(file, bom + JSON.stringify(data, null, 2).replaceAll('\n', newline) + newline, original);
}

async function status(home, adapter) {
  const settings = await readSettings(home);
  const provider = settings.data.providerInstances?.[providerId];
  const owns = ownsProvider(provider, adapter);
  let bridge;
  try {
    const installed = await inspectBridge();
    bridge = { version: installed.version, apiVersion: installed.apiVersion };
  } catch (error) {
    bridge = { error: error.message };
  }
  const bridgeFiles = await Promise.all([...assetSources].map(async ([name, sourceUrl]) => {
    const installed = await readOptional(path.join(path.dirname(adapter), name));
    const source = await readFile(sourceUrl);
    return [name, installed?.equals(source) ?? false];
  }));
  const executable = owns && typeof provider.config.commandPath === 'string'
    ? await access(provider.config.commandPath).then(() => true, () => false) : false;
  console.log(JSON.stringify({
    t3Home: home,
    provider: !provider ? 'absent' : !owns ? 'id-in-use' :
      provider.enabled === false || provider.config.enabled === false ? 'disabled' : 'enabled',
    adapterFile: adapter,
    adapterPresent: (await readOptional(adapter)) !== null,
    nodeExecutablePresent: executable,
    matchesThisPackage: Object.fromEntries(bridgeFiles),
    bridge,
  }, null, 2));
}

async function install(home, directory, adapter) {
  const bridge = await inspectBridge();
  const settings = await readSettings(home);
  settings.data.providerInstances ??= {};
  const providers = settings.data.providerInstances;
  const prior = providers[providerId];
  if (Object.hasOwn(providers, providerId) && !ownsProvider(prior, adapter)) {
    throw new Error(`T3 Provider ID ${providerId} 已被其他配置使用。`);
  }

  const changes = [];
  try {
    for (const [asset, sourceUrl] of assetSources) {
      const file = path.join(directory, asset);
      const before = await readOptional(file);
      const after = await readFile(sourceUrl);
      if (before?.equals(after)) continue;
      if (before && !prior) throw new Error(`安装目录已有同名文件，请先核对其来源。${file}`);
      await writeAtomic(file, after, before);
      changes.push({ file, before, after });
    }

    const updated = {
      ...prior,
      driver: 'acpRegistry',
      displayName: prior?.displayName ?? 'Claude VPS Bridge',
      enabled: true,
      config: {
        ...prior?.config,
        source: 'local',
        enabled: true,
        commandPath: process.execPath,
        commandArgs: [adapter],
      },
    };
    if (JSON.stringify(updated) !== JSON.stringify(prior)) {
      providers[providerId] = updated;
      await saveSettings(settings);
    } else if (!(await readFile(settings.file)).equals(settings.original)) {
      throw new Error('T3 设置在安装期间发生变化，请重试。');
    }
  } catch (error) {
    const failures = [];
    for (const { file, before, after } of changes.reverse()) {
      try {
        if (before) await writeAtomic(file, before, after);
        else if ((await readOptional(file))?.equals(after)) await rm(file);
      } catch (rollbackError) {
        failures.push(rollbackError.message);
      }
    }
    if (failures.length) throw new Error(`${error.message}\n文件恢复未完成\n${failures.join('\n')}`);
    throw error;
  }
  console.log(`已注册 Claude VPS Bridge，使用现有 Bridge ${bridge.version}。`);
  console.log(`适配器位于 ${adapter}`);
}

async function uninstall(home, directory, adapter) {
  const settings = await readSettings(home);
  const providers = settings.data.providerInstances;
  const registered = providers?.[providerId];
  if (Object.hasOwn(providers ?? {}, providerId) && !ownsProvider(registered, adapter)) {
    throw new Error(`T3 Provider ID ${providerId} 已被其他配置使用。`);
  }
  if (registered) {
    delete providers[providerId];
    await saveSettings(settings);
  }
  for (const [name, sourceUrl] of assetSources) {
    const file = path.join(directory, name);
    const installed = await readOptional(file);
    if (!installed) continue;
    if (registered || installed.equals(await readFile(sourceUrl))) await rm(file);
  }
  console.log('Claude VPS Bridge 已从 T3 取消注册。会话映射与现有远端会话仍可用于重新安装后续聊。');
}

async function main() {
  const { values, positionals: [action = 'help', ...unexpected] } = parseArgs({
    allowPositionals: true,
    options: { 't3-home': { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help || action === 'help') {
    console.log('用法  node manage.mjs <install|status|uninstall> [--t3-home <目录>]');
    return;
  }
  if (unexpected.length || !['install', 'status', 'uninstall'].includes(action)) throw new Error('参数无效。运行 node manage.mjs --help 查看用法。');
  if (process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) < 24) {
    throw new Error('此安装包需要 Windows 和 Node.js 24 或更新版本。');
  }
  const home = path.resolve(values['t3-home'] ?? process.env.T3CODE_HOME ?? path.join(homedir(), '.t3'));
  const directory = path.join(home, 'integrations', 'claude-vps');
  const adapter = path.join(directory, 'claude-vps-acp.mjs');
  if (action === 'status') return status(home, adapter);

  await mkdir(directory, { recursive: true });
  const lock = path.join(directory, '.manage.lock');
  try {
    await writeFile(lock, String(process.pid), { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`安装目录有正在使用的管理锁。${lock}`);
    throw error;
  }
  try {
    await (action === 'install' ? install : uninstall)(home, directory, adapter);
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
