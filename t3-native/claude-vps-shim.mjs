import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectBridge } from './bridge-installation.mjs';
import { LocalHttpMcpClient } from './http-mcp-client.mjs';

const shimDir = path.dirname(fileURLToPath(import.meta.url));
const versionCachePath = path.join(shimDir, 'vps-version-cache.json');
const VERSION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function parseJsonOrFile(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  try {
    if (existsSync(trimmed)) {
      const parsed = JSON.parse(readFileSync(trimmed, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    }
  } catch {
    return null;
  }
  return null;
}

const STRIP_VALUE_FLAGS = new Set([
  '--add-dir',
  '--project-config-root',
  '--debug-file',
  '--plugin-dir',
  '--setting-sources',
]);

export function parseShimArgs(argv) {
  const forwarded = [];
  const appendPrompts = [];
  let t3McpConfig = null;
  let extraSettings = null;
  let initialPermissionMode = 'default';
  let hasPermissionPromptTool = false;
  let hasAllowDangerouslySkip = false;
  let zeroTools = false;
  let isVersionCheck = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--version' || arg === '-v' || arg === '-V') {
      isVersionCheck = true;
      continue;
    }

    const eqIdx = arg.indexOf('=');
    const flag = eqIdx > 0 && arg.startsWith('--') ? arg.slice(0, eqIdx) : arg;
    const inlineVal = eqIdx > 0 && arg.startsWith('--') ? arg.slice(eqIdx + 1) : null;
    const readValue = () => {
      if (inlineVal !== null) return inlineVal;
      if (i + 1 < argv.length) return argv[++i];
      return '';
    };

    if (flag === '--strict-mcp-config') {
      continue;
    }
    if (flag === '--mcp-config') {
      const val = readValue();
      const parsed = parseJsonOrFile(val);
      const t3Entry = parsed?.mcpServers?.['t3-code'];
      if (t3Entry && typeof t3Entry === 'object' && typeof t3Entry.url === 'string') {
        t3McpConfig = t3Entry;
      }
      continue;
    }
    if (flag === '--append-system-prompt') {
      const val = readValue();
      if (val) appendPrompts.push(val);
      continue;
    }
    if (flag === '--settings') {
      const val = readValue();
      const parsed = parseJsonOrFile(val);
      if (parsed) extraSettings = { ...(extraSettings ?? {}), ...parsed };
      continue;
    }
    if (flag === '--tools') {
      const val = readValue();
      if (val.trim() === '') zeroTools = true;
      continue;
    }
    if (STRIP_VALUE_FLAGS.has(flag)) {
      readValue();
      continue;
    }
    if (flag === '--permission-mode') {
      const val = readValue();
      if (val) initialPermissionMode = val;
      forwarded.push('--permission-mode', val);
      continue;
    }
    if (flag === '--permission-prompt-tool') {
      const val = readValue();
      hasPermissionPromptTool = true;
      forwarded.push('--permission-prompt-tool', val);
      continue;
    }
    if (flag === '--allow-dangerously-skip-permissions') {
      hasAllowDangerouslySkip = true;
      forwarded.push(arg);
      continue;
    }

    forwarded.push(arg);
  }

  return {
    isVersionCheck,
    forwarded,
    appendSystemPrompt: appendPrompts.join('\n\n'),
    t3McpConfig,
    extraSettings,
    initialPermissionMode,
    hasPermissionPromptTool,
    hasAllowDangerouslySkip,
    zeroTools,
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function loadBridgeModules() {
  const info = await inspectBridge();
  const rt = name => pathToFileURL(path.join(info.root, 'runtime', name)).href;
  const top = name => pathToFileURL(path.join(info.root, name)).href;
  const [configMod, routesMod, workspaceMod, envMod, streamsMod] = await Promise.all([
    import(rt('bridge-config.mjs')),
    import(rt('ssh-routes.mjs')),
    import(rt('workspace-runtime.mjs')),
    import(rt('project-environment.mjs')),
    import(top('transport-streams.mjs')),
  ]);
  return {
    info,
    config: configMod.getBridgeConfig(),
    SshRoutes: routesMod.SshRoutes,
    workspace: workspaceMod,
    envMod,
    streams: streamsMod,
  };
}

async function runSshOneShot(config, SshRoutes, remoteCmd, timeoutMs = 12000) {
  const routes = new SshRoutes(config);
  return routes.firstAvailable(async r => {
    const sshArgs = r.args(remoteCmd, { connectTimeout: 10 });
    return new Promise((resolve, reject) => {
      const child = spawn('ssh', sshArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('SSH version probe timed out'));
      }, timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      child.on('error', err => { clearTimeout(timer); reject(err); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0 && stdout.trim()) resolve(stdout.trim());
        else reject(new Error(stderr.trim() || `SSH exited with code ${code}`));
      });
    });
  });
}

async function handleVersionCheck(config, SshRoutes) {
  try {
    const cached = JSON.parse(await readFile(versionCachePath, 'utf8'));
    if (
      cached
      && cached.sshHost === config.sshHost
      && typeof cached.version === 'string'
      && cached.version.trim()
      && typeof cached.cachedAt === 'number'
      && Date.now() - cached.cachedAt < VERSION_CACHE_TTL_MS
    ) {
      process.stdout.write(`${cached.version.trim()}\n`);
      return;
    }
  } catch {
    // Cache miss; fetch live from VPS.
  }

  const remoteCmd = `bash -lc ${shellQuote(`"$(cat ${shellQuote(`${config.remoteRoot}/claude-path`)})" --version`)}`;
  const version = await runSshOneShot(config, SshRoutes, remoteCmd);
  try {
    await writeFile(versionCachePath, JSON.stringify({
      sshHost: config.sshHost,
      version: version.trim(),
      cachedAt: Date.now(),
    }, null, 2));
  } catch {
    // Cache write is best-effort.
  }
  process.stdout.write(`${version.trim()}\n`);
}

async function main() {
  const parsed = parseShimArgs(process.argv.slice(2));
  const { config, SshRoutes, workspace, envMod, streams } = await loadBridgeModules();

  if (parsed.isVersionCheck) {
    await handleVersionCheck(config, SshRoutes);
    return;
  }

  const cwd = process.cwd();
  const hasRealDir = path.win32.isAbsolute(cwd) && (await stat(cwd).then(s => s.isDirectory(), () => false));
  const isInteractiveSession = Boolean(
    parsed.t3McpConfig || parsed.hasPermissionPromptTool || parsed.hasAllowDangerouslySkip,
  );
  const probeOnly = !hasRealDir || parsed.zeroTools || !isInteractiveSession;

  const sessionId = randomUUID();
  let info = null;
  let projectContext = '';
  const localHttpMcp = new LocalHttpMcpClient(parsed.t3McpConfig);

  if (!probeOnly) {
    info = await workspace.projectInfo(cwd);
    await workspace.bindSession(sessionId, info, process.env.T3CODE_THREAD_ID ?? process.env.CODEX_THREAD_ID);
    await workspace.control({
      action: 'permission',
      cwd: info.cwd,
      projectId: info.projectId,
      sessionId,
      mode: parsed.initialPermissionMode,
    });
    try {
      const environment = await envMod.projectEnvironment(info.cwd);
      projectContext = await envMod.environmentContext(environment);
    } catch {
      projectContext = '';
    }
  }

  const routes = new SshRoutes(config);
  const remoteNode = config.remoteNodeExecutable || 'node';
  const relayScript = `${config.remoteRoot}/claude-stream-relay.mjs`;
  const remoteCmd = `${shellQuote(remoteNode)} ${shellQuote(relayScript)}`;
  const sshArgs = routes.args(remoteCmd, { connectTimeout: 12, keepAlive: true });

  const sshChild = spawn('ssh', sshArgs, {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let sshExited = false;
  let remoteExitCode = null;
  const writer = new streams.JsonWriter(sshChild.stdin, { onError: () => {} });
  const sendToRelay = frame => {
    if (sshExited) return;
    try {
      writer.send(frame);
    } catch {
      // Ignore write to closed SSH pipe.
    }
  };

  sshChild.stderr.setEncoding('utf8');
  sshChild.stderr.on('data', chunk => {
    process.stderr.write(chunk);
  });

  // Forward T3 Code SDK stdin -> VPS Claude stdin, tracking turns, live permission mode,
  // and intercepting dynamic mcp_set_servers so T3's localhost HTTP endpoint & Bearer token stay on Windows.
  const stdinRl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  stdinRl.on('line', line => {
    let outLine = line;
    try {
      const msg = JSON.parse(line);
      if (info && msg?.type === 'user') {
        void workspace.setTurn(sessionId, randomUUID()).catch(() => {});
      } else if (info && msg?.type === 'control_request' && msg.request?.subtype === 'set_permission_mode' && typeof msg.request.mode === 'string') {
        void workspace.control({
          action: 'permission',
          cwd: info.cwd,
          projectId: info.projectId,
          sessionId,
          mode: msg.request.mode,
        }).catch(() => {});
      } else if (msg?.type === 'control_request' && msg.request?.subtype === 'mcp_set_servers' && msg.request.servers && typeof msg.request.servers === 'object') {
        const t3Entry = msg.request.servers['t3-code'];
        if (t3Entry && typeof t3Entry === 'object' && typeof t3Entry.url === 'string') {
          localHttpMcp.configure(t3Entry);
          const rewrittenServers = {
            ...msg.request.servers,
            't3-code': {
              type: 'stdio',
              command: 'python3',
              args: [`${config.remoteRoot}/mcp-local.py`, '--server', 't3-code'],
            },
          };
          outLine = JSON.stringify({
            ...msg,
            request: {
              ...msg.request,
              servers: rewrittenServers,
            },
          });
        }
      }
    } catch {
      // Non-JSON line; forward verbatim.
    }
    sendToRelay({ type: 'claude_in', line: outLine });
  });
  stdinRl.on('close', () => {
    sendToRelay({ type: 'stop' });
  });

  async function handleLocalReq(frame) {
    const { controlId, lane, request } = frame;
    try {
      if (!info) throw new Error('Local workspace is not bound for probe-only session');
      const boundReq = {
        ...request,
        cwd: info.cwd,
        projectId: info.projectId,
        sessionId,
        bridgeRequestId: controlId,
      };
      let value;
      if (lane === 'tool' && request?.action !== 'media-export') {
        value = await workspace.handle(boundReq);
      } else if (request?.action === 'mcp' && request?.server === 't3-code') {
        if (!localHttpMcp.enabled) throw new Error('T3 Code MCP is not enabled for this session');
        value = await localHttpMcp.handle(boundReq);
      } else {
        value = await workspace.control(boundReq);
      }
      sendToRelay({ type: 'local_reply', controlId, value });
    } catch (err) {
      sendToRelay({ type: 'local_reply', controlId, error: err?.message ?? 'Local Windows operation failed' });
    }
  }

  streams.readJsonLines(sshChild.stdout, frame => {
    if (!frame || typeof frame !== 'object') return;
    if (frame.type === 'claude_out' && typeof frame.line === 'string') {
      process.stdout.write(`${frame.line}\n`);
    } else if (frame.type === 'claude_err' && typeof frame.text === 'string') {
      process.stderr.write(frame.text);
    } else if (frame.type === 'local_req') {
      void handleLocalReq(frame);
    } else if (frame.type === 'exit') {
      remoteExitCode = typeof frame.code === 'number' ? frame.code : 0;
    }
  }, {
    onError: err => {
      process.stderr.write(`Claude VPS shim stream error: ${err?.message ?? err}\n`);
    },
    onEnd: () => {},
  });

  // Start remote Claude session!
  sendToRelay({
    type: 'start',
    sessionId,
    localCwd: info?.cwd ?? null,
    projectId: info?.projectId ?? null,
    workspaceInfo: info,
    args: parsed.forwarded,
    appendSystemPrompt: parsed.appendSystemPrompt,
    extraSettings: parsed.extraSettings,
    projectContext,
    t3Mcp: localHttpMcp.enabled,
    probeOnly,
    zeroTools: parsed.zeroTools,
  });

  const cleanup = async code => {
    sshExited = true;
    await localHttpMcp.closeAll().catch(() => {});
    process.exit(code);
  };

  sshChild.on('error', err => {
    process.stderr.write(`Failed to start SSH to ${config.sshHost}: ${err.message}\n`);
    void cleanup(1);
  });

  sshChild.on('close', code => {
    void cleanup(remoteExitCode !== null ? remoteExitCode : (code ?? 0));
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      sendToRelay({ type: 'stop' });
      try { sshChild.kill(); } catch {}
    });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  void main().catch(err => {
    process.stderr.write(`${err?.message ?? err}\n`);
    process.exit(1);
  });
}
