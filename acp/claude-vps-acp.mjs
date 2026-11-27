import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createAcpStreamTransformer, parseWorkspaceCommand } from './workspace-presenter.mjs';

const acpDir = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER_VERSION = '1.0.0';

function defaultShimExePath(env = process.env) {
  if (env.CLAUDE_CODE_EXECUTABLE && env.CLAUDE_CODE_EXECUTABLE.trim()) {
    return path.resolve(env.CLAUDE_CODE_EXECUTABLE.trim());
  }
  if (env.CLAUDE_VPS_SHIM_PATH && env.CLAUDE_VPS_SHIM_PATH.trim()) {
    return path.resolve(env.CLAUDE_VPS_SHIM_PATH.trim());
  }
  const shimDir = env.CLAUDE_VPS_SHIM_DIR
    ? path.resolve(env.CLAUDE_VPS_SHIM_DIR)
    : path.join(os.homedir(), '.claude-vps', 'shim');
  return path.join(shimDir, 'claude-vps-shim.exe');
}

function resolveUpstreamAgentEntry(env = process.env) {
  if (env.CLAUDE_VPS_ACP_AGENT_ENTRY && env.CLAUDE_VPS_ACP_AGENT_ENTRY.trim()) {
    return path.resolve(env.CLAUDE_VPS_ACP_AGENT_ENTRY.trim());
  }
  return path.join(acpDir, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js');
}

function readUpstreamVersion() {
  try {
    const pkg = JSON.parse(readFileSync(
      path.join(acpDir, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'package.json'),
      'utf8',
    ));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

export function runAcpSelfTest({ pure = false, env = process.env } = {}) {
  const tx = createAcpStreamTransformer();

  // 1. Initialize strips clientCapabilities.fs & terminal while keeping other capabilities.
  const initOut = JSON.parse(tx.transformClientToAgent(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
        plan: true,
      },
    },
  })));
  const initSanitizedOk = !('fs' in initOut.params.clientCapabilities)
    && !('terminal' in initOut.params.clientCapabilities)
    && initOut.params.clientCapabilities.plan === true;

  // 2. Track session/new cwd and enhance windows-workspace edit tool_call + request_permission + tool_call_update.
  tx.transformClientToAgent(JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'session/new',
    params: { cwd: 'C:\\example\\repo' },
  }));
  tx.transformAgentToClient(JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    result: { sessionId: 'sess-1' },
  }));

  const editCmd = `windows-workspace '{"action":"edit","path":"src/app.ts","oldText":"const a = 1;","newText":"const a = 2;","expectedHash":"abc"}'`;
  const toolCallOut = JSON.parse(tx.transformAgentToClient(JSON.stringify({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 'sess-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'Bash',
        kind: 'execute',
        rawInput: { command: editCmd },
      },
    },
  })));
  const toolCallOk = toolCallOut.params.update.kind === 'edit'
    && toolCallOut.params.update.title === 'Edit src/app.ts'
    && toolCallOut.params.update.locations?.[0]?.path === 'C:\\example\\repo\\src\\app.ts'
    && toolCallOut.params.update.content?.[0]?.type === 'diff'
    && toolCallOut.params.update.content?.[0]?.oldText === 'const a = 1;'
    && toolCallOut.params.update.content?.[0]?.newText === 'const a = 2;';

  const permOut = JSON.parse(tx.transformAgentToClient(JSON.stringify({
    jsonrpc: '2.0',
    id: 99,
    method: 'session/request_permission',
    params: {
      sessionId: 'sess-1',
      toolCall: {
        toolCallId: 'tc-1',
        title: 'Bash',
        kind: 'execute',
        rawInput: { command: editCmd },
      },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    },
  })));
  const permissionPreviewOk = permOut.params.toolCall.kind === 'edit'
    && permOut.params.toolCall.title === 'Edit src/app.ts'
    && permOut.params.toolCall.content?.[0]?.type === 'diff';

  // 3. Unknown non-workspace tools pass through verbatim.
  const passthroughLine = JSON.stringify({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 'sess-1',
      update: { sessionUpdate: 'tool_call', toolCallId: 'tc-2', title: 'WebSearch', kind: 'other', rawInput: { query: 'test' } },
    },
  });
  const passthroughOk = tx.transformAgentToClient(passthroughLine) === passthroughLine
    && parseWorkspaceCommand('echo hello') === null;

  const shimExe = defaultShimExePath(env);
  const agentEntry = resolveUpstreamAgentEntry(env);
  const shimPresent = existsSync(shimExe);
  const agentEntryPresent = existsSync(agentEntry);
  const ok = initSanitizedOk && toolCallOk && permissionPreviewOk && passthroughOk && (pure || (shimPresent && agentEntryPresent));

  return {
    ok,
    mode: pure ? 'acp-self-test-pure' : 'acp-self-test',
    wrapperVersion: WRAPPER_VERSION,
    upstreamVersion: readUpstreamVersion(),
    initSanitizedOk,
    toolCallOk,
    permissionPreviewOk,
    passthroughOk,
    ...(pure ? {} : { shimPresent, agentEntryPresent }),
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    const result = runAcpSelfTest({ pure: args.includes('--pure') });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (args.includes('--version') || args.includes('-v')) {
    const upstream = readUpstreamVersion();
    process.stdout.write(`claude-vps-acp ${WRAPPER_VERSION}${upstream ? ` (claude-agent-acp ${upstream})` : ''}\n`);
    return;
  }

  const shimExe = defaultShimExePath(process.env);
  if (!existsSync(shimExe)) {
    process.stderr.write(`Claude VPS neutral shim not found: ${shimExe}\nRun: node shim/manage-shim.mjs install\n`);
    process.exit(1);
  }
  const agentEntry = resolveUpstreamAgentEntry(process.env);
  if (!existsSync(agentEntry)) {
    process.stderr.write(`Official @agentclientprotocol/claude-agent-acp runtime not found: ${agentEntry}\nRun: node acp/manage-acp.mjs install\n`);
    process.exit(1);
  }

  const transformer = createAcpStreamTransformer();
  const child = spawn(process.execPath, [agentEntry, ...args], {
    env: {
      ...process.env,
      CLAUDE_CODE_EXECUTABLE: shimExe,
    },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  const stdinRl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  stdinRl.on('line', line => {
    const out = transformer.transformClientToAgent(line);
    if (child.stdin?.writable) {
      child.stdin.write(`${out}\n`);
    }
  });
  stdinRl.on('close', () => {
    try { child.stdin?.end(); } catch {}
  });

  const stdoutRl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  stdoutRl.on('line', line => {
    const out = transformer.transformAgentToClient(line);
    process.stdout.write(`${out}\n`);
  });

  child.stdin.on('error', () => {});
  child.on('error', err => {
    process.stderr.write(`Failed to start claude-agent-acp: ${err?.message ?? err}\n`);
    process.exit(1);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      try { child.kill(sig); } catch {}
    });
  }

  child.on('close', (code, signal) => {
    stdinRl.close();
    stdoutRl.close();
    if (signal) process.exit(130);
    process.exit(code ?? 0);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main();
}
