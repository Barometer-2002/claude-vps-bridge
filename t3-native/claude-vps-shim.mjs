import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectBridge } from './bridge-installation.mjs';
import { LocalMcpHub } from './http-mcp-client.mjs';

const shimDir = path.dirname(fileURLToPath(import.meta.url));
const versionCachePath = path.join(shimDir, 'vps-version-cache.json');
const VERSION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const RELAY_START_TIMEOUT_MS = 20000;
const MEDIA_EXT_RE = /\.(?:png|jpe?g|webp|gif|pdf)$/i;

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
  '--project-config-root',
  '--debug-file',
  '--plugin-dir',
  '--setting-sources',
]);

export function parseShimArgs(argv) {
  const forwarded = [];
  const appendPrompts = [];
  const addedDirs = [];
  const mcpServers = {};
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
      if (parsed?.mcpServers && typeof parsed.mcpServers === 'object') {
        Object.assign(mcpServers, parsed.mcpServers);
      }
      continue;
    }
    if (flag === '--add-dir') {
      const val = readValue();
      if (val) addedDirs.push(val);
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
    addedDirs,
    mcpServers,
    t3McpConfig: mcpServers['t3-code'] ?? null,
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
    classifySshFailure: routesMod.classifySshFailure,
    workspace: workspaceMod,
    envMod,
    streams: streamsMod,
  };
}

async function runSshOneShot(config, SshRoutes, classifySshFailure, remoteCmd, timeoutMs = 12000) {
  const routes = new SshRoutes(config);
  return routes.firstAvailable(async r => {
    const sshArgs = r.args(remoteCmd, { connectTimeout: 10 });
    return new Promise((resolve, reject) => {
      const child = spawn('ssh', sshArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(Object.assign(new Error('SSH version probe timed out'), { code: 'HANDSHAKE_TIMEOUT' }));
      }, timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      child.on('error', err => { clearTimeout(timer); reject(err); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0 && stdout.trim()) resolve(stdout.trim());
        else reject(Object.assign(new Error(stderr.trim() || `SSH exited with code ${code}`), { sshFailure: classifySshFailure(stderr) }));
      });
    });
  });
}

async function handleVersionCheck(config, SshRoutes, classifySshFailure) {
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
  const version = await runSshOneShot(config, SshRoutes, classifySshFailure, remoteCmd);
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

function extractUserText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n');
}

function prependUserContext(msg, prefixText) {
  if (!prefixText || !msg?.message) return msg;
  const content = msg.message.content;
  if (typeof content === 'string') {
    return { ...msg, message: { ...msg.message, content: `${prefixText}\n\n${content}` } };
  }
  if (Array.isArray(content)) {
    return {
      ...msg,
      message: {
        ...msg.message,
        content: [{ type: 'text', text: prefixText }, ...content],
      },
    };
  }
  return msg;
}

function findT3AttachmentPaths(text) {
  if (!text) return [];
  const t3Home = path.resolve(process.env.T3CODE_HOME || path.join(os.homedir(), '.t3'));
  const attachRoot = path.join(t3Home, 'userdata', 'attachments');
  const normRoot = attachRoot.toLowerCase();
  const candidates = new Set();
  const re = /[A-Za-z]:[\\/][^\s"'`<>|)\]]+\.(?:png|jpe?g|webp|gif|pdf)/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    const resolved = path.win32.resolve(match[0]);
    if (resolved.toLowerCase().startsWith(normRoot + path.win32.sep) && MEDIA_EXT_RE.test(resolved) && existsSync(resolved)) {
      candidates.add(resolved);
    }
  }
  return [...candidates];
}

async function enrichUserMessage(msg, { info, sessionId, workspace, envMod }) {
  if (!info) return msg;
  const userText = extractUserText(msg.message?.content);
  const contextParts = [];

  // 1. Register verified T3 attachment paths outside project root for windows-workspace media.
  const t3Attachments = findT3AttachmentPaths(userText);
  if (t3Attachments.length > 0) {
    try {
      await workspace.control({
        action: 'attachments',
        cwd: info.cwd,
        projectId: info.projectId,
        sessionId,
        paths: t3Attachments,
      });
    } catch {
      // Best-effort attachment authorization.
    }
  }

  // 2. Run local Windows UserPromptSubmit hooks.
  try {
    const hooks = await workspace.control({
      action: 'lifecycle',
      cwd: info.cwd,
      projectId: info.projectId,
      sessionId,
      event: 'UserPromptSubmit',
      payload: { prompt: userText },
    });
    if (Array.isArray(hooks)) {
      for (const h of hooks) {
        const extra = h?.hookSpecificOutput?.additionalContext ?? h?.additionalContext;
        if (typeof extra === 'string' && extra.trim()) contextParts.push(extra.trim());
      }
    }
  } catch {
    // Non-blocking in native shim unless explicitly needed.
  }

  // 3. Expand local Windows .claude/skills or .claude/commands if explicitly invoked.
  const userReqMatch = userText.match(/<user_request>\s*([\s\S]*?)\s*<\/user_request>/i);
  const capCandidate = (userReqMatch ? userReqMatch[1] : userText).trim();
  const capInvoke = capCandidate.match(/^([/$])([\w:-]+)(?:\s+([\s\S]*))?$/);
  if (capInvoke) {
    const prefix = capInvoke[1];
    const capName = capInvoke[2].toLowerCase();
    const capArgs = capInvoke[3] ?? '';
    try {
      const environment = await envMod.projectEnvironment(info.cwd);
      const item = (environment.capabilities ?? []).find(
        c => (prefix === '$' ? c.kind === 'skill' : ['skill', 'command'].includes(c.kind))
          && typeof c.name === 'string'
          && c.name.toLowerCase() === capName,
      );
      if (item) {
        const loaded = await workspace.control({
          action: 'capability-context',
          cwd: info.cwd,
          projectId: info.projectId,
          sessionId,
          id: item.id,
        });
        if (typeof loaded?.content === 'string') {
          contextParts.push(
            `User explicitly invoked local Windows capability ${item.id} (${item.path ?? ''}):\n${loaded.content.replaceAll('$ARGUMENTS', capArgs)}\n\nFollow the instructions above for this request.${capArgs ? ` Arguments: ${capArgs}` : ''}`,
          );
        }
      }
    } catch {
      // Fall back to sending the original prompt unmodified.
    }
  }

  return contextParts.length > 0 ? prependUserContext(msg, contextParts.join('\n\n')) : msg;
}

async function main() {
  const parsed = parseShimArgs(process.argv.slice(2));
  const { config, SshRoutes, classifySshFailure, workspace, envMod, streams } = await loadBridgeModules();

  if (parsed.isVersionCheck) {
    await handleVersionCheck(config, SshRoutes, classifySshFailure);
    return;
  }

  const cwd = process.cwd();
  const hasRealDir = path.win32.isAbsolute(cwd) && (await stat(cwd).then(s => s.isDirectory(), () => false));
  // Only skip workspace binding when cwd isn't a real Windows directory or --tools "" disables all tools.
  const probeOnly = !hasRealDir || parsed.zeroTools;

  const sessionId = randomUUID();
  let info = null;
  let projectContext = '';
  const localMcpHub = new LocalMcpHub();

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

  if (Object.keys(parsed.mcpServers).length > 0) {
    localMcpHub.registerServers(parsed.mcpServers, config.remoteRoot, info?.cwd ?? cwd);
  }

  const startPayload = {
    type: 'start',
    sessionId,
    localCwd: info?.cwd ?? null,
    projectId: info?.projectId ?? null,
    workspaceInfo: info,
    args: parsed.forwarded,
    appendSystemPrompt: parsed.appendSystemPrompt,
    extraSettings: parsed.extraSettings,
    projectContext,
    t3Mcp: localMcpHub.has('t3-code'),
    localMcpServers: localMcpHub.names(),
    addedDirs: parsed.addedDirs,
    probeOnly,
    zeroTools: parsed.zeroTools,
  };

  let activeSsh = null;
  let activeWriter = null;
  let sshExited = false;
  let remoteExitCode = null;
  const pendingFramesBeforeStart = [];

  const sendToRelay = frame => {
    if (sshExited) return;
    if (!activeWriter) {
      pendingFramesBeforeStart.push(frame);
      return;
    }
    try {
      activeWriter.send(frame);
    } catch {
      // Ignore write to closed SSH pipe.
    }
  };

  async function handleLocalReq(frame) {
    const { controlId, lane, request } = frame;
    try {
      if (request?.action === 'mcp' && localMcpHub.has(request.server)) {
        const value = await localMcpHub.handle(request);
        sendToRelay({ type: 'local_reply', controlId, value });
        return;
      }
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
      } else {
        value = await workspace.control(boundReq);
      }
      sendToRelay({ type: 'local_reply', controlId, value });
    } catch (err) {
      sendToRelay({ type: 'local_reply', controlId, error: err?.message ?? 'Local Windows operation failed' });
    }
  }

  // Start reading T3 SDK stdin immediately (serialized FIFO) so early initialize / mcp_set_servers
  // frames are buffered safely even while multi-route SSH failover runs.
  let stdinChain = Promise.resolve();
  const stdinRl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  stdinRl.on('line', line => {
    stdinChain = stdinChain.then(async () => {
      let outLine = line;
      try {
        let msg = JSON.parse(line);
        if (info && msg?.type === 'user') {
          await workspace.setTurn(sessionId, randomUUID()).catch(() => {});
          msg = await enrichUserMessage(msg, { info, sessionId, workspace, envMod });
          outLine = JSON.stringify(msg);
        } else if (info && msg?.type === 'control_request' && msg.request?.subtype === 'set_permission_mode' && typeof msg.request.mode === 'string') {
          await workspace.control({
            action: 'permission',
            cwd: info.cwd,
            projectId: info.projectId,
            sessionId,
            mode: msg.request.mode,
          }).catch(() => {});
        } else if (msg?.type === 'control_request' && msg.request?.subtype === 'mcp_set_servers' && msg.request.servers && typeof msg.request.servers === 'object') {
          const rewrittenServers = localMcpHub.syncServers(msg.request.servers, config.remoteRoot, info?.cwd ?? cwd);
          outLine = JSON.stringify({
            ...msg,
            request: {
              ...msg.request,
              servers: rewrittenServers,
            },
          });
        }
      } catch {
        // Non-JSON line; forward verbatim.
      }
      sendToRelay({ type: 'claude_in', line: outLine });
    }).catch(() => {});
  });
  stdinRl.on('close', () => {
    stdinChain = stdinChain.then(() => {
      sendToRelay({ type: 'stop' });
    });
  });

  const cleanup = async code => {
    if (sshExited) return;
    sshExited = true;
    await localMcpHub.closeAll().catch(() => {});
    process.exit(code);
  };

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      sendToRelay({ type: 'stop' });
      try { activeSsh?.kill(); } catch {}
    });
  }

  const routes = new SshRoutes(config);
  const remoteNode = config.remoteNodeExecutable || 'node';
  const relayScript = `${config.remoteRoot}/claude-stream-relay.mjs`;
  const remoteCmd = `${shellQuote(remoteNode)} ${shellQuote(relayScript)}`;

  const connected = await routes.firstAvailable(async route => {
    const sshArgs = route.args(remoteCmd, { connectTimeout: 12, keepAlive: true });
    return new Promise((resolve, reject) => {
      const child = spawn('ssh', sshArgs, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const writer = new streams.JsonWriter(child.stdin, { onError: () => {} });
      let started = false;
      let startupStderr = '';

      const timer = setTimeout(() => {
        if (started) return;
        try { child.kill(); } catch {}
        reject(Object.assign(new Error(`SSH route "${route.current.name}" timed out waiting for relay startup`), {
          code: 'HANDSHAKE_TIMEOUT',
          sshFailure: classifySshFailure(startupStderr),
        }));
      }, RELAY_START_TIMEOUT_MS);

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        if (!started) startupStderr = (startupStderr + chunk).slice(-4000);
        else process.stderr.write(chunk);
      });

      const reader = streams.readJsonLines(child.stdout, frame => {
        if (!frame || typeof frame !== 'object') return;
        if (!started && frame.type === 'started') {
          started = true;
          clearTimeout(timer);
          resolve({ child, writer, reader });
          return;
        }
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
          if (!started) {
            clearTimeout(timer);
            try { child.kill(); } catch {}
            reject(err);
          } else {
            process.stderr.write(`Claude VPS shim stream error: ${err?.message ?? err}\n`);
          }
        },
        onEnd: () => {},
      });

      child.on('error', err => {
        if (!started) {
          clearTimeout(timer);
          reject(err);
        } else {
          process.stderr.write(`Failed to start SSH to ${config.sshHost}: ${err.message}\n`);
          void cleanup(1);
        }
      });

      child.on('close', code => {
        if (!started) {
          clearTimeout(timer);
          reject(Object.assign(
            new Error(startupStderr.trim() || `SSH route "${route.current.name}" closed with code ${code}`),
            { sshFailure: classifySshFailure(startupStderr) },
          ));
        } else {
          void cleanup(remoteExitCode !== null ? remoteExitCode : (code ?? 0));
        }
      });

      try {
        writer.send(startPayload);
      } catch (err) {
        clearTimeout(timer);
        try { child.kill(); } catch {}
        reject(err);
      }
    });
  });

  activeSsh = connected.child;
  activeWriter = connected.writer;
  for (const frame of pendingFramesBeforeStart.splice(0)) {
    sendToRelay(frame);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  void main().catch(err => {
    process.stderr.write(`${err?.message ?? err}\n`);
    process.exit(1);
  });
}
