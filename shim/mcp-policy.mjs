// Local MCP policy & config validation for Claude VPS Shim (shim/).

export const MCP_SERVER_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

// Never allow an ACP SDK server to expose host filesystem or terminal tools that bypass windows-workspace.
const BLOCKED_ACP_WORKSPACE_BYPASS_TOOLS = new Set([
  'read',
  'write',
  'edit',
  'multiedit',
  'bash',
  'notebookedit',
  'read_text_file',
  'write_text_file',
  'terminal',
]);

// Fail-closed read-only allowlist for T3 MCP tools while in Plan mode.
// Any mutating, launching, cancelling, or newly added T3 tool is blocked in Plan mode.
export const PLAN_MODE_ALLOWED_T3_TOOLS = new Set([
  't3_environment_read',
  'orchestrator_capabilities',
  't3_thread_list',
  't3_thread_read',
  't3_thread_search',
  't3_project_list',
  't3_project_read',
  't3_worktree_status',
  't3_worktree_list',
  'list_scheduled_tasks',
  'list_thread_pull_requests',
  'pull_request_read',
  'pull_request_list',
  'ci_logs',
  'read_pull_request_guide',
  'list_issues',
  'read_issue',
  'list_thread_issues',
  'device_list',
  'device_screenshot',
  'preview_status',
  'preview_snapshot',
  't3_preview_list',
  't3_theme_read',
  'task_status',
]);

function parseCsvSet(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const items = value.split(',').map(s => s.trim()).filter(Boolean);
  return items.length ? new Set(items) : null;
}

export function parseT3McpPolicy(env = process.env) {
  return {
    allow: parseCsvSet(env?.T3_MCP_ALLOW_TOOLS),
    deny: parseCsvSet(env?.T3_MCP_DENY_TOOLS),
  };
}

export function isT3McpToolAllowed(toolName, policy, { permissionModeId, enforceMode = false } = {}) {
  if (typeof toolName !== 'string' || !toolName.trim()) return false;
  const name = toolName.trim();
  if (policy?.deny?.has(name)) return false;
  if (policy?.allow && !policy.allow.has(name)) return false;
  if (enforceMode && permissionModeId === 'plan' && !PLAN_MODE_ALLOWED_T3_TOOLS.has(name)) {
    return false;
  }
  return true;
}

function isPlainStringMap(value) {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (![null, Object.prototype].includes(Object.getPrototypeOf(value))) return false;
  return Object.values(value).every(v => typeof v === 'string');
}

export function normalizeMcpName(name) {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

export function isLocalMcpServerName(name) {
  return typeof name === 'string' && MCP_SERVER_NAME_RE.test(name) && !name.includes('__');
}

export function resolveLocalMcpTool(servers, fullToolName) {
  if (typeof fullToolName !== 'string') return null;
  let match = null;
  for (const server of servers) {
    for (const name of new Set([server, normalizeMcpName(server)])) {
      const prefix = `mcp__${name}__`;
      if (fullToolName.startsWith(prefix) && (!match || prefix.length > match.prefix.length)) {
        match = { server, prefix };
      }
    }
  }
  return match && { server: match.server, toolName: fullToolName.slice(match.prefix.length) };
}

function matchesWildcard(pattern, text) {
  if (pattern === '*' || pattern === text) return true;
  if (!pattern.includes('*')) return false;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(text);
}

function matchesProjectMcpRule(entryPattern, fullToolName, serverPrefix) {
  if (typeof entryPattern !== 'string' || !entryPattern.trim()) return false;
  const m = entryPattern.trim().match(/^([^()]+)(?:\((.*)\))?$/s);
  if (!m) return false;
  const toolPat = m[1].trim();
  if (toolPat === '*' || toolPat === fullToolName || toolPat === serverPrefix) return true;
  if (toolPat.startsWith('mcp__')) return matchesWildcard(toolPat, fullToolName);
  return false;
}

/**
 * Strictly validate a local Windows MCP server entry before proxying.
 * Never allows raw unrecognized entries (or entries carrying url/headers/env) to pass through to VPS.
 */
export function validateLocalMcpServerConfig(name, entry) {
  if (!isLocalMcpServerName(name)) {
    return { ok: false, error: 'Invalid local MCP server name' };
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, error: `Local MCP server "${name}" configuration must be an object` };
  }

  const type = entry.type;
  const hasUrl = typeof entry.url === 'string' && entry.url.trim().length > 0;
  const hasCommand = typeof entry.command === 'string' && entry.command.trim().length > 0;

  if (type === 'sdk') {
    const keys = Object.keys(entry);
    if (!keys.every(k => k === 'type' || k === 'name')) {
      return { ok: false, error: `Local SDK MCP server "${name}" must not carry url, headers, command, or env fields` };
    }
    if (entry.name !== undefined && (typeof entry.name !== 'string' || entry.name !== name)) {
      return { ok: false, error: `Local SDK MCP server "${name}" name field must match its key` };
    }
    return { ok: true, kind: 'sdk' };
  }

  if (type === 'sse') {
    return { ok: false, error: `Local MCP server "${name}" requires Streamable HTTP or stdio. Legacy SSE transport is unsupported` };
  }
  if (type === 'http' || (type === undefined && hasUrl && !hasCommand)) {
    if (!hasUrl) {
      return { ok: false, error: `Local HTTP MCP server "${name}" is missing a valid url` };
    }
    let parsedUrl;
    try {
      parsedUrl = new URL(entry.url.trim());
    } catch {
      return { ok: false, error: `Local HTTP MCP server "${name}" has a malformed url` };
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
      return { ok: false, error: `Local HTTP MCP server "${name}" requires an HTTP(S) URL without user credentials` };
    }
    if (!isPlainStringMap(entry.headers)) {
      return { ok: false, error: `Local HTTP MCP server "${name}" headers must be a string map` };
    }
    if (['command', 'args', 'env', 'cwd'].some(key => Object.hasOwn(entry, key))) {
      return { ok: false, error: `Local MCP server "${name}" mixes HTTP and stdio fields` };
    }
    return { ok: true, kind: 'http' };
  }

  if (type === 'stdio' || (type === undefined && hasCommand && !hasUrl)) {
    if (!hasCommand) {
      return { ok: false, error: `Local stdio MCP server "${name}" is missing a valid command` };
    }
    if (entry.args !== undefined && (!Array.isArray(entry.args) || !entry.args.every(a => typeof a === 'string'))) {
      return { ok: false, error: `Local stdio MCP server "${name}" args must be an array of strings` };
    }
    if (!isPlainStringMap(entry.env)) {
      return { ok: false, error: `Local stdio MCP server "${name}" env must be a string map` };
    }
    if (entry.cwd !== undefined && typeof entry.cwd !== 'string') {
      return { ok: false, error: `Local stdio MCP server "${name}" cwd must be a string` };
    }
    if (Object.hasOwn(entry, 'url') || Object.hasOwn(entry, 'headers')) {
      return { ok: false, error: `Local stdio MCP server "${name}" must not carry url or headers` };
    }
    return { ok: true, kind: 'stdio' };
  }

  return {
    ok: false,
    error: `Unsupported or unrecognized local MCP server "${name}" configuration`,
  };
}

/**
 * Evaluate local MCP policy before executing tools/call.
 */
export function evaluateLocalMcpToolCall({
  server,
  toolName,
  arguments: toolArgs = null,
  permissionMode = 'default',
  t3Policy = null,
  projectPermissions = null,
  toolMeta = null,
  trustedServers = null,
} = {}) {
  if (!isLocalMcpServerName(server)) {
    return { allowed: false, reason: 'Invalid MCP server name.' };
  }
  if (typeof toolName !== 'string' || !toolName.trim()) {
    return { allowed: false, reason: 'Missing MCP tool name.' };
  }
  const cleanTool = toolName.trim();
  const fullToolName = `mcp__${server}__${cleanTool}`;
  const ruleMatches = pattern => [server, normalizeMcpName(server)].some(name => {
    const prefix = `mcp__${name}`;
    return [cleanTool, normalizeMcpName(cleanTool)].some(tool =>
      matchesProjectMcpRule(pattern, `${prefix}__${tool}`, prefix));
  });

  // 1. Project .claude/settings*.json explicit deny rules always win.
  const denyRules = projectPermissions?.deny ?? [];
  for (const entry of denyRules) {
    if (ruleMatches(entry?.pattern)) {
      return {
        allowed: false,
        reason: `Local project policy denies MCP tool "${fullToolName}" (deny rule ${entry.pattern}${entry.source ? ` in ${entry.source}` : ''}).`,
      };
    }
  }

  // 1.5. Block ACP built-in filesystem/terminal tools that would bypass windows-workspace locks and boundaries.
  if (server.toLowerCase() === 'acp' && BLOCKED_ACP_WORKSPACE_BYPASS_TOOLS.has(cleanTool.toLowerCase())) {
    return {
      allowed: false,
      reason: `ACP built-in filesystem/terminal tool "${fullToolName}" is blocked to preserve windows-workspace path boundaries, hooks, and write locks.`,
    };
  }

  // 2. Built-in t3-code server: enforce T3_MCP_ALLOW_TOOLS / T3_MCP_DENY_TOOLS and Plan-mode fail-closed allowlist.
  if (server === 't3-code') {
    if (!isT3McpToolAllowed(cleanTool, t3Policy, { permissionModeId: permissionMode, enforceMode: true })) {
      return {
        allowed: false,
        reason: permissionMode === 'plan'
          ? `T3 MCP tool "${cleanTool}" is not on the read-only Plan mode allowlist. Switch mode before mutating or launching external work.`
          : `T3 MCP tool "${cleanTool}" is blocked by T3_MCP_ALLOW_TOOLS / T3_MCP_DENY_TOOLS policy.`,
      };
    }
  }

  // 2.5. Built-in playwright & tavily rules in Plan mode (never rely on untrusted self-reported annotations).
  if (server === 'playwright' && permissionMode === 'plan') {
    const passivePlaywright = new Set(['browser_snapshot', 'browser_console_messages', 'browser_network_requests']);
    if (!passivePlaywright.has(cleanTool) || toolArgs?.filename) {
      return {
        allowed: false,
        reason: `Plan mode blocked Playwright tool "${cleanTool}". Switch mode before interacting with pages or saving screenshots.`,
      };
    }
  }

  // 3. Custom local HTTP / Stdio / SDK MCP servers: fail-closed in Plan mode unless both:
  //    (a) explicitly annotated readOnlyHint=true and destructiveHint=false, AND
  //    (b) explicitly trusted via trustedServers (or CLAUDE_VPS_TRUSTED_MCP_SERVERS) or project permissions.allow.
  if (!['t3-code', 'playwright', 'tavily'].includes(server) && permissionMode === 'plan') {
    const isExplicitlyReadOnly = Boolean(
      toolMeta
      && toolMeta.known === true
      && toolMeta.readOnlyHint === true
      && toolMeta.destructiveHint === false,
    );
    if (!isExplicitlyReadOnly) {
      return {
        allowed: false,
        reason: !toolMeta?.known
          ? `Plan mode blocked unknown local MCP tool "${fullToolName}". Discover tools first or switch out of Plan mode.`
          : `Plan mode blocked local MCP tool "${fullToolName}" because it is not explicitly annotated readOnlyHint=true and destructiveHint=false. Switch mode before executing side-effecting or unannotated tools.`,
      };
    }
    const explicitlyAllowed = Boolean(projectPermissions?.allow?.some(entry => ruleMatches(entry?.pattern)));
    const isTrustedServer = trustedServers === '*' || (trustedServers instanceof Set && (trustedServers.has('*') || trustedServers.has(server)));
    if (!explicitlyAllowed && !isTrustedServer) {
      return {
        allowed: false,
        reason: `Plan mode blocked local MCP tool "${fullToolName}" because server "${server}" is not explicitly trusted for read-only annotations. Allow it in .claude/settings.json permissions.allow or CLAUDE_VPS_TRUSTED_MCP_SERVERS, or switch out of Plan mode.`,
      };
    }
  }

  const askRule = projectPermissions?.ask?.find(entry => ruleMatches(entry?.pattern));
  return askRule ? { allowed: true, approval: `Local project policy requests approval for "${fullToolName}".` } : { allowed: true };
}
