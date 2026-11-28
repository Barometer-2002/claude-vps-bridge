import path from 'node:path';

const WORKSPACE_CMD_PREFIX_RE = /^\s*(?:\/usr\/local\/bin\/|\/[^\s'"]+\/)?windows-workspace\s+/;
const MAX_REMEMBERED_CALLS = 512;
const DISABLED_V1_METHODS = new Set([
  'session/list',
  'session/load',
  'session/fork',
  'providers/list',
  'providers/set',
  'providers/disable',
  'logout',
]);
const ALLOWED_V1_SESSION_CAPS = new Set(['additionalDirectories', 'close', 'options', 'resume', 'status', 'systemPrompt', 'title']);
const FORBIDDEN_EXTRA_ARGS = new Set(['sdk-url', 'mcp-config', 'settings', 'setting-sources', 'plugin-dir', 'plugin-dir-no-mcp', 'project-config-root', 'session-id', 'resume', 'resume-session-at', 'continue', 'fork-session', 'r', 'c']);
const SESSION_ID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SENSITIVE_ENV_RE = /ANTHROPIC|OPENAI|API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|BASE_URL|AUTH|CODEXHOST|CLAUDE_CODE|CLAUDE_VPS_|NODE_OPTIONS|NODE_PATH|PYTHONPATH/i;
const SENSITIVE_SETTINGS_RE = /^(?:url|headers|env|mcpServers|mcpConfig|mcp_config|mcp_servers|apiKeyHelper|hooks)$/i;

export function parseWorkspaceCommand(command) {
  if (typeof command !== 'string' || !WORKSPACE_CMD_PREFIX_RE.test(command)) return null;
  const rest = command.replace(WORKSPACE_CMD_PREFIX_RE, '').trim();
  const jsonMatch = rest.match(/^'(\{[\s\S]*\})'$/) ?? rest.match(/^"(\{[\s\S]*\})"$/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (parsed && typeof parsed === 'object' && typeof parsed.action === 'string') return parsed;
    } catch {
      return null;
    }
  }
  const simple = rest.match(/^(read|list|search|status|info|jobs)(?:\s+([\s\S]*))?$/);
  if (!simple) return null;
  const action = simple[1];
  const argsStr = (simple[2] ?? '').trim();
  if (action === 'status' || action === 'info' || action === 'jobs') return { action };
  const targetMatch = argsStr.match(/^'([^']+)'|^"([^"]+)"|^(\S+)/);
  const targetPath = targetMatch ? (targetMatch[1] ?? targetMatch[2] ?? targetMatch[3]) : '.';
  if (action === 'read') {
    const offsetMatch = argsStr.match(/--offset\s+(\d+)/);
    const limitMatch = argsStr.match(/--limit\s+(\d+)/);
    const startLineMatch = argsStr.match(/--start-line\s+(\d+)/);
    const endLineMatch = argsStr.match(/--end-line\s+(\d+)/);
    return {
      action,
      path: targetPath,
      ...(offsetMatch ? { offset: Number(offsetMatch[1]) } : {}),
      ...(limitMatch ? { limit: Number(limitMatch[1]) } : {}),
      ...(startLineMatch ? { startLine: Number(startLineMatch[1]) } : {}),
      ...(endLineMatch ? { endLine: Number(endLineMatch[1]) } : {}),
    };
  }
  if (action === 'search') {
    const patMatch = argsStr.match(/--pattern\s+(?:'([^']+)'|"([^"]+)"|(\S+))/);
    return { action, path: targetPath, ...(patMatch ? { pattern: patMatch[1] ?? patMatch[2] ?? patMatch[3] } : {}) };
  }
  return { action, path: targetPath };
}

function resolveWinPath(sessionCwd, relOrAbs) {
  if (typeof relOrAbs !== 'string' || !relOrAbs.trim()) return null;
  const trimmed = relOrAbs.trim();
  if (path.win32.isAbsolute(trimmed)) return trimmed;
  if (typeof sessionCwd === 'string' && sessionCwd.trim()) {
    return path.win32.resolve(sessionCwd, trimmed);
  }
  return trimmed;
}

function displayRelPath(sessionCwd, relOrAbs) {
  if (typeof relOrAbs !== 'string' || !relOrAbs.trim()) return '.';
  const trimmed = relOrAbs.trim();
  if (sessionCwd && path.win32.isAbsolute(trimmed)) {
    const rel = path.win32.relative(sessionCwd, trimmed);
    if (rel && !rel.startsWith('..') && !path.win32.isAbsolute(rel)) return rel.replaceAll('\\', '/');
  }
  return trimmed.replaceAll('\\', '/');
}

function compactOneLine(value, maxLen = 72) {
  if (typeof value !== 'string') return '';
  const first = value.trim().split(/\r?\n/).find(l => l.trim()) ?? '';
  const cleaned = first.replace(/\s+/g, ' ').trim();
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
}

function extractTextOutput(output) {
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object') {
    if (typeof output.stdout === 'string') return output.stdout;
    if (typeof output.text === 'string') return output.text;
    if (Array.isArray(output.content)) {
      return output.content
        .map(b => {
          if (typeof b === 'string') return b;
          if (b?.type === 'text' && typeof b.text === 'string') return b.text;
          if (b?.type === 'content' && b.content?.type === 'text' && typeof b.content.text === 'string') return b.content.text;
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
  }
  return '';
}

function parseWorkspaceEnvelope(output) {
  if (output && typeof output === 'object' && typeof output.ok === 'boolean'
      && (output.data !== undefined || output.error !== undefined || output.bridge === 'windows-workspace-v1')) {
    return output;
  }
  const raw = extractTextOutput(output).trim();
  if (!raw || !raw.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed
      && typeof parsed === 'object'
      && typeof parsed.ok === 'boolean'
      && (parsed.data !== undefined || parsed.error !== undefined || typeof parsed.cwd === 'string' || parsed.bridge === 'windows-workspace-v1')
    ) {
      return parsed;
    }
  } catch {
    // Not a complete JSON envelope.
  }
  return null;
}

function cleanRunStderr(stderr) {
  if (typeof stderr !== 'string') return '';
  const trimmed = stderr.trim();
  if (!trimmed) return '';
  if (/^#<\s*CLIXML\b/i.test(trimmed) && !/S="(?:Error|Warning)"/i.test(trimmed)) {
    return '';
  }
  return stderr.trimEnd();
}

function formatWorkspaceEnvelopeContent(op, envelope, absPath, sessionCwd) {
  if (!envelope) return null;
  if (envelope.ok === false) {
    const msg = envelope.error?.message ?? 'Operation failed';
    const code = envelope.error?.code ? `[${envelope.error.code}] ` : '';
    return [{ type: 'content', content: { type: 'text', text: `${code}${msg}` } }];
  }
  const data = envelope.data;
  if (!data || typeof data !== 'object') return null;

  if (op.action === 'batch' && Array.isArray(data)) {
    const reqs = Array.isArray(op.requests) ? op.requests : [];
    const sections = [];
    for (let i = 0; i < data.length; i++) {
      const subOp = reqs[i] ?? { action: 'unknown' };
      const subEnv = data[i];
      const subAbs = resolveWinPath(sessionCwd, subOp.path);
      const subLabel = `${subOp.action ?? 'op'} ${subOp.path ?? ''}`.trim();
      const formatted = formatWorkspaceEnvelopeContent(subOp, subEnv, subAbs, sessionCwd);
      const textChunk = formatted?.find(b => b.type === 'content')?.content?.text;
      sections.push(`### ${subLabel}\n${textChunk ?? '(ok)'}`);
    }
    return sections.length ? [{ type: 'content', content: { type: 'text', text: sections.join('\n\n') } }] : null;
  }

  if (op.action === 'read' && typeof data.content === 'string') {
    const startLine = Number.isInteger(data.offset) ? data.offset + 1 : 1;
    const header = Number.isInteger(data.totalLines)
      ? `[${data.path ?? op.path} · lines ${startLine}-${Math.min(data.totalLines, startLine + data.content.split('\n').length - 1)} / ${data.totalLines}${data.truncated ? ' (truncated)' : ''}]\n`
      : '';
    return [{ type: 'content', content: { type: 'text', text: `${header}${data.content}` } }];
  }

  if (op.action === 'list' && Array.isArray(data.entries)) {
    const lines = data.entries.map(e => `${e.kind === 'directory' ? `${e.name}/` : e.name}`);
    if (data.excludedEntries > 0) lines.push(`(${data.excludedEntries} excluded)`);
    return [{ type: 'content', content: { type: 'text', text: lines.join('\n') || '(empty directory)' } }];
  }

  if (op.action === 'search') {
    if (typeof data.output === 'string') {
      const trimmed = data.output.trimEnd();
      const suffix = data.hasMore ? '\n… (more results available)' : '';
      return [{ type: 'content', content: { type: 'text', text: trimmed ? `${trimmed}${suffix}` : 'No matches found.' } }];
    }
    const matches = Array.isArray(data.matches) ? data.matches : [];
    const lines = matches.map(m => {
      const loc = m.path ?? m.file ?? '';
      const ln = m.line ?? m.lineNumber;
      const snippet = typeof m.text === 'string' ? m.text.trim() : (typeof m.lineText === 'string' ? m.lineText.trim() : '');
      return `${loc}${ln ? `:${ln}` : ''}${snippet ? `: ${snippet}` : ''}`;
    });
    if (data.hasMore) lines.push('… (more results available)');
    return [{ type: 'content', content: { type: 'text', text: lines.join('\n') || 'No matches found.' } }];
  }

  if (op.action === 'edit' || op.action === 'write') {
    const out = [];
    const targetPath = data.path ?? absPath;
    // Construct standard ACP diff blocks directly from structured edit/write inputs because
    // remote/windows-workspace compact() strips unifiedDiff to save model tokens.
    if (op.action === 'edit' && typeof targetPath === 'string' && typeof op.oldText === 'string' && typeof op.newText === 'string') {
      out.push({ type: 'diff', path: targetPath, oldText: op.oldText, newText: op.newText });
    } else if (op.action === 'write' && typeof targetPath === 'string' && typeof op.content === 'string') {
      out.push({ type: 'diff', path: targetPath, newText: op.content });
    }
    if (data.unchanged) {
      out.push({ type: 'content', content: { type: 'text', text: 'File unchanged.' } });
    }
    return out.length ? out : null;
  }

  if (op.action === 'run' || op.action === 'job') {
    const parts = [];
    if (typeof data.stdout === 'string' && data.stdout.trim()) parts.push(data.stdout.trimEnd());
    const cleanedStderr = cleanRunStderr(data.stderr);
    if (cleanedStderr) parts.push(`[stderr]\n${cleanedStderr}`);
    if (typeof data.content === 'string' && data.content.trim()) parts.push(data.content.trimEnd());
    if (data.output?.stdout?.truncated || data.output?.stderr?.truncated) {
      parts.push('[output truncated — preview only]');
    }
    const meta = [];
    if (data.status) meta.push(`status=${data.status}`);
    if (typeof data.exitCode === 'number') meta.push(`exitCode=${data.exitCode}`);
    if (data.error) meta.push(`error=${data.error}`);
    if (!parts.length && meta.length) parts.push(meta.join(' · '));
    else if (meta.length && data.status && data.status !== 'succeeded') parts.push(`[${meta.join(' · ')}]`);
    return parts.length ? [{ type: 'content', content: { type: 'text', text: parts.join('\n\n') } }] : null;
  }

  return null;
}

export function presentWorkspaceToolCall(item, sessionCwd, { includeOutput = false } = {}) {
  if (!item || typeof item !== 'object') return null;
  const op = parseWorkspaceCommand(item.command);
  if (!op) return null;

  const rel = displayRelPath(sessionCwd, op.path);
  const abs = resolveWinPath(sessionCwd, op.path);
  const envelope = includeOutput ? parseWorkspaceEnvelope(item.output) : null;

  let title = `Workspace ${op.action}`;
  let kind = 'other';
  let locations = abs ? [{ path: abs }] : undefined;
  let rawInput = op;
  let content = [];

  if (op.action === 'read') {
    kind = 'read';
    const startOne = Number.isInteger(op.startLine) && op.startLine >= 1
      ? op.startLine
      : (Number.isInteger(op.offset) ? op.offset + 1 : null);
    const endOne = Number.isInteger(op.endLine) && op.endLine >= 1
      ? op.endLine
      : (Number.isInteger(op.limit) && op.limit > 0 ? ((startOne ?? 1) + op.limit - 1) : null);
    const range = startOne !== null || endOne !== null
      ? ` (L${startOne ?? 1}${endOne !== null ? `-${endOne}` : '+'})`
      : '';
    title = `Read ${rel}${range}`;
    if (abs) locations = [{ path: abs, ...(startOne !== null && startOne > 1 ? { line: startOne } : {}) }];
    rawInput = {
      path: op.path,
      ...(op.offset !== undefined ? { offset: op.offset } : {}),
      ...(op.limit !== undefined ? { limit: op.limit } : {}),
      ...(op.startLine !== undefined ? { startLine: op.startLine } : {}),
      ...(op.endLine !== undefined ? { endLine: op.endLine } : {}),
    };
  } else if (op.action === 'list') {
    kind = 'read';
    title = `List ${rel}`;
    rawInput = { path: op.path ?? '.' };
  } else if (op.action === 'search') {
    kind = 'search';
    const pat = compactOneLine(String(op.pattern ?? ''), 40);
    title = pat ? `Search "${pat}"${rel && rel !== '.' ? ` in ${rel}` : ''}` : `Search ${rel}`;
    rawInput = { pattern: op.pattern, path: op.path ?? '.' };
  } else if (op.action === 'edit') {
    kind = 'edit';
    title = `Edit ${rel}`;
    if (abs && typeof op.oldText === 'string' && typeof op.newText === 'string') {
      content.push({ type: 'diff', path: abs, oldText: op.oldText, newText: op.newText });
    }
    rawInput = { path: op.path, oldText: op.oldText, newText: op.newText };
  } else if (op.action === 'write') {
    kind = 'edit';
    title = `Write ${rel}`;
    if (abs && typeof op.content === 'string') {
      content.push({ type: 'diff', path: abs, newText: op.content });
    }
    rawInput = { path: op.path };
  } else if (op.action === 'run') {
    kind = 'execute';
    const cmdText = typeof op.script === 'string' && op.script.trim()
      ? op.script.trim()
      : [op.executable, ...(Array.isArray(op.args) ? op.args : [])].filter(Boolean).join(' ');
    title = compactOneLine(cmdText, 76) || 'Run local command';
    const workDir = resolveWinPath(sessionCwd, op.workingDirectory);
    locations = workDir ? [{ path: workDir }] : undefined;
    rawInput = { command: cmdText, ...(op.workingDirectory ? { workingDirectory: op.workingDirectory } : {}) };
  } else if (op.action === 'job' || op.action === 'jobs') {
    kind = 'execute';
    title = op.action === 'jobs'
      ? 'List background tasks'
      : `Task ${op.operation ?? 'status'}${op.requestId ? ` (${op.requestId})` : ''}`;
    locations = undefined;
  } else if (op.action === 'batch') {
    kind = 'read';
    const reqs = Array.isArray(op.requests) ? op.requests : [];
    const counts = {};
    const locs = [];
    const seen = new Set();
    for (const r of reqs) {
      if (!r || typeof r !== 'object') continue;
      counts[r.action] = (counts[r.action] ?? 0) + 1;
      const p = resolveWinPath(sessionCwd, r.path);
      if (p && !seen.has(p)) {
        seen.add(p);
        locs.push({ path: p });
      }
    }
    const summary = Object.entries(counts).map(([a, n]) => `${a} ×${n}`).join(', ');
    title = summary ? `Batch (${summary})` : `Batch (${reqs.length})`;
    locations = locs.length ? locs : undefined;
  } else if (op.action === 'capability') {
    kind = 'read';
    title = `Load ${op.id ?? 'capability'}`;
    locations = undefined;
  } else if (op.action === 'isolation') {
    kind = 'execute';
    title = `Worktree ${op.operation ?? 'status'}`;
    locations = undefined;
  } else if (op.action === 'artifact' || op.action === 'media') {
    kind = 'read';
    title = `${op.action === 'media' ? 'Media' : 'Artifact'} ${rel}`;
  } else if (op.action === 'agent') {
    kind = 'other';
    const argvText = Array.isArray(op.argv) ? compactOneLine(op.argv.join(' '), 60) : '';
    title = argvText ? `Agent ${argvText}` : 'Agent';
    locations = undefined;
  } else if (op.action === 'status' || op.action === 'info' || op.action === 'context') {
    kind = 'read';
    title = `Inspect workspace ${op.action}`;
  }

  if (envelope) {
    const formatted = formatWorkspaceEnvelopeContent(op, envelope, abs, sessionCwd);
    if (formatted) content = formatted;
  }

  return { title, kind, locations, rawInput, content };
}

export function sanitizeClientInitializeRequest(msg) {
  if (!msg || typeof msg !== 'object' || msg.method !== 'initialize') return msg;
  const caps = msg.params?.clientCapabilities;
  if (!caps || typeof caps !== 'object') return msg;
  const hasForbiddenCap = Object.hasOwn(caps, 'fs')
    || Object.hasOwn(caps, 'terminal')
    || (caps._meta && typeof caps._meta === 'object' && (
      Object.hasOwn(caps._meta, 'terminal_output')
      || Object.hasOwn(caps._meta, 'terminal_output_delta')
      || Object.hasOwn(caps._meta, 'jetbrains.air')
      || (caps._meta.jetbrains && typeof caps._meta.jetbrains === 'object' && Object.hasOwn(caps._meta.jetbrains, 'air'))
    ));
  if (!hasForbiddenCap) return msg;
  // Remove client-side fs/terminal callbacks and terminal-output/AIR display extensions
  // so official claude-agent-acp routes workspace operations through windows-workspace.
  const nextCaps = { ...caps };
  delete nextCaps.fs;
  delete nextCaps.terminal;
  if (nextCaps._meta && typeof nextCaps._meta === 'object') {
    const nextMeta = { ...nextCaps._meta };
    delete nextMeta.terminal_output;
    delete nextMeta.terminal_output_delta;
    delete nextMeta['jetbrains.air'];
    if (nextMeta.jetbrains && typeof nextMeta.jetbrains === 'object') {
      const nextJb = { ...nextMeta.jetbrains };
      delete nextJb.air;
      if (Object.keys(nextJb).length > 0) nextMeta.jetbrains = nextJb;
      else delete nextMeta.jetbrains;
    }
    if (Object.keys(nextMeta).length > 0) nextCaps._meta = nextMeta;
    else delete nextCaps._meta;
  }
  return {
    ...msg,
    params: {
      ...msg.params,
      clientCapabilities: nextCaps,
    },
  };
}

export function sanitizeAgentInitializeResponse(msg) {
  if (!msg || typeof msg !== 'object' || !msg.result || typeof msg.result !== 'object') return msg;
  const caps = msg.result.agentCapabilities;
  if (!caps || typeof caps !== 'object') return msg;
  const nextCaps = { ...caps };
  if (nextCaps.mcpCapabilities && typeof nextCaps.mcpCapabilities === 'object') {
    nextCaps.mcpCapabilities = {
      ...nextCaps.mcpCapabilities,
      http: nextCaps.mcpCapabilities.http === true,
      sse: false,
      acp: false,
    };
  }
  nextCaps.loadSession = false;
  delete nextCaps.providers;
  if (nextCaps.auth && typeof nextCaps.auth === 'object') {
    const nextAuth = { ...nextCaps.auth };
    delete nextAuth.logout;
    nextCaps.auth = nextAuth;
  }
  if (nextCaps.sessionCapabilities && typeof nextCaps.sessionCapabilities === 'object') {
    nextCaps.sessionCapabilities = Object.fromEntries(
      Object.entries(nextCaps.sessionCapabilities).filter(([k]) => ALLOWED_V1_SESSION_CAPS.has(k)),
    );
  }
  return {
    ...msg,
    result: {
      ...msg.result,
      agentCapabilities: nextCaps,
      ...(Array.isArray(msg.result.authMethods) ? { authMethods: [] } : {}),
    },
  };
}

function validateAndRewriteSessionSetup(msg) {
  const params = msg.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return { error: `Missing ${msg.method} params` };
  if (msg.method === 'session/resume' && (typeof params.sessionId !== 'string' || !SESSION_ID_RE.test(params.sessionId))) {
    return { error: 'session/resume requires a Claude session UUID' };
  }
  if (params.mcpServers !== undefined) {
    if (!Array.isArray(params.mcpServers)) return { error: `${msg.method} mcpServers must be an array` };
    for (const srv of params.mcpServers) {
      if (!srv || typeof srv !== 'object') return { error: 'Invalid MCP server entry in session/new' };
      if (srv.type === 'sse') return { error: 'SSE MCP transport is unsupported; use Streamable HTTP or stdio' };
      if (srv.type === 'acp') return { error: 'ACP-over-MCP transport is disabled in ACP v1; use Streamable HTTP or stdio' };
      if (srv.type !== undefined && srv.type !== 'http' && srv.type !== 'stdio') {
        return { error: `Unsupported MCP server transport "${String(srv.type)}" in ACP v1` };
      }
    }
  }
  const meta = params._meta && typeof params._meta === 'object' ? params._meta : {};
  const claudeCode = meta.claudeCode && typeof meta.claudeCode === 'object' ? meta.claudeCode : {};
  const opts = claudeCode.options && typeof claudeCode.options === 'object' ? claudeCode.options : {};
  if (Object.hasOwn(opts, 'resume')) return { error: 'Use session/resume to continue an existing session' };
  if (opts.extraArgs && typeof opts.extraArgs === 'object') {
    for (const flag of Object.keys(opts.extraArgs)) {
      const base = String(flag).replace(/^--?/, '').split('=')[0];
      if (FORBIDDEN_EXTRA_ARGS.has(base)) {
        return { error: `Session option extraArgs.${flag} is not allowed in Claude VPS ACP v1` };
      }
    }
  }
  if (opts.env && typeof opts.env === 'object') {
    for (const key of Object.keys(opts.env)) {
      if (SENSITIVE_ENV_RE.test(key)) {
        return { error: `Session option env.${key} is local-only and cannot be injected via ACP` };
      }
    }
  }
  if (opts.settings && typeof opts.settings === 'object') {
    const hasBlockedSetting = val => val && typeof val === 'object' && Object.entries(val).some(([k, v]) => SENSITIVE_SETTINGS_RE.test(k) || hasBlockedSetting(v));
    if (hasBlockedSetting(opts.settings)) {
      return { error: 'Session option settings contains local-only MCP or environment configuration' };
    }
  }
  return {
    msg: {
      ...msg,
      params: {
        ...params,
        _meta: {
          ...meta,
          claudeCode: {
            ...claudeCode,
            options: {
              ...opts,
              mcpServersDelivery: 'initialize',
              settingsDelivery: 'initialize',
            },
          },
        },
      },
    },
  };
}

function extractCommandFromToolCall(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return null;
  if (typeof toolCall.rawInput?.command === 'string') return toolCall.rawInput.command;
  if (typeof toolCall.input?.command === 'string') return toolCall.input.command;
  if (typeof toolCall.title === 'string' && WORKSPACE_CMD_PREFIX_RE.test(toolCall.title)) return toolCall.title;
  return null;
}

export function enhanceAcpToolCall(toolCall, sessionCwd, rememberedCommands, { sessionId = '', isPermissionRequest = false } = {}) {
  if (!toolCall || typeof toolCall !== 'object') return toolCall;
  const callId = typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : null;
  const rememberKey = callId ? `${sessionId ?? ''}:${callId}` : null;
  let command = extractCommandFromToolCall(toolCall);
  let effectiveCwd = sessionCwd;

  if (command && parseWorkspaceCommand(command)) {
    if (rememberKey && rememberedCommands instanceof Map) {
      while (rememberedCommands.size >= MAX_REMEMBERED_CALLS) {
        rememberedCommands.delete(rememberedCommands.keys().next().value);
      }
      rememberedCommands.set(rememberKey, { command, cwd: sessionCwd });
    }
  } else if (rememberKey && rememberedCommands instanceof Map && rememberedCommands.has(rememberKey)) {
    const saved = rememberedCommands.get(rememberKey);
    command = saved.command;
    effectiveCwd = effectiveCwd || saved.cwd;
  } else {
    return toolCall;
  }

  const output = isPermissionRequest
    ? undefined
    : (toolCall.rawOutput !== undefined
      ? toolCall.rawOutput
      : (Array.isArray(toolCall.content) && toolCall.content.length ? { content: toolCall.content } : undefined));
  const includeOutput = !isPermissionRequest && output !== undefined && (
    toolCall.status === 'completed'
    || toolCall.status === 'failed'
    || toolCall.sessionUpdate === 'tool_call_update'
  );
  const presented = presentWorkspaceToolCall({ command, output }, effectiveCwd, { includeOutput });
  if (!presented) return toolCall;

  const originalRawInput = toolCall.rawInput && typeof toolCall.rawInput === 'object' ? toolCall.rawInput : {};
  const mergedRawInput = isPermissionRequest
    ? {
        ...originalRawInput,
        command,
        workspaceOperation: presented.rawInput,
      }
    : {
        ...originalRawInput,
        ...presented.rawInput,
      };

  return {
    ...toolCall,
    title: presented.title,
    kind: presented.kind,
    ...(presented.locations ? { locations: presented.locations } : {}),
    rawInput: mergedRawInput,
    ...(presented.content.length ? { content: presented.content } : {}),
  };
}

export function createAcpStreamTransformer() {
  const pendingSessionCwds = new Map();
  const pendingInitializeIds = new Set();
  const sessionCwds = new Map();
  const rememberedCommands = new Map();

  function trackClientMessage(msg) {
    if (msg.method === 'initialize') {
      if (msg.id !== undefined && msg.id !== null) {
        while (pendingInitializeIds.size >= 32) pendingInitializeIds.delete(pendingInitializeIds.keys().next().value);
        pendingInitializeIds.add(String(msg.id));
      }
      return sanitizeClientInitializeRequest(msg);
    }
    if (['session/new', 'session/load', 'session/resume', 'session/fork'].includes(msg.method)) {
      const cwd = typeof msg.params?.cwd === 'string' && msg.params.cwd.trim() ? msg.params.cwd.trim() : null;
      if (cwd) {
        if (msg.id !== undefined && msg.id !== null) {
          while (pendingSessionCwds.size >= 128) pendingSessionCwds.delete(pendingSessionCwds.keys().next().value);
          pendingSessionCwds.set(String(msg.id), { cwd, sessionId: msg.params?.sessionId });
        }
      }
    }
    return msg;
  }

  function processClientLine(line) {
    if (typeof line !== 'string' || !line.trim()) return { forwardLine: line, immediateReply: null };
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return { forwardLine: line, immediateReply: null };
    }
    if (!msg || typeof msg !== 'object') return { forwardLine: line, immediateReply: null };

    if (typeof msg.method === 'string' && DISABLED_V1_METHODS.has(msg.method)) {
      return {
        forwardLine: null,
        immediateReply: msg.id !== undefined && msg.id !== null
          ? JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32601, message: `Method "${msg.method}" is not enabled in Claude VPS ACP v1` },
            })
          : null,
      };
    }

    let nextMsg = msg;
    if (msg.method === 'session/new' || msg.method === 'session/resume') {
      const checked = validateAndRewriteSessionSetup(msg);
      if (checked.error) {
        return {
          forwardLine: null,
          immediateReply: msg.id !== undefined && msg.id !== null
            ? JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                error: { code: -32602, message: checked.error },
              })
            : null,
        };
      }
      nextMsg = checked.msg;
    }

    const tracked = trackClientMessage(nextMsg);
    const forwardLine = tracked === msg ? line : JSON.stringify(tracked);
    return { forwardLine, immediateReply: null };
  }

  function transformClientToAgent(line) {
    if (typeof line !== 'string' || !line.trim()) return line;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return line;
    }
    if (!msg || typeof msg !== 'object') return line;
    const tracked = trackClientMessage(msg);
    return tracked === msg ? line : JSON.stringify(tracked);
  }

  function transformAgentToClient(line) {
    if (typeof line !== 'string' || !line.trim()) return line;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return line;
    }
    if (!msg || typeof msg !== 'object') return line;

    if (msg.id !== undefined && msg.id !== null && pendingInitializeIds.has(String(msg.id))) {
      pendingInitializeIds.delete(String(msg.id));
      const narrowed = sanitizeAgentInitializeResponse(msg);
      return narrowed === msg ? line : JSON.stringify(narrowed);
    }

    // Track sessionId -> cwd from session/new / load / resume / fork responses.
    if (msg.id !== undefined && msg.id !== null && pendingSessionCwds.has(String(msg.id))) {
      const { cwd, sessionId } = pendingSessionCwds.get(String(msg.id));
      pendingSessionCwds.delete(String(msg.id));
      const sid = msg.result && (msg.result.sessionId ?? sessionId);
      if (typeof sid === 'string' && sid && cwd) {
        sessionCwds.set(sid, cwd);
      }
      return line;
    }

    // Enhance session/update tool_call & tool_call_update frames.
    if (msg.method === 'session/update' && msg.params?.update && typeof msg.params.update === 'object') {
      const update = msg.params.update;
      if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        const sid = typeof msg.params.sessionId === 'string' ? msg.params.sessionId : '';
        const cwd = sid ? sessionCwds.get(sid) : undefined;
        const enhanced = enhanceAcpToolCall(update, cwd, rememberedCommands, { sessionId: sid, isPermissionRequest: false });
        if (enhanced !== update) {
          return JSON.stringify({
            ...msg,
            params: { ...msg.params, update: enhanced },
          });
        }
      }
      return line;
    }

    // Enhance session/request_permission toolCall preview so approval prompts show clean Windows paths/diffs
    // while preserving the original command, parameters, and request metadata.
    if (msg.method === 'session/request_permission' && msg.params?.toolCall && typeof msg.params.toolCall === 'object') {
      const sid = typeof msg.params.sessionId === 'string' ? msg.params.sessionId : '';
      const cwd = sid ? sessionCwds.get(sid) : undefined;
      const enhanced = enhanceAcpToolCall(msg.params.toolCall, cwd, rememberedCommands, { sessionId: sid, isPermissionRequest: true });
      if (enhanced !== msg.params.toolCall) {
        return JSON.stringify({
          ...msg,
          params: { ...msg.params, toolCall: enhanced },
        });
      }
      return line;
    }

    return line;
  }

  return {
    transformClientToAgent,
    processClientLine,
    transformAgentToClient,
    getSessionCwd: sessionId => sessionCwds.get(sessionId) ?? null,
  };
}
