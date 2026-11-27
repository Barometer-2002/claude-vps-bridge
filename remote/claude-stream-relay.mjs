import { readFile, writeFile, mkdir, unlink, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { JsonWriter, readJsonLines } from './transport-streams.mjs';
import { prepareWorkspace } from './workspace-map.mjs';
import { createToolBridge } from './tool-bridge.mjs';
import { BRIDGE_PROTOCOL } from './bridge-protocol.mjs';
import { bridgeRoot, workspaceRoot, agentCommand } from './remote-config.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_TOOLS_LIST = ['Bash', 'Read', 'AskUserQuestion', 'WebSearch', 'WebFetch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'ExitPlanMode', 'EnterPlanMode', 'ToolSearch'];
const DEFAULT_TOOLS_SET = new Set(DEFAULT_TOOLS_LIST);
const DEFAULT_TOOLS = DEFAULT_TOOLS_LIST.join(',');
const SERVER_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const STANDALONE_CAPABILITIES = [
  'project-context',
  'local-policy',
  'local-hooks',
  'media-cache',
  'job-recovery',
  'duplex-control',
  'duplex-tools',
  'local-mcp',
  'account-usage',
];

async function runRelayHealthCheck() {
  try {
    const manifest = JSON.parse(await readFile(path.join(bridgeRoot, 'bridge-manifest.json'), 'utf8'));
    const claudeCommand = (await readFile(path.join(bridgeRoot, 'claude-path'), 'utf8')).trim();
    const healthEnv = {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}:${path.dirname(claudeCommand)}:${process.env.PATH ?? ''}`,
    };
    const { stdout } = await execFileAsync(claudeCommand, ['--version'], { env: healthEnv, timeout: 10_000, maxBuffer: 16_384 });
    const claudeVersion = stdout.trim();
    if (!claudeVersion) throw new Error('Remote claude --version returned empty output');
    process.stdout.write(`${JSON.stringify({
      ok: true,
      mode: 'standalone',
      protocol: BRIDGE_PROTOCOL,
      bridgeVersion: manifest.version ?? null,
      claudeExecutable: claudeCommand,
      claudeVersion,
      relayReady: true,
      capabilities: STANDALONE_CAPABILITIES,
    })}\n`);
    process.exit(0);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      mode: 'standalone',
      error: error?.message ?? String(error),
    })}\n`);
    process.exit(1);
  }
}

if (process.argv.includes('--health')) {
  await runRelayHealthCheck();
}

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
let allowedMcpFile = null;
let allowedMcpServers = [];
let pendingMcpUpdate = null;
const sessionTempFiles = [];
const queuedStdinLines = [];

async function writeSessionTempFile(runDir, prefix, ext, content) {
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const filePath = path.join(runDir, `${prefix}-${randomUUID()}.${ext}`);
  await writeFile(filePath, content, { mode: 0o600 });
  sessionTempFiles.push(filePath);
  return filePath;
}

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
  if (msg?.type !== 'control_request') return null;
  const subtype = msg.request?.subtype;
  let servers = null;
  let mergeWithInitial = false;
  if (subtype === 'mcp_set_servers') {
    servers = msg.request?.servers;
  } else if (subtype === 'initialize' && msg.request?.mcpServers !== undefined) {
    servers = msg.request.mcpServers;
    mergeWithInitial = true;
  } else {
    return null;
  }
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('Invalid MCP server map');
  const names = [];
  for (const [name, cfg] of Object.entries(servers)) {
    const isLocalProxy = SERVER_NAME_RE.test(name) && cfg && cfg.type === 'stdio' && cfg.command === 'python3'
      && Object.keys(cfg).length === 3 && Array.isArray(cfg.args)
      && cfg.args.length === 3 && cfg.args[0] === path.join(bridgeRoot, 'mcp-local.py')
      && cfg.args[1] === '--server' && cfg.args[2] === name;
    const isSdkStub = SERVER_NAME_RE.test(name) && cfg && cfg.type === 'sdk'
      && Object.keys(cfg).length === 2 && cfg.name === name;
    if (!isLocalProxy && !isSdkStub) throw new Error('Invalid MCP proxy stub');
    names.push(name);
  }
  return { names, mergeWithInitial };
}

async function prepareOutgoingStdinLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return line;
  }
  try {
    const dynamic = extractProxiedServersFromControl(msg);
    if (dynamic !== null) {
      if (pendingMcpUpdate) throw new Error('An MCP update is already in progress');
      const nextServers = dynamic.mergeWithInitial
        ? [...new Set([...allowedMcpServers, ...dynamic.names])]
        : dynamic.names;
      await writeAllowedMcpFile(nextServers);
      pendingMcpUpdate = { id: msg.request_id, previous: allowedMcpServers };
      allowedMcpServers = nextServers;
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
    sdkMcpServers = [],
    addedDirs = [],
    probeOnly = false,
    zeroTools = false,
    requestedTools = null,
    agentAvailable = false,
  } = params;

  const claudeCommand = (await readFile(path.join(bridgeRoot, 'claude-path'), 'utf8')).trim();
  let spawnCwd = workspaceRoot;
  let spawnEnv = { ...process.env };
  const finalArgs = [];

  const runDir = path.join(bridgeRoot, 'run');

  if (!probeOnly && (!localCwd || !projectId || !workspaceInfo)) {
    throw new Error('Normal session requires bound Windows workspace identity');
  }

  if (probeOnly) {
    if (appendSystemPrompt) {
      if (Buffer.byteLength(appendSystemPrompt, 'utf8') > 32_768) {
        const promptFile = await writeSessionTempFile(runDir, 'system-prompt', 'md', appendSystemPrompt);
        finalArgs.push('--append-system-prompt-file', promptFile);
      } else {
        finalArgs.push('--append-system-prompt', appendSystemPrompt);
      }
    }
    finalArgs.push(
      '--tools', '',
      '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}',
      '--setting-sources', '',
      '--disallowedTools', 'Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch,Agent,Task,NotebookEdit',
      ...args,
    );
  } else {
    const prepared = await prepareWorkspace(workspaceInfo, workspaceRoot);
    spawnCwd = prepared.directory;

    toolBridge = await createToolBridge(async (_binding, request, internal) => {
      return duplexLocal(request, internal ? 'control' : 'tool');
    });
    const binding = { sessionId, localCwd, projectId, remoteCwd: spawnCwd };
    const toolEnv = toolBridge.register(binding);

    await mkdir(runDir, { recursive: true, mode: 0o700 });
    allowedMcpFile = path.join(runDir, `mcp-allow-${randomUUID()}.json`);
    const initialServers = new Set(
      (Array.isArray(localMcpServers) ? localMcpServers : []).filter(n => typeof n === 'string' && SERVER_NAME_RE.test(n)),
    );
    if (t3Mcp) initialServers.add('t3-code');
    const initialSdkServers = new Set(
      (Array.isArray(sdkMcpServers) ? sdkMcpServers : []).filter(n => typeof n === 'string' && SERVER_NAME_RE.test(n) && !initialServers.has(n)),
    );
    allowedMcpServers = [...initialServers, ...initialSdkServers];
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
    const bridgeSystemPrompt = baseBridgeParts.join('\n\n');

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
    for (const name of initialSdkServers) {
      mcpServers[name] = { type: 'sdk', name };
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

    const [promptFile, mcpConfigFile, settingsFile] = await Promise.all([
      writeSessionTempFile(runDir, 'system-prompt', 'md', mergedPromptParts.join('\n\n')),
      writeSessionTempFile(runDir, 'mcp-config', 'json', mergedMcpConfig),
      writeSessionTempFile(runDir, 'settings', 'json', JSON.stringify(mergedSettings)),
    ]);

    let toolsArg = DEFAULT_TOOLS;
    if (zeroTools) {
      toolsArg = '';
    } else if (Array.isArray(requestedTools) && requestedTools.length > 0) {
      const invalid = requestedTools.filter(t => !DEFAULT_TOOLS_SET.has(t));
      if (invalid.length > 0) {
        throw new Error(`Requested --tools entries are not available on the Windows workspace bridge: ${invalid.join(', ')}`);
      }
      toolsArg = requestedTools.join(',');
    }

    finalArgs.push(
      '--append-system-prompt-file', promptFile,
      '--tools', toolsArg,
      '--strict-mcp-config',
      '--mcp-config', mcpConfigFile,
      '--settings', settingsFile,
      ...args,
    );

    spawnEnv = {
      ...process.env,
      PATH: `${bridgeRoot}:${path.dirname(process.execPath)}:${process.env.PATH ?? ''}`,
      WINDOWS_PROJECT_CWD: localCwd,
      WINDOWS_PROJECT_ID: projectId,
      WINDOWS_BRIDGE_SESSION: sessionId,
      WINDOWS_MEDIA_SESSION: sessionId,
      WINDOWS_BRIDGE_ROOT: bridgeRoot,
      WINDOWS_AGENT_AVAILABLE: agentAvailable ? '1' : '0',
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
  for (const tempFile of sessionTempFiles.splice(0)) {
    await unlink(tempFile).catch(() => {});
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

async function runDuplexProbe() {
  let probeBridge = null;
  try {
    const manifest = JSON.parse(await readFile(path.join(bridgeRoot, 'bridge-manifest.json'), 'utf8'));
    const claudeCommand = (await readFile(path.join(bridgeRoot, 'claude-path'), 'utf8')).trim();
    const healthEnv = {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}:${path.dirname(claudeCommand)}:${process.env.PATH ?? ''}`,
    };
    const { stdout: verOut } = await execFileAsync(claudeCommand, ['--version'], { env: healthEnv, timeout: 10_000, maxBuffer: 16_384 });
    const claudeVersion = verOut.trim();
    if (!claudeVersion) throw new Error('Remote claude --version returned empty output');

    const sessionId = `probe-${randomUUID()}`;
    const localCwd = 'C:\\probe';
    const projectId = '0'.repeat(64);
    probeBridge = await createToolBridge(async (_binding, request, internal) => {
      return duplexLocal(request, internal ? 'control' : 'tool');
    });
    const toolEnv = probeBridge.register({ sessionId, localCwd, projectId, remoteCwd: bridgeRoot });
    const { stdout: wsOut } = await execFileAsync(
      path.join(bridgeRoot, 'windows-workspace'),
      ['{"action":"info"}'],
      {
        env: {
          ...process.env,
          ...toolEnv,
          WINDOWS_PROJECT_CWD: localCwd,
          WINDOWS_PROJECT_ID: projectId,
          WINDOWS_BRIDGE_SESSION: sessionId,
        },
        timeout: 15_000,
        maxBuffer: 65_536,
      },
    );
    const parsedWs = JSON.parse(wsOut.trim());
    if (parsedWs?.ok !== true) throw new Error('Probe windows-workspace roundtrip did not succeed');
    send({
      type: 'probe_result',
      ok: true,
      mode: 'standalone',
      protocol: BRIDGE_PROTOCOL,
      bridgeVersion: manifest.version ?? null,
      claudeVersion,
      duplexOk: true,
      relayReady: true,
    });
    await shutdown(0);
  } catch (error) {
    send({
      type: 'probe_result',
      ok: false,
      mode: 'standalone',
      error: error?.message ?? String(error),
    });
    await shutdown(1);
  } finally {
    try { if (probeBridge) await probeBridge.close(); } catch {}
  }
}

let stdinWriteChain = Promise.resolve();

readJsonLines(process.stdin, frame => {
  if (!frame || typeof frame !== 'object') return;
  if (frame.type === 'probe_duplex') {
    void runDuplexProbe();
    return;
  }
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
