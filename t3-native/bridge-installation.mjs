import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export async function inspectBridge() {
  const root = process.env.CLAUDE_VPS_PLUGIN_DIR
    ? path.resolve(process.env.CLAUDE_VPS_PLUGIN_DIR)
    : path.join(homedir(), '.codexhost', 'plugins', 'claude-vps');
  const manifestPath = path.join(root, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse((await readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`T3 Claude VPS 核心桥接尚未安装。请先运行仓库根目录的 install.ps1 完成本机与 VPS 部署。预期目录：${root}`);
    }
    throw error;
  }
  if (manifest.id !== 'claude-vps' || manifest.adapterApiVersion !== 1 || manifest.entry !== 'plugin.mjs') {
    throw new Error('T3 原生 Shim 需要底层桥接的 Harness Adapter API 1 与 plugin.mjs 入口。');
  }
  const entry = path.join(root, manifest.entry);
  await access(entry);
  return { root, entry, version: manifest.version, apiVersion: manifest.adapterApiVersion };
}
