import { readFile, writeFile, mkdir, unlink, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { JsonWriter, readJsonLines } from './transport-streams.mjs';
import { prepareWorkspace } from './workspace-map.mjs';
import { createToolBridge } from './tool-bridge.mjs';
import { bridgeRoot, workspaceRoot, agentCommand } from './remote-config.mjs';

const DEFAULT_TOOLS = 'Bash,Read,AskUserQuestion,WebSearch,WebFetch,TodoWrite,TaskCreate,TaskUpdate,TaskList,TaskGet,ExitPlanMode,EnterPlanMode,ToolSearch';
const SERVER_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

let closing = false;
const writer = new JsonWriter(process.stdout, { onError: () => void shutdown(2) });
const send = frame => {
  if (closing) return;
  try {
    writer.send(frame);
  } catch {
    void shutdown(2);
  }
};

const pendingLocal = new Map();
let toolBridge = null;
let child = null;
let childReady = false;
let bridgeSystemPrompt = '';
let allowedMcpFile = null;
let allowedMcpServers = [];
let pendingMcpUpdate = null;
const queuedStdinLines = [];

async function writeAllowedMcpFile(servers) {
  if (!allowedMcpFile) return;
  const tmp = `${allowedMcpFile}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify({ servers }), { mode: 0o600 });
    await rename(tmp, allowedMcpFile);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

function extractProxiedServersFromControl(msg) {
  if (msg?.type !== 'control_request' || msg.request?.subtype !== 'mcp_set_servers') return null;
  const servers = msg.request?.servers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('Invalid MCP server map');
  const names = [];
  for (const [name, cfg] of Object.entries(servers)) {
    if (!SERVER_NAME_RE.test(name) || !cfg || cfg.type !== 'stdio' || cfg.command !== 'python3'
        || Object.keys(cfg).length !== 3 || !Array.isArray(cfg.args)
        || cfg.args.length !== 3 || cfg.args[0] !== path.join(bridgeRoot, 'mcp-local.py')
        || cfg.args[1] !== '--server' || cfg.args[2] !== name) throw new Error('Invalid MCP proxy stub');
    names.push(name);
  }
  return names;
}

async function prepareOutgoingStdinLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return line;
  }
  try {
    const dynamicServers = extractProxiedServersFromControl(msg);
    if (dynamicServers !== null) {
      if (pendingMcpUpdate) throw new Error('An MCP update is already in progress');
      await writeAllowedMcpFile(dynamicServers);
      pendingMcpUpdate = { id: msg.request_id, previous: allowedMcpServers };
      allowedMcpServers = dynamicServers;
    }
    if (bridgeSystemPrompt && msg?.type === 'control_request' && msg.request?.subtype === 'initialize') {
      const existing = msg.request.appendSystemPrompt;
      let merged;
      if (Array.isArray(existing)) {
        merged = [bridgeSystemPrompt, ...existing];
      } else if (typeof existing === 'string' && existing.trim()) {
        merged = `${bridgeSystemPrompt}\n\n${existing}`;
      } else {
        merged = bridgeSystemPrompt;
      }
      return JSON.stringify({
        ...msg,
        request: {
          ...msg.request,
          appendSystemPrompt: merged,
        },
      });
    }
  } catch (error) {
    send({ type: 'claude_out', line: JSON.stringify({
      type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: error.message },
    }) });
    return null;
  }
  return line;
}

function duplexLocal(request, lane = 'control') {
  const controlId = randomUUID();
  const timeoutMs = request?.action === 'mcp' && request?.server !== 'playwright' ? 305000 : 115000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingLocal.delete(controlId);
      reject(new Error('Windows local bridge request timed out'));
    }, timeoutMs);
    pendingLocal.set(controlId, { resolve, reject, timer });
    send({ type: 'local_req', controlId, lane, request });
  });
}

async function readJsonSafe(filePath, fallback = {}) {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function startClaude(params) {
  const {
    sessionId,
    localCwd,
    projectId,
    workspaceInfo = null,
    args = [],
    appendSystemPrompt = '',
    extraSettings = null,
    projectContext = '',
    t3Mcp = false,
    localMcpServers = [],
    addedDirs = [],
    probeOnly = false,
    zeroTools = false,
  } = params;

  const claudeCommand = (await readFile(path.join(bridgeRoot, 'claude-path'), 'utf8')).trim();
  let spawnCwd = workspaceRoot;
  let spawnEnv = { ...process.env };
  const finalArgs = [];

  if (probeOnly || !localCwd || !projectId || !workspaceInfo) {
    if (appendSystemPrompt) {
      finalArgs.push('--append-system-prompt', appendSystemPrompt);
    }
    if (zeroTools) {
      finalArgs.push('--tools', '');
    }
    finalArgs.push(...args);
  } else {
    const prepared = await prepareWorkspace(workspaceInfo, workspaceRoot);
    spawnCwd = prepared.directory;

    toolBridge = await createToolBridge(async (_binding, request, internal) => {
      return duplexLocal(request, internal ? 'control' : 'tool');
    });
    const binding = { sessionId, localCwd, projectId, remoteCwd: spawnCwd };
    const toolEnv = toolBridge.register(binding);

    const runDir = path.join(bridgeRoot, 'run');
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    allowedMcpFile = path.join(runDir, `mcp-allow-${randomUUID()}.json`);
    const initialServers = new Set(
      (Array.isArray(localMcpServers) ? localMcpServers : []).filter(n => typeof n === 'string' && SERVER_NAME_RE.test(n)),
    );
    if (t3Mcp) initialServers.add('t3-code');
    allowedMcpServers = [...initialServers];
    await writeAllowedMcpFile(allowedMcpServers);

    const bridgeInstructions = await readFile(path.join(bridgeRoot, 'bridge-instructions.md'), 'utf8');
    const baseBridgeParts = [bridgeInstructions.trim()];
    if (typeof projectContext === 'string' && projectContext.trim()) {
      baseBridgeParts.push(projectContext.trim());
    }
    if (Array.isArray(addedDirs) && addedDirs.length > 0) {
      baseBridgeParts.push(
        `Additional directories requested by host (--add-dir): ${addedDirs.join(', ')}. Note: windows-workspace enforces the bound Windows project root (${localCwd}) as its filesystem boundary.`,
      );
    }
    bridgeSystemPrompt = baseBridgeParts.join('\n\n');

    const mergedPromptParts = [bridgeSystemPrompt];
    if (typeof appendSystemPrompt === 'string' && appendSystemPrompt.trim()) {
      mergedPromptParts.push(appendSystemPrompt.trim());
    }

    const baseMcp = await readJsonSafe(path.join(bridgeRoot, 'mcp-config.private.json'), {});
    const mcpServers = { ...(baseMcp.mcpServers && typeof baseMcp.mcpServers === 'object' ? baseMcp.mcpServers : {}) };
    for (const name of initialServers) {
      mcpServers[name] = {
        type: 'stdio',
        command: 'python3',
        args: [path.join(bridgeRoot, 'mcp-local.py'), '--server', name],
      };
    }
    const mergedMcpConfig = JSON.stringify({ ...baseMcp, mcpServers });

    const baseSettings = await readJsonSafe(path.join(bridgeRoot, 'workspace-settings.json'), {});
    const mergedSettings = { ...(extraSettings && typeof extraSettings === 'object' ? extraSettings : {}), ...baseSettings };
    if (extraSettings?.hooks && typeof extraSettings.hooks === 'object' && baseSettings.hooks) {
      mergedSettings.hooks = { ...extraSettings.hooks, ...baseSettings.hooks };
      if (Array.isArray(extraSettings.hooks.PreToolUse) && Array.isArray(baseSettings.hooks.PreToolUse)) {
        mergedSettings.hooks.PreToolUse = [...baseSettings.hooks.PreToolUse, ...extraSettings.hooks.PreToolUse];
      }
    }

    finalArgs.push(
      '--append-system-prompt', mergedPromptParts.join('\n\n'),
      '--tools', zeroTools ? '' : DEFAULT_TOOLS,
      '--strict-mcp-config',
      '--mcp-config', mergedMcpConfig,
      '--settings', JSON.stringify(mergedSettings),
      ...args,
    );

    spawnEnv = {
      ...process.env,
      PATH: `${bridgeRoot}:${process.env.PATH ?? ''}`,
      WINDOWS_PROJECT_CWD: localCwd,
      WINDOWS_PROJECT_ID: projectId,
      WINDOWS_BRIDGE_SESSION: sessionId,
      WINDOWS_MEDIA_SESSION: sessionId,
      WINDOWS_BRIDGE_ROOT: bridgeRoot,
      CODEXHOST_CLI_PATH: agentCommand,
      ...toolEnv,
      WINDOWS_T3_MCP: '0',
      WINDOWS_ALLOWED_MCP_FILE: allowedMcpFile,
    };
  }

  child = spawn(claudeCommand, finalArgs, {
    cwd: spawnCwd,
    env: spawnEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  childReady = true;
  send({ type: 'started', remoteCwd: spawnCwd, pid: child.pid ?? null });

  child.stdin.on('error', () => {});
  for (const line of queuedStdinLines.splice(0)) {
    const outLine = await prepareOutgoingStdinLine(line);
    if (outLine !== null && child?.stdin?.writable) child.stdin.write(`${outLine}\n`);
  }

  const outRl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let outChain = Promise.resolve();
  outRl.on('line', line => {
    outChain = outChain.then(async () => {
      if (pendingMcpUpdate) {
        let msg;
        try { msg = JSON.parse(line); } catch {}
        if (msg?.type === 'control_response' && msg.response?.request_id === pendingMcpUpdate.id) {
          if (msg.response.subtype !== 'success') {
            await writeAllowedMcpFile(pendingMcpUpdate.previous);
            allowedMcpServers = pendingMcpUpdate.previous;
          }
          pendingMcpUpdate = null;
        }
      }
      send({ type: 'claude_out', line });
    }).catch(error => {
      send({ type: 'claude_err', text: `Claude VPS MCP allow-list update failed: ${error.message}\n` });
      void shutdown(1);
    });
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    send({ type: 'claude_err', text: chunk });
  });

  child.on('error', err => {
    send({ type: 'claude_err', text: `Failed to spawn remote claude: ${err.message}\n` });
    send({ type: 'exit', code: 1, signal: null });
    void shutdown(1);
  });

  child.on('close', async (code, signal) => {
    await outChain;
    send({ type: 'exit', code: code ?? 0, signal: signal ?? null });
    void shutdown(code ?? 0);
  });
}

async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  for (const pending of pendingLocal.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error('Remote stream relay closed'));
  }
  pendingLocal.clear();
  try {
    if (child && child.exitCode === null) {
      child.stdin?.end();
      child.kill('SIGTERM');
    }
  } catch {
    // Ignore child cleanup error.
  }
  try {
    if (toolBridge) await toolBridge.close();
  } catch {
    // Ignore socket cleanup error.
  }
  try {
    if (allowedMcpFile) await unlink(allowedMcpFile);
  } catch {
    // Ignore allow-file cleanup error.
  }
  try {
    const finished = new Promise(resolve => process.stdout.once('finish', resolve));
    writer.end();
    let timer;
    try {
      await Promise.race([finished, new Promise(resolve => { timer = setTimeout(resolve, 1500); })]);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // The SSH consumer may have closed its pipe.
  }
  process.exit(code);
}

let stdinWriteChain = Promise.resolve();

readJsonLines(process.stdin, frame => {
  if (!frame || typeof frame !== 'object') return;
  if (frame.type === 'start') {
    stdinWriteChain = stdinWriteChain.then(() => startClaude(frame)).catch(err => {
      send({ type: 'claude_err', text: `Claude VPS relay start error: ${err.message}\n` });
      send({ type: 'exit', code: 1, signal: null });
      void shutdown(1);
    });
    return;
  }
  if (frame.type === 'claude_in' && typeof frame.line === 'string') {
    stdinWriteChain = stdinWriteChain.then(async () => {
      if (childReady && child?.stdin?.writable) {
        const outLine = await prepareOutgoingStdinLine(frame.line);
        if (outLine !== null && child?.stdin?.writable) child.stdin.write(`${outLine}\n`);
      } else {
        queuedStdinLines.push(frame.line);
      }
    }).catch(() => {});
    return;
  }
  if (frame.type === 'local_reply' && typeof frame.controlId === 'string') {
    const pending = pendingLocal.get(frame.controlId);
    if (!pending) return;
    pendingLocal.delete(frame.controlId);
    clearTimeout(pending.timer);
    if (frame.error) pending.reject(new Error(String(frame.error)));
    else pending.resolve(frame.value);
    return;
  }
  if (frame.type === 'stop') {
    stdinWriteChain = stdinWriteChain.then(() => {
      try {
        child?.stdin?.end();
      } catch {
        // Ignore stdin close error.
      }
    });
  }
}, {
  onError: () => void shutdown(2),
  onEnd: () => {
    stdinWriteChain = stdinWriteChain.then(() => {
      try {
        child?.stdin?.end();
      } catch {
        // Ignore.
      }
      setTimeout(() => void shutdown(0), 3000).unref();
    });
  },
});
