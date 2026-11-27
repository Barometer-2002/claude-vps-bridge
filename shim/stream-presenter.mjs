import path from 'node:path';

const WORKSPACE_JSON_CMD_RE = /^\s*(?:\/usr\/local\/bin\/|\/[^\s'"]+\/)?windows-workspace\s+'(\{[\s\S]*\})'\s*$/;
const MAX_STREAM_BUFFER_CHARS = 512 * 1024;
const MAX_REMEMBERED_TOOL_USES = 256;
const MAX_LOCAL_RESULTS = 128;
const MAX_PENDING_APPROVALS = 128;
const MAX_SEARCH_PATTERNS = 128;

function tokenizePosixShell(text) {
  if (typeof text !== 'string') return null;
  const tokens = [];
  let cur = '';
  let inToken = false;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\' && i + 1 < text.length) {
        cur += text[++i];
      } else if (ch === '"') {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(cur);
        cur = '';
        inToken = false;
      }
      continue;
    }
    inToken = true;
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '\\' && i + 1 < text.length) {
      cur += text[++i];
    } else {
      cur += ch;
    }
  }
  if (quote) return null;
  if (inToken) tokens.push(cur);
  return tokens;
}

export function parseApprovedWorkspaceCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const jsonMatch = command.match(WORKSPACE_JSON_CMD_RE);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  const normalized = command.replace(/^\s*"\$CODEXHOST_CLI_PATH"/, 'windows-agent');
  const tokens = tokenizePosixShell(normalized);
  if (!tokens || tokens.length === 0) return null;
  const cmdBase = path.posix.basename(tokens[0]);
  if (cmdBase === 'windows-agent') {
    return { action: 'agent', argv: tokens.slice(1) };
  }
  if (cmdBase !== 'windows-workspace') return null;
  const argv = tokens.slice(1);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') return { action: 'info' };
  if (argv.length === 1 && argv[0].trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(argv[0]);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  const action = argv[0];
  const req = { action };
  const intFlags = new Map([
    ['--offset', 'offset'],
    ['--limit', 'limit'],
    ['--start-line', 'startLine'],
    ['--end-line', 'endLine'],
    ['--wait-ms', 'waitMs'],
    ['--segment', 'segment'],
  ]);
  const strFlags = new Map([
    ['--pattern', 'pattern'],
    ['--id', 'id'],
    ['--request-id', 'requestId'],
    ['--operation', 'operation'],
    ['--stream', 'stream'],
    ['--segment-id', 'segmentId'],
    ['--search-id', 'searchId'],
    ['--encoding', 'encoding'],
  ]);
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i];
    if (intFlags.has(tok) && i + 1 < argv.length) {
      const n = Number(argv[++i]);
      if (Number.isSafeInteger(n)) req[intFlags.get(tok)] = n;
    } else if (strFlags.has(tok) && i + 1 < argv.length) {
      req[strFlags.get(tok)] = argv[++i];
    } else if (!tok.startsWith('-') && req.path === undefined) {
      req.path = tok;
    }
  }
  return req;
}

function resolveWinPath(cwd, relOrAbs) {
  if (typeof relOrAbs !== 'string' || !relOrAbs.trim()) return null;
  const trimmed = relOrAbs.trim();
  if (path.win32.isAbsolute(trimmed)) return path.win32.normalize(trimmed);
  if (typeof cwd === 'string' && cwd.trim()) {
    return path.win32.resolve(cwd, trimmed);
  }
  return trimmed;
}

function normPathKey(p) {
  return typeof p === 'string' ? path.win32.normalize(p).toLowerCase() : '';
}

function compactOneLine(value, maxLen = 72) {
  if (typeof value !== 'string') return '';
  const first = value.trim().split(/\r?\n/).find(l => l.trim()) ?? '';
  const cleaned = first.replace(/\s+/g, ' ').trim();
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
}

export function detectConsoleEncoding(env = process.env) {
  const override = typeof env?.CLAUDE_VPS_CONSOLE_ENCODING === 'string' ? env.CLAUDE_VPS_CONSOLE_ENCODING.trim() : '';
  if (override) return override;
  let locale = '';
  try {
    locale = String(Intl.DateTimeFormat().resolvedOptions().locale ?? '').toLowerCase();
  } catch {
    return null;
  }
  // Windows PowerShell writes native-command output in the legacy console code page.
  if (/^zh-(?:tw|hk|mo)\b|^zh-hant\b/.test(locale)) return 'big5';
  if (locale.startsWith('zh')) return 'gbk';
  if (locale.startsWith('ja')) return 'shift_jis';
  if (locale.startsWith('ko')) return 'euc-kr';
  return null;
}

const XML_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: '\'' };

function decodeClixmlText(text) {
  const parts = [];
  for (const m of text.matchAll(/<S S="(?:Error|Warning)">([\s\S]*?)<\/S>/gi)) {
    parts.push(m[1]);
  }
  return parts.join('')
    .replace(/&(lt|gt|amp|quot|apos);/g, (_, name) => XML_ENTITIES[name])
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\r\n/g, '\n');
}

function cleanRunStderr(stderr) {
  if (typeof stderr !== 'string') return '';
  const trimmed = stderr.trim();
  if (!trimmed) return '';
  // Redirected PowerShell streams arrive as CLIXML; progress-only records carry no user-facing text.
  if (/^#<\s*CLIXML\b/i.test(trimmed)) return decodeClixmlText(trimmed).trimEnd();
  return stderr.trimEnd();
}

function decodeStreamText(value, meta, consoleEncoding = null) {
  if (typeof value !== 'string') return '';
  let text = value;
  if (meta && typeof meta === 'object' && meta.encoding === 'base64') {
    // The bridge returns raw bytes as base64 when they are not valid UTF-8. Decode for
    // display only; the model still receives the original envelope.
    const bytes = Buffer.from(value, 'base64');
    text = null;
    if (consoleEncoding) {
      try {
        text = new TextDecoder(consoleEncoding, { fatal: true }).decode(bytes);
      } catch {
        text = null;
      }
    }
    if (text === null) text = bytes.toString('utf8');
  }
  return text.replace(/\r\n/g, '\n');
}

function extractToolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(block => (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function parseWorkspaceEnvelopeText(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (
      parsed
      && typeof parsed === 'object'
      && typeof parsed.ok === 'boolean'
      && (parsed.data !== undefined || parsed.error !== undefined || typeof parsed.cwd === 'string' || parsed.bridge === 'windows-workspace-v1')
    ) {
      return parsed;
    }
  } catch {
    // Not a JSON envelope.
  }
  return null;
}

const INFO_FIELD_RE = /"(cwd|machine|permissionMode)":\s*"((?:[^"\\]|\\.)*)"/g;

// Large info responses reach the host cut off mid-JSON (Claude Code caps Bash output near 30K chars),
// so pull out the identifying string fields that appear early in the envelope.
function salvageInfoFields(text) {
  if (typeof text !== 'string' || !/^\s*\{\s*"ok"\s*:\s*true\b/.test(text)) return null;
  const data = {};
  for (const m of text.matchAll(INFO_FIELD_RE)) {
    if (data[m[1]] !== undefined) continue;
    try {
      data[m[1]] = JSON.parse(`"${m[2]}"`);
    } catch {
      // Ignore a field cut off mid-escape.
    }
  }
  return data.cwd || data.machine ? data : null;
}

export function parseUnifiedDiffToStructuredPatch(unifiedDiff) {
  if (typeof unifiedDiff !== 'string' || !unifiedDiff.trim()) return [];
  const rawLines = unifiedDiff.replace(/\r\n/g, '\n').split('\n');
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
  const hunks = [];
  let current = null;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

  for (const line of rawLines) {
    const m = line.match(hunkRe);
    if (m) {
      current = {
        oldStart: Number(m[1]),
        oldLines: m[2] !== undefined ? Number(m[2]) : 1,
        newStart: Number(m[3]),
        newLines: m[4] !== undefined ? Number(m[4]) : 1,
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')) {
      current.lines.push(line);
    }
  }
  return hunks;
}

export function buildFallbackStructuredPatch(oldText, newText) {
  const splitLines = text => {
    if (typeof text !== 'string' || text === '') return [];
    const norm = text.replace(/\r\n/g, '\n');
    const arr = norm.endsWith('\n') ? norm.slice(0, -1).split('\n') : norm.split('\n');
    return arr;
  };
  const a = splitLines(oldText ?? '');
  const b = splitLines(newText ?? '');
  if (a.length === 0 && b.length === 0) return [];
  let start = 0;
  let endA = a.length;
  let endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if (start === endA && start === endB) return [];
  const from = Math.max(0, start - 3);
  const toA = Math.min(a.length, endA + 3);
  const lines = [];
  for (let i = from; i < start; i++) lines.push(` ${a[i]}`);
  for (let i = start; i < endA; i++) lines.push(`-${a[i]}`);
  for (let i = start; i < endB; i++) lines.push(`+${b[i]}`);
  for (let i = endA; i < toA; i++) lines.push(` ${a[i]}`);
  const oldLines = toA - from;
  const newLines = (start - from) + (endB - start) + (toA - endA);
  return [{
    oldStart: oldLines ? from + 1 : from,
    oldLines,
    newStart: newLines ? from + 1 : from,
    newLines,
    lines,
  }];
}

function formatNumberedContent(content, startLine = 1) {
  if (typeof content !== 'string' || content === '') return '';
  const lines = content.split('\n');
  const maxNumWidth = Math.max(5, String(startLine + lines.length - 1).length);
  return lines
    .map((line, idx) => `${String(startLine + idx).padStart(maxNumWidth, ' ')}\u2192${line}`)
    .join('\n');
}

function canonicalJsonEqual(a, b) {
  const norm = v => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v)
          .filter(k => v[k] !== undefined)
          .sort()
          .map(k => [k, norm(v[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

function trimMap(map, maxSize) {
  while (map.size >= maxSize) {
    map.delete(map.keys().next().value);
  }
}

function isRuleForPresentedTool(rule, presentedToolName) {
  if (!rule || typeof rule !== 'object') return false;
  if (rule.type === 'setMode') return false;
  if (typeof rule.toolName === 'string' && rule.toolName === presentedToolName) return true;
  if (Array.isArray(rule.rules)) {
    return rule.rules.some(r => r && typeof r === 'object' && r.toolName === presentedToolName);
  }
  return false;
}

function filterUpdatedPermissions(updatedPermissions, presentedToolName) {
  if (!Array.isArray(updatedPermissions)) return updatedPermissions;
  const kept = [];
  for (const entry of updatedPermissions) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.type === 'setMode') {
      kept.push(entry);
      continue;
    }
    if (Array.isArray(entry.rules)) {
      const remainingRules = entry.rules.filter(r => !(r && typeof r === 'object' && r.toolName === presentedToolName));
      if (remainingRules.length > 0) {
        kept.push({ ...entry, rules: remainingRules });
      }
      continue;
    }
    if (!isRuleForPresentedTool(entry, presentedToolName)) {
      kept.push(entry);
    }
  }
  return kept.length > 0 ? kept : undefined;
}

export function createWorkspaceStreamPresenter({ cwd = '', enabled = true, consoleEncoding = detectConsoleEncoding() } = {}) {
  const pendingBashBlocks = new Map();
  const rememberedToolUses = new Map();
  const pendingApprovals = new Map();
  const localWriteResults = new Map();
  const searchPatterns = new Map();

  function rememberToolUse(toolUseId, entry) {
    if (typeof toolUseId !== 'string' || !toolUseId) return;
    trimMap(rememberedToolUses, MAX_REMEMBERED_TOOL_USES);
    rememberedToolUses.set(toolUseId, entry);
  }

  function localResultKey(action, absPath, expectedHash) {
    return `${action}\0${normPathKey(absPath)}\0${String(expectedHash ?? '')}`;
  }

  function recordLocalResult(request, value) {
    if (!enabled || !request || typeof request !== 'object') return;
    if (!value || typeof value !== 'object' || value.ok !== true || !value.data || typeof value.data !== 'object') return;

    if (request.action === 'search' && typeof value.data.searchId === 'string' && typeof request.pattern === 'string') {
      trimMap(searchPatterns, MAX_SEARCH_PATTERNS);
      searchPatterns.set(value.data.searchId, {
        pattern: request.pattern,
        path: value.data.path ?? resolveWinPath(cwd, request.path ?? '.'),
      });
      return;
    }

    if (request.action === 'edit' || request.action === 'write') {
      const targetPath = value.data.path ?? resolveWinPath(cwd, request.path);
      if (!targetPath) return;
      const key = localResultKey(request.action, targetPath, request.expectedHash);
      if (!localWriteResults.has(key)) {
        trimMap(localWriteResults, MAX_LOCAL_RESULTS);
        localWriteResults.set(key, []);
      }
      const queue = localWriteResults.get(key);
      if (queue.length >= 8) queue.shift();
      queue.push({
        path: targetPath,
        unchanged: Boolean(value.data.unchanged),
        change: value.data.change ?? null,
        at: Date.now(),
      });
    }
  }

  function consumeLocalWriteResult(op, fallbackAbsPath) {
    const targetPath = resolveWinPath(cwd, op.path) ?? fallbackAbsPath;
    if (!targetPath) return null;
    const key = localResultKey(op.action, targetPath, op.expectedHash);
    const queue = localWriteResults.get(key);
    if (!queue || queue.length === 0) return null;
    const item = queue.shift();
    if (queue.length === 0) localWriteResults.delete(key);
    return item;
  }

  function mapWorkspaceOp(op, originalInput) {
    if (!op || typeof op !== 'object' || typeof op.action !== 'string') return null;

    if (op.action === 'read') {
      const filePath = resolveWinPath(cwd, op.path);
      if (!filePath) return null;
      const startLine = Number.isInteger(op.startLine) && op.startLine >= 1
        ? op.startLine
        : (Number.isInteger(op.offset) && op.offset >= 0 ? op.offset + 1 : undefined);
      const limit = Number.isInteger(op.endLine) && op.endLine >= 1
        ? Math.max(1, op.endLine - (startLine ?? 1) + 1)
        : (Number.isInteger(op.limit) && op.limit > 0 ? op.limit : undefined);
      return {
        kind: 'read',
        name: 'Read',
        input: {
          file_path: filePath,
          ...(startLine !== undefined ? { offset: startLine } : {}),
          ...(limit !== undefined ? { limit } : {}),
        },
        absPath: filePath,
      };
    }

    if (op.action === 'edit') {
      const filePath = resolveWinPath(cwd, op.path);
      if (!filePath || typeof op.oldText !== 'string' || typeof op.newText !== 'string') return null;
      return {
        kind: 'edit',
        name: 'Edit',
        input: {
          file_path: filePath,
          old_string: op.oldText,
          new_string: op.newText,
          replace_all: false,
        },
        absPath: filePath,
      };
    }

    if (op.action === 'write') {
      const filePath = resolveWinPath(cwd, op.path);
      if (!filePath || typeof op.content !== 'string') return null;
      return {
        kind: 'write',
        name: 'Write',
        input: {
          file_path: filePath,
          content: op.content,
        },
        absPath: filePath,
      };
    }

    if (op.action === 'search') {
      const remembered = typeof op.searchId === 'string' ? searchPatterns.get(op.searchId) : null;
      const pattern = typeof op.pattern === 'string' ? op.pattern : remembered?.pattern;
      if (typeof pattern !== 'string') return null;
      const targetPath = op.path !== undefined
        ? resolveWinPath(cwd, op.path)
        : (remembered?.path ?? resolveWinPath(cwd, '.'));
      return {
        kind: 'search',
        name: 'Grep',
        input: {
          pattern,
          ...(targetPath ? { path: targetPath } : {}),
          output_mode: 'content',
        },
        absPath: targetPath,
      };
    }

    if (op.action === 'list') {
      const targetPath = resolveWinPath(cwd, op.path ?? '.');
      if (!targetPath) return null;
      return {
        kind: 'list',
        name: 'Glob',
        input: {
          pattern: '*',
          path: targetPath,
        },
        absPath: targetPath,
      };
    }

    if (op.action === 'run') {
      const cmdText = typeof op.script === 'string' && op.script.trim()
        ? op.script.trim()
        : [op.executable, ...(Array.isArray(op.args) ? op.args : [])].filter(Boolean).join(' ');
      if (!cmdText) return null;
      const nextInput = {
        command: cmdText,
        ...(typeof originalInput?.description === 'string' && originalInput.description.trim()
          ? { description: originalInput.description }
          : (typeof op.workingDirectory === 'string' && op.workingDirectory.trim()
            ? { description: `Run in ${op.workingDirectory}` }
            : {})),
      };
      return {
        kind: 'run',
        name: 'Bash',
        input: nextInput,
        absPath: resolveWinPath(cwd, op.workingDirectory ?? '.'),
      };
    }

    if (op.action === 'batch' && Array.isArray(op.requests) && op.requests.length > 0) {
      if (op.requests.length === 1) {
        const sub = op.requests[0];
        if (sub && typeof sub === 'object' && ['read', 'list', 'search'].includes(sub.action)) {
          const promoted = mapWorkspaceOp(sub, originalInput);
          if (promoted) {
            return { ...promoted, fromSingleBatch: true, subOp: sub };
          }
        }
      }
      const counts = {};
      const targets = [];
      for (const r of op.requests) {
        if (!r || typeof r !== 'object') continue;
        if (typeof r.action === 'string') counts[r.action] = (counts[r.action] ?? 0) + 1;
        if (typeof r.path === 'string' && r.path.trim() && targets.length < 4) {
          targets.push(r.path.trim());
        }
      }
      const desc = Object.entries(counts).map(([a, n]) => `${a} ×${n}`).join(', ');
      const targetSuffix = targets.length
        ? `: ${targets.slice(0, 3).join(', ')}${targets.length > 3 || op.requests.length > 3 ? ', …' : ''}`
        : '';
      return {
        kind: 'batch',
        name: 'Bash',
        input: {
          command: `workspace batch (${desc || op.requests.length})${targetSuffix}`,
        },
        absPath: null,
      };
    }

    if (op.action === 'job') {
      const parts = ['task', op.operation ?? 'status'];
      if (op.requestId) parts.push(op.requestId);
      if (op.stream) parts.push(`--stream ${op.stream}`);
      return {
        kind: 'job',
        name: 'Bash',
        input: { command: parts.join(' ') },
        absPath: null,
      };
    }

    if (op.action === 'jobs') {
      return {
        kind: 'jobs',
        name: 'Bash',
        input: { command: 'tasks list' },
        absPath: null,
      };
    }

    if (op.action === 'info' || op.action === 'status' || op.action === 'context') {
      const targetSuffix = typeof op.path === 'string' && op.path.trim() ? ` ${op.path.trim()}` : '';
      return {
        kind: op.action,
        name: 'Bash',
        input: { command: `workspace ${op.action}${targetSuffix}` },
        absPath: resolveWinPath(cwd, op.path ?? '.'),
      };
    }

    if (op.action === 'media' && typeof op.path === 'string') {
      return {
        kind: 'media',
        name: 'Bash',
        input: { command: `stage media ${compactOneLine(op.path, 80)}` },
        absPath: resolveWinPath(cwd, op.path),
      };
    }

    if (op.action === 'artifact' && typeof op.path === 'string') {
      return {
        kind: 'artifact',
        name: 'Bash',
        input: { command: `verify artifact ${compactOneLine(op.path, 80)}` },
        absPath: resolveWinPath(cwd, op.path),
      };
    }

    if (op.action === 'capability' && typeof op.id === 'string') {
      return {
        kind: 'capability',
        name: 'Bash',
        input: { command: `load capability ${op.id}` },
        absPath: null,
      };
    }

    if (op.action === 'isolation') {
      return {
        kind: 'isolation',
        name: 'Bash',
        input: { command: `worktree ${op.operation ?? 'status'}` },
        absPath: null,
      };
    }

    return null;
  }

  function mapBashToolInput(input) {
    if (!input || typeof input !== 'object' || typeof input.command !== 'string') return null;
    const op = parseApprovedWorkspaceCommand(input.command);
    if (!op) return null;
    const mapped = mapWorkspaceOp(op, input);
    if (!mapped) return null;
    return { op, mapped };
  }

  function formatRunOrJobData(data) {
    const stdout = decodeStreamText(data.stdout, data.output?.stdout, consoleEncoding).trimEnd();
    const stderr = cleanRunStderr(decodeStreamText(data.stderr, data.output?.stderr, consoleEncoding));
    const body = typeof data.content === 'string' ? data.content.trimEnd() : '';
    const parts = [];
    if (stdout) parts.push(stdout);
    if (body) parts.push(body);
    if (stderr) parts.push(`[stderr]\n${stderr}`);
    if (data.output?.stdout?.truncated || data.output?.stderr?.truncated) {
      parts.push('[output truncated — preview only]');
    }
    const meta = [];
    if (data.status && data.status !== 'succeeded') meta.push(`status=${data.status}`);
    if (typeof data.exitCode === 'number' && data.exitCode !== 0) meta.push(`exitCode=${data.exitCode}`);
    if (data.error) meta.push(`error=${data.error}`);
    if (meta.length) parts.push(`[${meta.join(' · ')}]`);
    const text = parts.join('\n\n') || (typeof data.exitCode === 'number' ? `(exitCode=${data.exitCode})` : '(completed)');
    return {
      content: text,
      toolUseResult: {
        stdout: stdout || body,
        stderr,
        interrupted: data.status === 'cancelled' || data.status === 'interrupted',
        isImage: false,
      },
    };
  }

  function formatResolvedData(op, mapped, data, fallbackContent) {
    if (!data || typeof data !== 'object') {
      return { content: fallbackContent, toolUseResult: undefined };
    }

    if (mapped.kind === 'read' && typeof data.content === 'string') {
      const startLine = Number.isInteger(data.offset) ? data.offset + 1 : 1;
      const lines = data.content === '' ? [] : data.content.split('\n');
      const filePath = typeof data.path === 'string' ? data.path : mapped.absPath;
      const totalLines = Number.isInteger(data.totalLines) ? data.totalLines : (startLine - 1 + lines.length);
      return {
        content: formatNumberedContent(data.content, startLine),
        toolUseResult: {
          type: 'text',
          file: {
            filePath,
            content: data.content,
            numLines: lines.length,
            startLine,
            totalLines,
          },
        },
      };
    }

    if (mapped.kind === 'edit') {
      const localRes = consumeLocalWriteResult(op, mapped.absPath);
      const filePath = typeof data.path === 'string' ? data.path : (localRes?.path ?? mapped.absPath);
      const unchanged = Boolean(data.unchanged || localRes?.unchanged);
      let structuredPatch = [];
      if (!unchanged) {
        structuredPatch = localRes?.change?.unifiedDiff
          ? parseUnifiedDiffToStructuredPatch(localRes.change.unifiedDiff)
          : buildFallbackStructuredPatch(op.oldText, op.newText);
      }
      return {
        content: unchanged
          ? `The file ${filePath} was unchanged.`
          : `The file ${filePath} has been updated successfully.`,
        toolUseResult: {
          filePath,
          oldString: op.oldText,
          newString: op.newText,
          structuredPatch,
          userModified: false,
          replaceAll: false,
        },
      };
    }

    if (mapped.kind === 'write') {
      const localRes = consumeLocalWriteResult(op, mapped.absPath);
      const filePath = typeof data.path === 'string' ? data.path : (localRes?.path ?? mapped.absPath);
      const unchanged = Boolean(data.unchanged || localRes?.unchanged);
      const isCreate = localRes?.change?.kind
        ? localRes.change.kind === 'add'
        : op.expectedHash === 'absent';
      let structuredPatch = [];
      if (!unchanged) {
        if (localRes?.change?.unifiedDiff) {
          structuredPatch = parseUnifiedDiffToStructuredPatch(localRes.change.unifiedDiff);
        } else if (isCreate) {
          structuredPatch = buildFallbackStructuredPatch('', op.content);
        }
      }
      return {
        content: unchanged
          ? `The file ${filePath} was unchanged.`
          : isCreate
            ? `File created successfully at: ${filePath}`
            : `The file ${filePath} has been updated successfully.`,
        toolUseResult: {
          type: isCreate ? 'create' : 'update',
          filePath,
          content: op.content,
          structuredPatch,
        },
      };
    }

    if (mapped.kind === 'search') {
      const output = decodeStreamText(data.output, data, consoleEncoding).trimEnd();
      const suffix = data.hasMore ? '\n… (more results available)' : '';
      const lines = output ? output.split('\n').filter(Boolean) : [];
      const fileSet = new Set();
      for (const line of lines) {
        const m = line.match(/^(.+?):\d+:/);
        if (m) fileSet.add(m[1]);
      }
      const filenames = [...fileSet];
      const text = output ? `${output}${suffix}` : 'No matches found.';
      return {
        content: text,
        toolUseResult: {
          mode: 'content',
          filenames,
          numFiles: filenames.length,
          content: text,
          numLines: lines.length,
        },
      };
    }

    if (mapped.kind === 'list' && Array.isArray(data.entries)) {
      const rootPath = typeof data.path === 'string' ? data.path : mapped.absPath;
      const filenames = data.entries.map(e => {
        const label = e.kind === 'directory' ? `${e.name}/` : e.name;
        return rootPath ? path.win32.join(rootPath, label) : label;
      });
      const displayLines = data.entries.map(e => (e.kind === 'directory' ? `${e.name}/` : e.name));
      if (data.excludedEntries > 0) displayLines.push(`(${data.excludedEntries} excluded)`);
      return {
        content: displayLines.join('\n') || '(empty directory)',
        toolUseResult: {
          filenames,
          durationMs: 0,
          numFiles: filenames.length,
          truncated: Boolean(data.excludedEntries > 0),
        },
      };
    }

    if (mapped.kind === 'run' || mapped.kind === 'job') {
      return formatRunOrJobData(data);
    }

    if (mapped.kind === 'jobs' && Array.isArray(data)) {
      const lines = data.map(j => {
        const id = j?.requestId ?? 'unknown';
        const st = j?.status ?? 'unknown';
        const code = typeof j?.exitCode === 'number' ? ` (exitCode=${j.exitCode})` : '';
        return `- ${id}: ${st}${code}`;
      });
      const text = lines.join('\n') || '(no background tasks)';
      return { content: text, toolUseResult: { stdout: text, stderr: '', interrupted: false, isImage: false } };
    }

    if (mapped.kind === 'info') {
      const lines = [];
      if (data.cwd) lines.push(`Workspace: ${data.cwd}`);
      if (data.machine) lines.push(`Machine: ${data.machine}`);
      if (data.permissionMode) lines.push(`Permission mode: ${data.permissionMode}`);
      if (Array.isArray(data.instructions) && data.instructions.length > 0) {
        lines.push(`Rules (${data.instructions.length}): ${data.instructions.map(r => path.win32.basename(r.path ?? '')).filter(Boolean).join(', ')}`);
      }
      if (Array.isArray(data.capabilities) && data.capabilities.length > 0) {
        lines.push(`Capabilities: ${data.capabilities.length}`);
      }
      const text = lines.join('\n') || 'Workspace info loaded.';
      return { content: text, toolUseResult: { stdout: text, stderr: '', interrupted: false, isImage: false } };
    }

    if (mapped.kind === 'status') {
      const lines = [];
      if (data.project?.cwd) lines.push(`Workspace: ${data.project.cwd}`);
      if (data.permissionMode) lines.push(`Permission mode: ${data.permissionMode}`);
      if (data.runner) lines.push(`Task runner: ${data.runner.available ? `ready (pid ${data.runner.pid ?? '?'})` : `unavailable (${data.runner.error ?? ''})`}`);
      if (Array.isArray(data.jobs)) lines.push(`Background tasks: ${data.jobs.length}`);
      const text = lines.join('\n') || 'Workspace status loaded.';
      return { content: text, toolUseResult: { stdout: text, stderr: '', interrupted: false, isImage: false } };
    }

    if (mapped.kind === 'context' && typeof data.text === 'string') {
      const text = data.text.trimEnd();
      return { content: text, toolUseResult: { stdout: text, stderr: '', interrupted: false, isImage: false } };
    }

    if (mapped.kind === 'batch' && Array.isArray(data)) {
      const reqs = Array.isArray(op.requests) ? op.requests : [];
      const sections = [];
      for (let i = 0; i < data.length; i++) {
        const subOp = reqs[i] ?? { action: 'unknown' };
        const subEnv = data[i];
        const label = `${subOp.action ?? 'op'}${subOp.path ? ` ${subOp.path}` : ''}`.trim();
        if (subEnv && typeof subEnv === 'object' && subEnv.ok === false) {
          const code = subEnv.error?.code ? `[${subEnv.error.code}] ` : '';
          sections.push(`### ${label}\n${code}${subEnv.error?.message ?? 'Failed'}`);
          continue;
        }
        const subMapped = mapWorkspaceOp(subOp, {});
        const subFormatted = subMapped && subEnv?.data !== undefined
          ? formatResolvedData(subOp, subMapped, subEnv.data, '(ok)')
          : { content: '(ok)' };
        sections.push(`### ${label}\n${typeof subFormatted.content === 'string' ? subFormatted.content : '(ok)'}`);
      }
      const text = sections.join('\n\n') || '(empty batch)';
      return { content: text, toolUseResult: { stdout: text, stderr: '', interrupted: false, isImage: false } };
    }

    if (mapped.kind === 'media') {
      const source = typeof data.source === 'string' ? data.source : mapped.absPath;
      const text = source ? `Staged media: ${source}` : 'Media staged.';
      return { content: text, toolUseResult: { stdout: text, stderr: '', interrupted: false, isImage: false } };
    }

    if (mapped.kind === 'artifact') {
      const text = typeof data.markdown === 'string' ? data.markdown : (typeof data.path === 'string' ? data.path : 'Artifact verified.');
      return { content: text, toolUseResult: { stdout: text, stderr: '', interrupted: false, isImage: false } };
    }

    if (mapped.kind === 'capability') {
      const text = typeof data.content === 'string' ? data.content : (typeof data.name === 'string' ? `Loaded capability: ${data.name}` : 'Capability loaded.');
      return { content: text, toolUseResult: { stdout: text, stderr: '', interrupted: false, isImage: false } };
    }

    if (mapped.kind === 'isolation') {
      const lines = [];
      if (data.status) lines.push(`Status: ${data.status}`);
      if (data.cwd) lines.push(`Worktree: ${data.cwd}`);
      if (data.branch) lines.push(`Branch: ${data.branch}`);
      const text = lines.join('\n') || 'Worktree operation completed.';
      return { content: text, toolUseResult: { stdout: text, stderr: '', interrupted: false, isImage: false } };
    }

    return { content: fallbackContent, toolUseResult: undefined };
  }

  function formatToolResult(entry, block, fallbackStdout) {
    const rawText = extractToolResultText(block.content);
    // Claude Code swaps oversized Bash output for a <persisted-output> preview in the tool_result
    // block; the frame-level tool_use_result keeps stdout, though cut off near 30K chars.
    const envelope = parseWorkspaceEnvelopeText(rawText) ?? parseWorkspaceEnvelopeText(fallbackStdout);

    if (block.is_error || envelope?.ok === false) {
      if (envelope?.ok === false) {
        const code = envelope.error?.code ? `[${envelope.error.code}] ` : '';
        const msg = envelope.error?.message ?? 'Workspace operation failed';
        return { content: `${code}${msg}`, toolUseResult: undefined };
      }
      return { content: block.content, toolUseResult: undefined };
    }

    if (!envelope && entry.mapped.kind === 'info') {
      const salvaged = salvageInfoFields(fallbackStdout ?? rawText);
      if (salvaged) {
        const summary = formatResolvedData(entry.op, entry.mapped, salvaged, block.content);
        const text = `${summary.content}\n(response truncated in transcript; summary only)`;
        return { content: text, toolUseResult: { ...summary.toolUseResult, stdout: text } };
      }
    }

    if (!envelope || envelope.data === undefined) {
      return { content: block.content, toolUseResult: undefined };
    }

    const { op, mapped } = entry;
    if (mapped.fromSingleBatch && Array.isArray(envelope.data) && envelope.data.length === 1) {
      const itemEnv = envelope.data[0];
      if (itemEnv && typeof itemEnv === 'object' && itemEnv.ok === false) {
        const code = itemEnv.error?.code ? `[${itemEnv.error.code}] ` : '';
        const msg = itemEnv.error?.message ?? 'Workspace operation failed';
        return { content: `${code}${msg}`, toolUseResult: undefined };
      }
      return formatResolvedData(mapped.subOp ?? op, mapped, itemEnv?.data, block.content);
    }

    return formatResolvedData(op, mapped, envelope.data, block.content);
  }

  function flushPendingStreamBlocks() {
    const out = [];
    for (const state of pendingBashBlocks.values()) {
      out.push(state.startFrame, ...state.deltas);
    }
    pendingBashBlocks.clear();
    return out;
  }

  function rewriteOutgoingFrame(frame) {
    if (!enabled || !frame || typeof frame !== 'object') return [frame];

    if (frame.type === 'stream_event' && frame.event && typeof frame.event === 'object') {
      const ev = frame.event;
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use' && ev.content_block?.name === 'Bash') {
        const directInput = ev.content_block.input;
        if (directInput && typeof directInput === 'object' && typeof directInput.command === 'string' && directInput.command.trim()) {
          const hit = mapBashToolInput(directInput);
          if (hit) {
            rememberToolUse(ev.content_block.id, {
              originalName: 'Bash',
              originalInput: directInput,
              op: hit.op,
              mapped: hit.mapped,
            });
            return [{
              ...frame,
              event: {
                ...ev,
                content_block: {
                  ...ev.content_block,
                  name: hit.mapped.name,
                  input: hit.mapped.input,
                },
              },
            }];
          }
          return [frame];
        }
        if (typeof ev.index === 'number') {
          pendingBashBlocks.set(ev.index, {
            startFrame: frame,
            partialJson: '',
            deltas: [],
            bufferedBytes: 0,
          });
          return [];
        }
        return [frame];
      }

      if (ev.type === 'content_block_delta' && typeof ev.index === 'number' && pendingBashBlocks.has(ev.index)
          && ev.delta?.type === 'input_json_delta' && typeof ev.delta.partial_json === 'string') {
        const state = pendingBashBlocks.get(ev.index);
        state.partialJson += ev.delta.partial_json;
        state.bufferedBytes += ev.delta.partial_json.length;
        state.deltas.push(frame);
        if (state.bufferedBytes > MAX_STREAM_BUFFER_CHARS) {
          pendingBashBlocks.delete(ev.index);
          return [state.startFrame, ...state.deltas];
        }
        return [];
      }

      if (ev.type === 'content_block_stop' && typeof ev.index === 'number' && pendingBashBlocks.has(ev.index)) {
        const state = pendingBashBlocks.get(ev.index);
        pendingBashBlocks.delete(ev.index);
        if (state.partialJson.trim()) {
          try {
            const parsedInput = JSON.parse(state.partialJson);
            const hit = mapBashToolInput(parsedInput);
            if (hit) {
              const origBlock = state.startFrame.event.content_block;
              rememberToolUse(origBlock.id, {
                originalName: 'Bash',
                originalInput: parsedInput,
                op: hit.op,
                mapped: hit.mapped,
              });
              const rewrittenStart = {
                ...state.startFrame,
                event: {
                  ...state.startFrame.event,
                  content_block: {
                    ...origBlock,
                    name: hit.mapped.name,
                    input: {},
                  },
                },
              };
              const baseDelta = state.deltas[0];
              if (baseDelta) {
                const rewrittenDelta = {
                  ...baseDelta,
                  event: {
                    ...baseDelta.event,
                    delta: {
                      ...baseDelta.event.delta,
                      partial_json: JSON.stringify(hit.mapped.input),
                    },
                  },
                };
                return [rewrittenStart, rewrittenDelta, frame];
              }
              return [{
                ...rewrittenStart,
                event: {
                  ...rewrittenStart.event,
                  content_block: {
                    ...rewrittenStart.event.content_block,
                    input: hit.mapped.input,
                  },
                },
              }, frame];
            }
          } catch {
            // Fall back to emitting raw frames unchanged.
          }
        }
        return [state.startFrame, ...state.deltas, frame];
      }

      if (ev.type === 'message_stop' && pendingBashBlocks.size > 0) {
        return [...flushPendingStreamBlocks(), frame];
      }
      return [frame];
    }

    const prefix = pendingBashBlocks.size > 0 && (frame.type === 'assistant' || frame.type === 'result')
      ? flushPendingStreamBlocks()
      : [];

    if (frame.type === 'assistant' && Array.isArray(frame.message?.content)) {
      let changed = false;
      const content = frame.message.content.map(block => {
        if (!block || typeof block !== 'object' || block.type !== 'tool_use' || block.name !== 'Bash') return block;
        const hit = mapBashToolInput(block.input);
        if (!hit) return block;
        rememberToolUse(block.id, {
          originalName: 'Bash',
          originalInput: block.input,
          op: hit.op,
          mapped: hit.mapped,
        });
        changed = true;
        return {
          ...block,
          name: hit.mapped.name,
          input: hit.mapped.input,
        };
      });
      if (changed) {
        return [...prefix, { ...frame, message: { ...frame.message, content } }];
      }
      return [...prefix, frame];
    }

    if (frame.type === 'user' && Array.isArray(frame.message?.content)) {
      let changed = false;
      let singleToolUseResult;
      let mappedCount = 0;
      const toolResultCount = frame.message.content
        .filter(b => b && typeof b === 'object' && b.type === 'tool_result').length;
      const frameStdout = toolResultCount === 1 && typeof frame.tool_use_result?.stdout === 'string'
        ? frame.tool_use_result.stdout
        : undefined;
      const content = frame.message.content.map(block => {
        if (!block || typeof block !== 'object' || block.type !== 'tool_result') return block;
        const entry = typeof block.tool_use_id === 'string' ? rememberedToolUses.get(block.tool_use_id) : null;
        if (!entry) return block;
        const formatted = formatToolResult(entry, block, frameStdout);
        mappedCount += 1;
        if (formatted.toolUseResult !== undefined) {
          singleToolUseResult = formatted.toolUseResult;
        }
        if (formatted.content !== block.content) {
          changed = true;
          return { ...block, content: formatted.content };
        }
        return block;
      });
      const attachStructured = mappedCount === 1 && singleToolUseResult !== undefined;
      if (changed || attachStructured) {
        const nextFrame = {
          ...frame,
          ...(changed ? { message: { ...frame.message, content } } : {}),
          ...(attachStructured ? { tool_use_result: singleToolUseResult } : {}),
        };
        return [...prefix, nextFrame];
      }
      return [...prefix, frame];
    }

    if (frame.type === 'control_request' && frame.request?.subtype === 'can_use_tool'
        && frame.request.tool_name === 'Bash' && typeof frame.request_id === 'string') {
      const hit = mapBashToolInput(frame.request.input);
      if (hit) {
        trimMap(pendingApprovals, MAX_PENDING_APPROVALS);
        pendingApprovals.set(frame.request_id, {
          originalToolName: 'Bash',
          originalInput: frame.request.input,
          op: hit.op,
          presentedName: hit.mapped.name,
          presentedInput: hit.mapped.input,
        });
        const nextReq = {
          ...frame.request,
          tool_name: hit.mapped.name,
          input: hit.mapped.input,
        };
        if (hit.mapped.name !== 'Bash' && 'permission_suggestions' in nextReq) {
          delete nextReq.permission_suggestions;
        }
        return [...prefix, { ...frame, request: nextReq }];
      }
    }

    return [...prefix, frame];
  }

  function rewriteIncomingFrame(msg) {
    if (!enabled || !msg || typeof msg !== 'object' || msg.type !== 'control_response') return msg;
    const reqId = msg.response?.request_id;
    if (typeof reqId !== 'string' || !pendingApprovals.has(reqId)) return msg;
    const saved = pendingApprovals.get(reqId);
    pendingApprovals.delete(reqId);

    if (msg.response?.subtype !== 'success') return msg;
    const inner = msg.response?.response;
    if (inner && typeof inner === 'object' && inner.behavior === 'allow') {
      const nextInner = { ...inner };
      if (nextInner.updatedInput && typeof nextInner.updatedInput === 'object') {
        if (canonicalJsonEqual(nextInner.updatedInput, saved.presentedInput)) {
          nextInner.updatedInput = saved.originalInput;
        } else {
          // Reject unsupported approval-time mutations rather than sending mismatched schema to VPS Bash.
          return {
            ...msg,
            response: {
              ...msg.response,
              response: {
                behavior: 'deny',
                message: `Modifying ${saved.presentedName} parameters inside the approval dialog is not supported on the Windows workspace bridge; reject and ask Claude to revise the operation instead.`,
              },
            },
          };
        }
      }

      if (saved.presentedName !== 'Bash' && Array.isArray(nextInner.updatedPermissions)) {
        const filtered = filterUpdatedPermissions(nextInner.updatedPermissions, saved.presentedName);
        if (filtered) nextInner.updatedPermissions = filtered;
        else delete nextInner.updatedPermissions;
      }

      return {
        ...msg,
        response: {
          ...msg.response,
          response: nextInner,
        },
      };
    }

    if (msg.response?.updatedInput && typeof msg.response.updatedInput === 'object') {
      if (canonicalJsonEqual(msg.response.updatedInput, saved.presentedInput)) {
        return {
          ...msg,
          response: {
            ...msg.response,
            updatedInput: saved.originalInput,
          },
        };
      }
      return {
        ...msg,
        response: {
          ...msg.response,
          response: {
            behavior: 'deny',
            message: `Modifying ${saved.presentedName} parameters inside the approval dialog is not supported on the Windows workspace bridge; reject and ask Claude to revise the operation instead.`,
          },
        },
      };
    }

    return msg;
  }

  return {
    recordLocalResult,
    rewriteOutgoingFrame,
    rewriteIncomingFrame,
    flushPendingStreamBlocks,
  };
}
