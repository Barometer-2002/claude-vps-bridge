import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { JsonWriter, readJsonLines } from './transport-streams.mjs';
import { prepareWorkspace } from './workspace-map.mjs';
import { createToolBridge } from './tool-bridge.mjs';
import { bridgeRoot, workspaceRoot, agentCommand } from './remote-config.mjs';

const DEFAULT_TOOLS = 'Bash,Read,AskUserQuestion,WebSearch,WebFetch,TodoWrite,TaskCreate,TaskUpdate,TaskList,TaskGet,ExitPlanMode,EnterPlanMode,ToolSearch';

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
const queuedStdinLines = [];

function mergeInitializeSystemPrompt(line) {
  if (!bridgeSystemPrompt) return line;
  try {
    const msg = JSON.parse(line);
    if (msg?.type === 'control_request' && msg.request?.subtype === 'initialize') {
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
  } catch {
    // Non-JSON line; forward verbatim.
  }
  return line;
}

function duplexLocal(request, lane = 'control') {
  const controlId = randomUUID();
  const timeoutMs = request?.action === 'mcp' && request?.server === 't3-code' ? 305000 : 115000;
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

    const bridgeInstructions = await readFile(path.join(bridgeRoot, 'bridge-instructions.md'), 'utf8');
    const baseBridgeParts = [bridgeInstructions.trim()];
    if (typeof projectContext === 'string' && projectContext.trim()) {
      baseBridgeParts.push(projectContext.trim());
    }
    bridgeSystemPrompt = baseBridgeParts.join('\n\n');

    const mergedPromptParts = [bridgeSystemPrompt];
    if (typeof appendSystemPrompt === 'string' && appendSystemPrompt.trim()) {
      mergedPromptParts.push(appendSystemPrompt.trim());
    }

    const baseMcp = await readJsonSafe(path.join(bridgeRoot, 'mcp-config.private.json'), {});
    const mcpServers = { ...(baseMcp.mcpServers && typeof baseMcp.mcpServers === 'object' ? baseMcp.mcpServers : {}) };
    if (t3Mcp) {
      mcpServers['t3-code'] = {
        type: 'stdio',
        command: 'python3',
        args: [path.join(bridgeRoot, 'mcp-local.py'), '--server', 't3-code'],
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
      WINDOWS_T3_MCP: '1',
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
    child.stdin.write(`${mergeInitializeSystemPrompt(line)}\n`);
  }

  const outRl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  outRl.on('line', line => {
    send({ type: 'claude_out', line });
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

  child.on('close', (code, signal) => {
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
  const timer = setTimeout(() => process.exit(code), 1500);
  timer.unref();
  try {
    writer.dispose();
  } catch {
    // Ignore stream dispose error.
  }
  process.exit(code);
}

readJsonLines(process.stdin, frame => {
  if (!frame || typeof frame !== 'object') return;
  if (frame.type === 'start') {
    void startClaude(frame).catch(err => {
      send({ type: 'claude_err', text: `Claude VPS relay start error: ${err.message}\n` });
      send({ type: 'exit', code: 1, signal: null });
      void shutdown(1);
    });
    return;
  }
  if (frame.type === 'claude_in' && typeof frame.line === 'string') {
    if (childReady && child?.stdin?.writable) {
      child.stdin.write(`${mergeInitializeSystemPrompt(frame.line)}\n`);
    } else {
      queuedStdinLines.push(frame.line);
    }
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
    try {
      child?.stdin?.end();
    } catch {
      // Ignore stdin close error.
    }
  }
}, {
  onError: () => void shutdown(2),
  onEnd: () => {
    try {
      child?.stdin?.end();
    } catch {
      // Ignore.
    }
    setTimeout(() => void shutdown(0), 3000).unref();
  },
});
