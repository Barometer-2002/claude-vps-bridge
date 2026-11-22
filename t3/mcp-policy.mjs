// Shared MCP policy & local MCP config validation used by both T3 ACP (t3/) and T3 Native Shim (t3-native/).

export const MCP_SERVER_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

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
 * Shared across T3 ACP and T3 Native Shim.
 */
export function evaluateLocalMcpToolCall({
  server,
  toolName,
  permissionMode = 'default',
  t3Policy = null,
  projectPermissions = null,
  toolMeta = null,
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

  // 3. Custom local HTTP / Stdio MCP servers: fail-closed in Plan mode unless explicitly declared read-only.
  if (server !== 't3-code' && permissionMode === 'plan') {
    const isExplicitlyReadOnly = Boolean(
      toolMeta
      && toolMeta.known === true
      && toolMeta.readOnlyHint === true
      && toolMeta.destructiveHint !== true,
    );
    if (!isExplicitlyReadOnly) {
      return {
        allowed: false,
        reason: !toolMeta?.known
          ? `Plan mode blocked unknown local MCP tool "${fullToolName}". Discover tools first or switch out of Plan mode.`
          : `Plan mode blocked local MCP tool "${fullToolName}" because it is not explicitly annotated readOnlyHint=true (non-destructive). Switch mode before executing side-effecting or unannotated tools.`,
      };
    }
  }

  const askRule = projectPermissions?.ask?.find(entry => ruleMatches(entry?.pattern));
  return askRule ? { allowed: true, approval: `Local project policy requests approval for "${fullToolName}".` } : { allowed: true };
}
