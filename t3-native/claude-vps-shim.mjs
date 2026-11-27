import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LocalMcpHub } from './http-mcp-client.mjs';
import { inspectBridge } from './bridge-installation.mjs';
import { evaluateLocalMcpToolCall, parseT3McpPolicy, resolveLocalMcpTool } from './mcp-policy.mjs';

const shimDir = path.dirname(fileURLToPath(import.meta.url));
const versionCachePath = path.join(shimDir, 'vps-version-cache.json');
const VERSION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const RELAY_START_TIMEOUT_MS = 20_000;
const CANCEL_WAIT_CAP_MS = 14_000;
const MEDIA_EXT_RE = /\.(?:png|jpe?g|webp|gif|pdf)$/i;
const BRIDGE_MEDIA_PATH_RE = /(?:^|\/)\.bridge-media\/[A-Za-z0-9_-]+\/([a-f0-9]{64}\.(?:png|jpe?g|webp|gif|pdf))$/i;
const BRIDGE_MEDIA_INLINE_RE = /(file:\/\/)?(\/[^\s"'`<>|)\]]*\/\.bridge-media\/[A-Za-z0-9_-]+\/([a-f0-9]{64}\.(?:png|jpe?g|webp|gif|pdf)))/gi;
const MEDIA_CACHE_LIMIT = 256;
const ACTIVE_JOB_STATUSES = new Set(['starting', 'queued', 'running', 'unresponsive', 'interrupted']);
const PERMISSION_MODES = new Set(['default', 'plan', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'auto', 'delegate']);
const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
// T3 only re-probes Claude usage after a usage-limit failure; otherwise its quota rings move only on
// streamed rate_limit_event frames, which the CLI does not emit every turn. The shim asks the VPS CLI
// for get_usage at the end of each turn and streams the windows T3 tracks before the result frame.
const USAGE_SYNC_REQUEST_PREFIX = "claude-vps-usage-";
const USAGE_SYNC_TIMEOUT_MS = 4_000;
const USAGE_SYNC_MIN_INTERVAL_MS = 10_000;
const USAGE_SYNC_MAX_PENDING = 16;
const USAGE_SYNC_WINDOWS = ["five_hour", "seven_day"];

function hasLocalConfig(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, nested]) => {
    if (['url', 'headers', 'env', 'mcpConfig', 'mcp_config', 'mcp_servers'].includes(key)) return true;
    if (key === 'mcpServers' && Array.isArray(nested) && nested.every(name => typeof name === 'string')) return false;
    return key === 'mcpServers' || hasLocalConfig(nested);
  });
}

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
  const mcpServers = Object.create(null);
  const invalidMcpConfigs = [];
  let extraSettings = null;
  let initialPermissionMode = 'default';
  let hasPermissionPromptTool = false;
  let hasAllowDangerouslySkip = false;
  let zeroTools = false;
  let isVersionCheck = false;
  let liveVersionCheck = process.env.CLAUDE_VPS_LIVE_VERSION === '1';
  let isSelfTest = false;
  let pureSelfTest = false;
  let claudeSessionId = null;
  let resumesSession = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--version' || arg === '-v' || arg === '-V') {
      isVersionCheck = true;
      continue;
    }
    if (arg === '--live') {
      liveVersionCheck = true;
      continue;
    }
    if (arg === '--self-test') {
      isSelfTest = true;
      continue;
    }
    if (arg === '--pure') {
      pureSelfTest = true;
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
      if (!parsed || Array.isArray(parsed) || Object.keys(parsed).some(key => key !== 'mcpServers')
          || (Object.hasOwn(parsed, 'mcpServers') && (!parsed.mcpServers || typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers)))) {
        invalidMcpConfigs.push('Invalid or unreadable --mcp-config payload');
      } else if (parsed.mcpServers) {
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
      if (parsed && hasLocalConfig(parsed)) {
        invalidMcpConfigs.push('--settings contains local-only MCP or environment configuration');
      } else if (parsed) extraSettings = { ...(extraSettings ?? {}), ...parsed };
      continue;
    }
    if (flag === '--session-id' || flag === '--resume' || flag === '-r') {
      const val = readValue();
      if (UUID_RE.test(val)) claudeSessionId = val;
      if (flag !== '--session-id') resumesSession = true;
      forwarded.push(flag, val);
      continue;
    }
    if (['--continue', '-c', '--resume-session-at', '--fork-session'].includes(flag)) resumesSession = true;
    if (flag === '--agents' || flag === '--agent-settings') {
      const val = readValue();
      const parsed = parseJsonOrFile(val);
      if (!parsed || hasLocalConfig(parsed)) {
        invalidMcpConfigs.push(`${flag} contains unreadable or local-only MCP or environment configuration`);
      } else {
        forwarded.push(flag, JSON.stringify(parsed));
      }
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
    liveVersionCheck,
    isSelfTest,
    pureSelfTest,
    forwarded,
    appendSystemPrompt: appendPrompts.join('\n\n'),
    addedDirs,
    mcpServers,
    invalidMcpConfigs,
    t3McpConfig: mcpServers['t3-code'] ?? null,
    extraSettings,
    claudeSessionId,
    resumesSession,
    initialPermissionMode,
    hasPermissionPromptTool,
    hasAllowDangerouslySkip,
    zeroTools,
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function sameWinPath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return path.win32.resolve(a).toLowerCase() === path.win32.resolve(b).toLowerCase();
}

export function createMediaPathRemapper({
  remoteWorkspaceRoot = '',
  sessionId = '',
  projectId = '',
  cacheFile = null,
  existsCheck = existsSync,
} = {}) {
  const exactMap = new Map();
  const hashMap = new Map();
  const pendingReadBlocks = new Map();
  const readToolUseIds = new Set();
  const pendingApprovals = new Map();
  let persistChain = Promise.resolve();

  if (cacheFile && projectId) {
    try {
      const parsed = JSON.parse(readFileSync(cacheFile, 'utf8'));
      const entries = parsed?.entries && typeof parsed.entries === 'object' ? parsed.entries : {};
      const prefix = `${projectId}:`;
      for (const [key, entry] of Object.entries(entries)) {
        if (!key.startsWith(prefix)) continue;
        const hashExt = key.slice(prefix.length).toLowerCase();
        if (typeof entry?.path === 'string' && path.win32.isAbsolute(entry.path)) {
          hashMap.set(hashExt, entry.path);
        }
      }
    } catch {
      // Cache file does not exist yet or is unreadable.
    }
  }

  function persistEntries(records) {
    if (!cacheFile || !projectId || !records.length) return;
    persistChain = persistChain.then(async () => {
      let entries = {};
      try {
        const existing = JSON.parse(await readFile(cacheFile, 'utf8'));
        if (existing?.entries && typeof existing.entries === 'object') entries = existing.entries;
      } catch {
        // Fresh cache file.
      }
      const now = Date.now();
      for (const { hashExt, winPath } of records) {
        entries[`${projectId}:${hashExt}`] = { path: winPath, projectId, updatedAt: now };
      }
      const sorted = Object.entries(entries)
        .filter(([, v]) => v && typeof v.path === 'string')
        .sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0))
        .slice(0, MEDIA_CACHE_LIMIT);
      const payload = JSON.stringify({ version: 1, entries: Object.fromEntries(sorted) }, null, 2);
      await mkdir(path.dirname(cacheFile), { recursive: true });
      const tmp = `${cacheFile}.${randomUUID()}.tmp`;
      try {
        await writeFile(tmp, payload, 'utf8');
        await rename(tmp, cacheFile);
      } finally {
        await unlink(tmp).catch(() => {});
      }
    }).catch(() => {});
  }

  function recordExport(value) {
    if (!value || typeof value !== 'object' || typeof value.source !== 'string' || !path.win32.isAbsolute(value.source)) return;
    const files = Array.isArray(value.files) ? value.files : [];
    const saved = [];
    for (const item of files) {
      if (typeof item?.sha256 !== 'string' || typeof item?.extension !== 'string') continue;
      const hashExt = `${item.sha256}${item.extension}`.toLowerCase();
      if (!/^[a-f0-9]{64}\.(?:png|jpe?g|webp|gif|pdf)$/.test(hashExt)) continue;
      hashMap.set(hashExt, value.source);
      if (remoteWorkspaceRoot && sessionId) {
        const vpsPath = path.posix.join(remoteWorkspaceRoot, '.bridge-media', sessionId, hashExt);
        exactMap.set(vpsPath, value.source);
      }
      saved.push({ hashExt, winPath: value.source });
    }
    if (saved.length > 0) persistEntries(saved);
  }

  function resolve(vpsPath) {
    if (typeof vpsPath !== 'string' || !vpsPath) return null;
    const trimmed = vpsPath.trim();
    let candidate = exactMap.get(trimmed) ?? null;
    if (!candidate) {
      const m = trimmed.match(BRIDGE_MEDIA_PATH_RE);
      if (m) candidate = hashMap.get(m[1].toLowerCase()) ?? null;
    }
    if (!candidate || !path.win32.isAbsolute(candidate)) return null;
    try {
      if (!existsCheck(candidate)) return null;
    } catch {
      return null;
    }
    return candidate;
  }

  function replaceInlineText(text) {
    if (typeof text !== 'string' || !text.includes('.bridge-media/')) return text;
    return text.replace(BRIDGE_MEDIA_INLINE_RE, (full, fileScheme, vpsPath) => {
      const mapped = resolve(vpsPath);
      if (!mapped) return full;
      const posixWin = mapped.replace(/\\/g, '/');
      return fileScheme ? `file:///${posixWin}` : posixWin;
    });
  }

  function flushPendingStreamBlocks() {
    const out = [];
    for (const state of pendingReadBlocks.values()) {
      for (const deltaFrame of state.deltas) out.push(deltaFrame);
    }
    pendingReadBlocks.clear();
    return out;
  }

  function rewriteOutgoingFrame(frame) {
    if (!frame || typeof frame !== 'object') return [frame];

    if (frame.type === 'stream_event' && frame.event && typeof frame.event === 'object') {
      const ev = frame.event;
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use' && ev.content_block?.name === 'Read') {
        if (typeof ev.content_block.id === 'string' && ev.content_block.id) {
          readToolUseIds.add(ev.content_block.id);
        }
        let nextFrame = frame;
        if (typeof ev.content_block.input?.file_path === 'string') {
          const mapped = resolve(ev.content_block.input.file_path);
          if (mapped) {
            nextFrame = {
              ...frame,
              event: {
                ...ev,
                content_block: {
                  ...ev.content_block,
                  input: { ...ev.content_block.input, file_path: mapped },
                },
              },
            };
          }
        }
        if (typeof ev.index === 'number') {
          pendingReadBlocks.set(ev.index, { partialJson: '', deltas: [] });
        }
        return [nextFrame];
      }
      if (ev.type === 'content_block_delta' && typeof ev.index === 'number' && pendingReadBlocks.has(ev.index)
          && ev.delta?.type === 'input_json_delta' && typeof ev.delta.partial_json === 'string') {
        const state = pendingReadBlocks.get(ev.index);
        state.partialJson += ev.delta.partial_json;
        state.deltas.push(frame);
        if (state.partialJson.length > 16384) {
          pendingReadBlocks.delete(ev.index);
          return state.deltas;
        }
        return [];
      }
      if (ev.type === 'content_block_stop' && typeof ev.index === 'number' && pendingReadBlocks.has(ev.index)) {
        const state = pendingReadBlocks.get(ev.index);
        pendingReadBlocks.delete(ev.index);
        let rewrittenDelta = null;
        if (state.deltas.length > 0 && state.partialJson.trim()) {
          try {
            const parsedInput = JSON.parse(state.partialJson);
            if (parsedInput && typeof parsedInput.file_path === 'string') {
              const mapped = resolve(parsedInput.file_path);
              if (mapped) {
                const base = state.deltas[0];
                rewrittenDelta = {
                  ...base,
                  event: {
                    ...base.event,
                    delta: {
                      ...base.event.delta,
                      partial_json: JSON.stringify({ ...parsedInput, file_path: mapped }),
                    },
                  },
                };
              }
            }
          } catch {
            // Fall through and flush raw deltas unchanged.
          }
        }
        return rewrittenDelta ? [rewrittenDelta, frame] : [...state.deltas, frame];
      }
      if (ev.type === 'message_stop' && pendingReadBlocks.size > 0) {
        return [...flushPendingStreamBlocks(), frame];
      }
      return [frame];
    }

    const prefix = pendingReadBlocks.size > 0 && (frame.type === 'assistant' || frame.type === 'result')
      ? flushPendingStreamBlocks()
      : [];

    if (frame.type === 'assistant' && Array.isArray(frame.message?.content)) {
      let changed = false;
      const content = frame.message.content.map(block => {
        if (!block || typeof block !== 'object') return block;
        if (block.type === 'tool_use' && block.name === 'Read') {
          if (typeof block.id === 'string' && block.id) readToolUseIds.add(block.id);
          if (typeof block.input?.file_path === 'string') {
            const mapped = resolve(block.input.file_path);
            if (mapped) {
              changed = true;
              return { ...block, input: { ...block.input, file_path: mapped } };
            }
          }
          return block;
        }
        if (block.type === 'text' && typeof block.text === 'string') {
          const replaced = replaceInlineText(block.text);
          if (replaced !== block.text) {
            changed = true;
            return { ...block, text: replaced };
          }
        }
        return block;
      });
      if (changed) {
        return [...prefix, { ...frame, message: { ...frame.message, content } }];
      }
      return [...prefix, frame];
    }

    if (frame.type === 'user') {
      let nextFrame = frame;
      const tur = frame.tool_use_result;
      if (tur && typeof tur === 'object') {
        let nextTur = tur;
        if (typeof tur.filePath === 'string') {
          const mapped = resolve(tur.filePath);
          if (mapped) nextTur = { ...nextTur, filePath: mapped };
        }
        if (tur.file && typeof tur.file === 'object') {
          let nextFile = tur.file;
          if (typeof tur.file.filePath === 'string') {
            const mapped = resolve(tur.file.filePath);
            if (mapped) nextFile = { ...nextFile, filePath: mapped };
          }
          if (typeof tur.file.file_path === 'string') {
            const mapped = resolve(tur.file.file_path);
            if (mapped) nextFile = { ...nextFile, file_path: mapped };
          }
          if (nextFile !== tur.file) nextTur = { ...nextTur, file: nextFile };
        }
        if (nextTur !== tur) nextFrame = { ...nextFrame, tool_use_result: nextTur };
      }
      if (Array.isArray(nextFrame.message?.content)) {
        let changed = false;
        const content = nextFrame.message.content.map(block => {
          if (!block || typeof block !== 'object' || block.type !== 'tool_result') return block;
          if (!readToolUseIds.has(block.tool_use_id)) return block;
          if (typeof block.content === 'string') {
            const replaced = replaceInlineText(block.content);
            if (replaced !== block.content) {
              changed = true;
              return { ...block, content: replaced };
            }
          }
          return block;
        });
        if (changed) {
          nextFrame = { ...nextFrame, message: { ...nextFrame.message, content } };
        }
      }
      return [...prefix, nextFrame];
    }

    if (frame.type === 'control_request' && frame.request?.subtype === 'can_use_tool'
        && frame.request.tool_name === 'Read' && typeof frame.request.input?.file_path === 'string') {
      const vpsPath = frame.request.input.file_path;
      const mapped = resolve(vpsPath);
      if (mapped) {
        if (typeof frame.request_id === 'string' && frame.request_id) {
          pendingApprovals.set(frame.request_id, { vpsPath, winPath: mapped });
        }
        return [...prefix, {
          ...frame,
          request: {
            ...frame.request,
            input: { ...frame.request.input, file_path: mapped },
          },
        }];
      }
    }

    return [...prefix, frame];
  }

  function rewriteIncomingFrame(msg) {
    if (!msg || typeof msg !== 'object' || msg.type !== 'control_response') return msg;
    const reqId = msg.response?.request_id;
    if (typeof reqId !== 'string' || !pendingApprovals.has(reqId)) return msg;
    const { vpsPath, winPath } = pendingApprovals.get(reqId);
    pendingApprovals.delete(reqId);

    const inner = msg.response?.response;
    if (inner?.updatedInput && typeof inner.updatedInput === 'object' && sameWinPath(inner.updatedInput.file_path, winPath)) {
      return {
        ...msg,
        response: {
          ...msg.response,
          response: {
            ...inner,
            updatedInput: { ...inner.updatedInput, file_path: vpsPath },
          },
        },
      };
    }
    if (msg.response?.updatedInput && typeof msg.response.updatedInput === 'object' && sameWinPath(msg.response.updatedInput.file_path, winPath)) {
      return {
        ...msg,
        response: {
          ...msg.response,
          updatedInput: { ...msg.response.updatedInput, file_path: vpsPath },
        },
      };
    }
    return msg;
  }

  return {
    recordExport,
    resolve,
    replaceInlineText,
    rewriteOutgoingFrame,
    rewriteIncomingFrame,
    flushPendingStreamBlocks,
    flushPersistence: () => persistChain,
  };
}

async function runOfflineSelfTest({ pure = false } = {}) {
  const hub = new LocalMcpHub();
  let rejectedBadConfig = false;
  try {
    hub.registerServers({
      bad: { type: 'unknown', endpoint: 'http://127.0.0.1:9', headers: { Authorization: 'Bearer secret' } },
    }, '/tmp/remote', process.cwd());
  } catch {
    rejectedBadConfig = true;
  }
  const rewritten = hub.registerServers({
    't3-code': { type: 'http', url: 'http://127.0.0.1:1234/mcp', headers: { Authorization: 'Bearer secret' } },
  }, '/tmp/remote', process.cwd());
  const sanitizedOk = rewritten['t3-code']?.type === 'stdio'
    && !('url' in rewritten['t3-code'])
    && !('headers' in rewritten['t3-code'])
    && !('env' in rewritten['t3-code']);
  await hub.closeAll();

  const planPolicyOk = evaluateLocalMcpToolCall({ server: 't3-code', toolName: 'pull_request_read', permissionMode: 'plan' }).allowed === true
    && evaluateLocalMcpToolCall({ server: 't3-code', toolName: 'pull_request_list', permissionMode: 'plan' }).allowed === true
    && evaluateLocalMcpToolCall({ server: 't3-code', toolName: 'ci_logs', permissionMode: 'plan' }).allowed === true
    && evaluateLocalMcpToolCall({ server: 't3-code', toolName: 'pull_request_merge', permissionMode: 'plan' }).allowed === false
    && evaluateLocalMcpToolCall({ server: 'custom', toolName: 'read_doc', permissionMode: 'plan', toolMeta: { known: true, readOnlyHint: true, destructiveHint: false } }).allowed === true
    && evaluateLocalMcpToolCall({ server: 'custom', toolName: 'write_doc', permissionMode: 'plan', toolMeta: { known: true, readOnlyHint: false, destructiveHint: true } }).allowed === false;

  const spacedPath = 'C:\\Users\\example\\t3 home\\userdata\\attachments\\screen shot (1).png';
  const extraAttachPath = 'D:\\My Attachments\\chart 2.pdf';
  const foundAttachments = findT3AttachmentPaths(
    `See "${spacedPath}" and ${extraAttachPath}`,
    { T3CODE_HOME: 'C:\\Users\\example\\t3 home', CLAUDE_VPS_ATTACHMENT_DIRS: 'D:\\My Attachments' },
    p => sameWinPath(p, spacedPath) || sameWinPath(p, extraAttachPath),
  );
  const attachmentPathsOk = foundAttachments.length === 2
    && foundAttachments.some(p => sameWinPath(p, spacedPath))
    && foundAttachments.some(p => sameWinPath(p, extraAttachPath));

  const sampleHash = 'a'.repeat(64);
  const sampleVpsPath = `/home/user/windows-local-work/.bridge-media/s1/${sampleHash}.png`;
  const sampleWinPath = 'C:\\example\\demo.png';
  const remapper = createMediaPathRemapper({
    remoteWorkspaceRoot: '/home/user/windows-local-work',
    sessionId: 's1',
    projectId: 'p1',
    existsCheck: p => p === sampleWinPath,
  });
  remapper.recordExport({ source: sampleWinPath, kind: 'image', files: [{ sha256: sampleHash, extension: '.png' }] });
  const outRead = remapper.rewriteOutgoingFrame({
    type: 'control_request',
    request_id: 'r1',
    request: { subtype: 'can_use_tool', tool_name: 'Read', input: { file_path: sampleVpsPath } },
  })[0];
  const inAllow = remapper.rewriteIncomingFrame({
    type: 'control_response',
    response: { subtype: 'success', request_id: 'r1', response: { behavior: 'allow', updatedInput: { file_path: sampleWinPath } } },
  });
  const mediaRemapOk = outRead?.request?.input?.file_path === sampleWinPath
    && inAllow?.response?.response?.updatedInput?.file_path === sampleVpsPath;

  const usageFrames = usageResponseToRateLimitEvents({
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 54, resets_at: "2026-11-23T00:30:00.376274+00:00" },
      seven_day: { utilization: 39, resets_at: "2026-11-27T10:00:00.376294+00:00" },
      seven_day_opus: { utilization: 10 },
    },
  }, "s1");
  const sentUsage = [];
  const usageSync = createUsageSync({ send: frame => { sentUsage.push(frame); return true; }, minIntervalMs: 0 });
  const syncedPromise = usageSync.fetchFrames("s1");
  const consumed = usageSync.consumeResponseLine(JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: sentUsage[0]?.request_id,
      response: { rate_limits_available: true, rate_limits: { five_hour: { utilization: 80 } } },
    },
  }));
  const syncedFrames = await syncedPromise;
  const usageSyncOk = usageFrames.length === 2
    && usageFrames[0].rate_limit_info.rateLimitType === "five_hour"
    && Math.abs(usageFrames[0].rate_limit_info.utilization - 0.54) < 1e-9
    && usageFrames[0].rate_limit_info.resetsAt === 1795393800
    && !("status" in usageFrames[0].rate_limit_info)
    && usageFrames[1].rate_limit_info.rateLimitType === "seven_day"
    && sentUsage[0]?.request?.subtype === "get_usage"
    && consumed === true
    && syncedFrames.length === 1
    && syncedFrames[0].rate_limit_info.utilization === 0.8
    && usageSync.consumeResponseLine(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "other" } })) === false
    && usageResponseToRateLimitEvents({ rate_limits_available: false }, "s1").length === 0;

  let bridge = null;
  let bridgeError = null;
  if (!pure) {
    try {
      ({ info: bridge } = await loadBridgeModules());
    } catch (err) {
      bridgeError = err?.message ?? String(err);
    }
  }

  const ok = rejectedBadConfig && sanitizedOk && planPolicyOk && attachmentPathsOk && mediaRemapOk && usageSyncOk && (pure || !bridgeError);
  process.stdout.write(`${JSON.stringify({
    ok,
    mode: pure ? 'offline-self-test-pure' : 'offline-self-test',
    shimDir,
    rejectedBadConfig,
    sanitizedOk,
    planPolicyOk,
    attachmentPathsOk,
    mediaRemapOk,
    usageSyncOk,
    bridgeVersion: bridge?.version ?? null,
    ...(bridgeError ? { bridgeError } : {}),
  })}\n`);
  if (!ok) process.exitCode = 1;
}

async function loadBridgeModules() {
  const info = await inspectBridge();
  const rt = name => pathToFileURL(path.join(info.root, 'runtime', name)).href;
  const top = name => pathToFileURL(path.join(info.root, name)).href;
  const [configMod, routesMod, workspaceMod, envMod, streamsMod, mcpRuntimeMod] = await Promise.all([
    import(rt('bridge-config.mjs')),
    import(rt('ssh-routes.mjs')),
    import(rt('workspace-runtime.mjs')),
    import(rt('project-environment.mjs')),
    import(top('transport-streams.mjs')),
    import(rt('mcp-runtime.mjs')),
  ]);
  return {
    info,
    config: configMod.getBridgeConfig(),
    SshRoutes: routesMod.SshRoutes,
    classifySshFailure: routesMod.classifySshFailure,
    workspace: workspaceMod,
    envMod,
    streams: streamsMod,
    mcpRuntime: mcpRuntimeMod,
  };
}

async function runSshOneShot(config, SshRoutes, classifySshFailure, remoteCmd, timeoutMs = 12_000) {
  const routes = new SshRoutes(config);
  return routes.firstAvailable(async r => {
    const sshArgs = r.args(remoteCmd, { connectTimeout: 10 });
    return new Promise((resolve, reject) => {
      const child = spawn(config.sshExecutable, sshArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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

async function handleVersionCheck(config, SshRoutes, classifySshFailure, { live = false } = {}) {
  if (!live) {
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

function escapeRegexLiteral(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectAttachmentRoots(env = process.env) {
  const t3Home = path.win32.resolve(env?.T3CODE_HOME || path.win32.join(os.homedir(), '.t3'));
  const roots = [path.win32.join(t3Home, 'userdata', 'attachments')];
  const extraRaw = env?.CLAUDE_VPS_ATTACHMENT_DIRS;
  if (typeof extraRaw === 'string' && extraRaw.trim()) {
    for (const part of extraRaw.split(';')) {
      const trimmed = part.trim().replace(/^"(.*)"$/, '$1');
      if (trimmed && path.win32.isAbsolute(trimmed)) {
        roots.push(path.win32.resolve(trimmed));
      }
    }
  }
  const seen = new Set();
  return roots.filter(root => {
    const key = root.replace(/[\\/]+$/, '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function findT3AttachmentPaths(text, env = process.env, existsCheck = existsSync) {
  if (!text || typeof text !== 'string') return [];
  const roots = collectAttachmentRoots(env);
  const candidates = new Set();
  for (const root of roots) {
    const cleanRoot = root.replace(/[\\/]+$/, '');
    const normRoot = cleanRoot.toLowerCase();
    const rootPattern = cleanRoot.split(/[\\/]+/).map(escapeRegexLiteral).join('[\\\\/]+');
    const re = new RegExp(
      `${rootPattern}[\\\\/][^"'` + '`' + `<>|\\r\\n]+?\\.(?:png|jpe?g|webp|gif|pdf)(?=$|[\\s"'` + '`' + `<>|)\\],;])`,
      'gi',
    );
    let match;
    while ((match = re.exec(text)) !== null) {
      const resolved = path.win32.resolve(match[0]);
      if (resolved.toLowerCase().startsWith(normRoot + path.win32.sep) && MEDIA_EXT_RE.test(resolved) && existsCheck(resolved)) {
        candidates.add(resolved);
      }
    }
  }
  return [...candidates];
}

export async function enrichUserMessage(msg, { info, sessionId, workspace, envMod }) {
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
  // Explicit HOOK_BLOCKED / blocking hook failures MUST propagate and halt submission!
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

function writeStdoutFrame(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const emptyUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: null,
  cache_creation: null,
  inference_geo: null,
  iterations: null,
  speed: null,
};

function buildAssistantFrame(text, sessionId) {
  return {
    type: 'assistant',
    message: {
      id: `msg_local_${randomUUID().slice(0, 12)}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-vps-local',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      stop_details: null,
      container: null,
      usage: emptyUsage,
    },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: randomUUID(),
  };
}

function buildErrorResultFrame(text, sessionId, userMessageId) {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 0,
    stop_reason: null,
    errors: [text],
    session_id: sessionId,
    total_cost_usd: 0,
    usage: emptyUsage,
    modelUsage: {},
    permission_denials: [],
    ...(UUID_RE.test(userMessageId ?? '') ? { user_message_uuid: userMessageId } : {}),
    uuid: randomUUID(),
  };
}

function withBoundedTimeout(promise, ms, fallbackValue) {
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallbackValue());
    }, ms);
    Promise.resolve(promise).then(
      val => { if (!settled) { settled = true; clearTimeout(timer); resolve(val); } },
      err => { if (!settled) { settled = true; clearTimeout(timer); resolve(fallbackValue(err)); } },
    );
  });
}

// get_usage reports 0-100 percentages and ISO reset times; streamed events use 0-1 and epoch seconds.
// status is omitted on purpose: T3 then only refreshes its rings and never treats a synthesized
// frame as a rejection or clears one the CLI reported itself.
export function usageResponseToRateLimitEvents(response, sessionId) {
  const limits = response?.rate_limits;
  if (!response?.rate_limits_available || !limits || typeof limits !== "object") return [];
  const frames = [];
  for (const rateLimitType of USAGE_SYNC_WINDOWS) {
    const window = limits[rateLimitType];
    if (!window || typeof window.utilization !== "number" || !Number.isFinite(window.utilization)) continue;
    const resetsMs = typeof window.resets_at === "string" ? Date.parse(window.resets_at) : NaN;
    frames.push({
      type: "rate_limit_event",
      rate_limit_info: {
        rateLimitType,
        utilization: Math.max(window.utilization, 0) / 100,
        ...(Number.isFinite(resetsMs) ? { resetsAt: Math.floor(resetsMs / 1000) } : {}),
      },
      uuid: randomUUID(),
      session_id: sessionId,
    });
  }
  return frames;
}

// Issues shim-owned get_usage control requests to the VPS CLI. Replies are matched by request ID
// before they reach the serialized stdout chain (which may be waiting on them) and never reach T3.
export function createUsageSync({
  send,
  timeoutMs = USAGE_SYNC_TIMEOUT_MS,
  minIntervalMs = USAGE_SYNC_MIN_INTERVAL_MS,
  now = Date.now,
} = {}) {
  const pending = new Map();
  let lastRequestAt = -Infinity;
  return {
    async fetchFrames(sessionId) {
      if (now() - lastRequestAt < minIntervalMs) return [];
      lastRequestAt = now();
      const requestId = `${USAGE_SYNC_REQUEST_PREFIX}${randomUUID()}`;
      while (pending.size >= USAGE_SYNC_MAX_PENDING) pending.delete(pending.keys().next().value);
      const response = await withBoundedTimeout(new Promise(resolve => {
        pending.set(requestId, resolve);
        let sent = false;
        try {
          sent = send({
            type: "control_request",
            request_id: requestId,
            request: { subtype: "get_usage", skip_behaviors: true },
          }) !== false;
        } catch {
          sent = false;
        }
        if (!sent) resolve(null);
      }), timeoutMs, () => null);
      // Keep a timed-out ID so a late reply is still swallowed instead of reaching T3.
      if (pending.get(requestId)) pending.set(requestId, null);
      return usageResponseToRateLimitEvents(response, sessionId);
    },
    consumeResponseLine(line) {
      if (typeof line !== "string" || !line.includes(USAGE_SYNC_REQUEST_PREFIX)) return false;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return false;
      }
      const id = msg?.type === "control_response" ? msg.response?.request_id : null;
      if (typeof id !== "string" || !pending.has(id)) return false;
      const resolve = pending.get(id);
      pending.delete(id);
      resolve?.(msg.response.subtype === "success" ? msg.response.response : null);
      return true;
    },
  };
}

async function listRelevantLocalJobs(workspace, info, sessionId, trackedJobIds = new Set()) {
  if (!info) return [];
  try {
    const request = {
      action: 'jobs',
      cwd: info.cwd,
      projectId: info.projectId,
      sessionId,
    };
    const jobs = workspace.listProjectJobs
      ? await workspace.listProjectJobs(request)
      : (await workspace.handle(request)).data;
    if (!Array.isArray(jobs)) return [];
    return jobs.filter(j => j && (
      trackedJobIds.has(j.requestId)
      || ACTIVE_JOB_STATUSES.has(j.status)
    ));
  } catch {
    return [];
  }
}

async function main() {
  const parsed = parseShimArgs(process.argv.slice(2));
  if (parsed.isSelfTest) {
    await runOfflineSelfTest({ pure: parsed.pureSelfTest });
    return;
  }

  const { info: bridgeInfo, config, SshRoutes, classifySshFailure, workspace, envMod, streams, mcpRuntime } = await loadBridgeModules();

  if (parsed.isVersionCheck) {
    await handleVersionCheck(config, SshRoutes, classifySshFailure, { live: parsed.liveVersionCheck });
    return;
  }

  if (parsed.invalidMcpConfigs.length > 0) {
    throw new Error(parsed.invalidMcpConfigs.join('; '));
  }

  const cwd = process.cwd();
  const hasRealDir = path.win32.isAbsolute(cwd) && (await stat(cwd).then(s => s.isDirectory(), () => false));
  // Only skip workspace binding when cwd isn't a real Windows directory or --tools "" disables all tools.
  const probeOnly = !hasRealDir || parsed.zeroTools;

  const sessionId = randomUUID();
  const t3Policy = parseT3McpPolicy(process.env);
  let info = null;
  let projectContext = '';
  let currentPermissionMode = parsed.initialPermissionMode || 'default';
  let observedClaudeMode = currentPermissionMode;
  let activeTurn = null;
  let lastClaudeSessionId = parsed.claudeSessionId ?? (parsed.resumesSession ? null : sessionId);
  let activeStopRequested = false;
  let signalStop = null;
  let pendingMcpUpdate = null;
  const pendingModes = new Map();
  const trackedJobIds = new Set();
  const localMcpHub = new LocalMcpHub();

  if (Object.keys(parsed.mcpServers).length > 0) {
    localMcpHub.registerServers(parsed.mcpServers, config.remoteRoot, cwd);
  }

  if (!probeOnly) {
    info = await workspace.projectInfo(cwd);
    await workspace.bindSession(sessionId, info, process.env.T3CODE_THREAD_ID ?? process.env.CODEX_THREAD_ID);
    await workspace.control({
      action: 'permission',
      cwd: info.cwd,
      projectId: info.projectId,
      sessionId,
      mode: currentPermissionMode,
    });
    try {
      const environment = await envMod.projectEnvironment(info.cwd);
      projectContext = await envMod.environmentContext(environment);
    } catch {
      projectContext = '';
    }
    // Surface any existing active/uncertain Windows tasks so resumed/next sessions can inspect
    // original requestIds instead of blindly replaying uncertain commands.
    const existingActiveJobs = await listRelevantLocalJobs(workspace, info, sessionId);
    if (existingActiveJobs.length > 0) {
      const summary = existingActiveJobs.map(({ requestId, status, cwd: jobCwd, startedAt }) => ({
        requestId,
        status,
        cwd: jobCwd,
        startedAt,
      }));
      const recoveryNote = `Existing local Windows tasks in this project (query these exact requestIds with windows-workspace job operation=status/output; NEVER resubmit uncertain work with a new requestId):\n${JSON.stringify(summary)}`;
      projectContext = projectContext ? `${projectContext}\n\n${recoveryNote}` : recoveryNote;
    }
  }

  const mediaRemapper = createMediaPathRemapper({
    remoteWorkspaceRoot: config.remoteWorkspaceRoot,
    sessionId,
    projectId: info?.projectId ?? '',
    cacheFile: info?.projectId ? path.join(bridgeInfo.root, 'runtime', 'state', 'media-path-cache.json') : null,
  });

  const startPayload = {
    type: 'start',
    sessionId,
    localCwd: info?.cwd ?? null,
    projectId: info?.projectId ?? null,
    workspaceInfo: info,
    args: parsed.claudeSessionId || parsed.resumesSession ? parsed.forwarded : [...parsed.forwarded, '--session-id', sessionId],
    appendSystemPrompt: parsed.appendSystemPrompt,
    extraSettings: parsed.extraSettings,
    projectContext,
    t3Mcp: Boolean(info && localMcpHub.has('t3-code')),
    localMcpServers: info ? localMcpHub.names() : [],
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

  const usageSync = createUsageSync({
    send: frame => {
      if (sshExited || !activeWriter) return false;
      sendToRelay({ type: "claude_in", line: JSON.stringify(frame) });
      return true;
    },
  });

  async function cancelTurnWindowsJobs(turnIdToCancel) {
    if (!info) return { confirmed: true, jobs: [], error: null };
    const cancelTask = (async () => {
      const states = await workspace.control({
        action: 'cancel-jobs',
        cwd: info.cwd,
        projectId: info.projectId,
        sessionId,
        ...(turnIdToCancel ? { turnId: turnIdToCancel } : {}),
      });
      const list = Array.isArray(states) ? states : [];
      return { confirmed: true, jobs: list, error: null };
    })();
    return withBoundedTimeout(
      cancelTask,
      CANCEL_WAIT_CAP_MS,
      err => ({
        confirmed: false,
        jobs: [],
        error: err?.message ?? 'Timed out waiting for Windows job cancellation confirmation',
      }),
    );
  }

  const effectiveMode = () => {
    if ([currentPermissionMode, observedClaudeMode, ...pendingModes.values()].includes('plan')) return 'plan';
    return currentPermissionMode;
  };
  const projectPermissions = async () => info ? (await envMod.projectEnvironment(info.cwd)).permissions : null;

  async function handleLocalReq(frame) {
    const { controlId, lane, request } = frame;
    try {
      if (request?.action === 'mcp') {
        if (!info) throw new Error('Local MCP requires a bound Windows project');
        if (request.sessionId && request.sessionId !== sessionId) {
          throw new Error('MCP request session binding mismatch');
        }
        if (info && request.projectId && request.projectId !== info.projectId) {
          throw new Error('MCP request project binding mismatch');
        }
        if (localMcpHub.has(request.server)) {
          const permissions = request.close || !['tools/list', 'tools/call'].includes(request.frame?.method)
            ? null : await projectPermissions();
          const value = await localMcpHub.handle(request, {
            permissionMode: effectiveMode(),
            t3Policy,
            projectPermissions: permissions,
          });
          sendToRelay({ type: 'local_reply', controlId, value });
          return;
        }
        if (request.server === 'playwright') {
          const value = await workspace.control({
            ...request,
            cwd: info.cwd,
            projectId: info.projectId,
            sessionId,
            bridgeRequestId: controlId,
          });
          sendToRelay({ type: 'local_reply', controlId, value });
          return;
        }
        throw new Error(`Local MCP server "${String(request.server ?? '')}" is not registered for this session`);
      }

      if (request?.action === 'preflight' && request.request?.action === 'mcp-call') {
        const tool = resolveLocalMcpTool(localMcpHub.names(), request.request.tool);
        if (tool) {
          if (PERMISSION_MODES.has(request.permissionMode)) observedClaudeMode = request.permissionMode;
          const permissions = await projectPermissions();
          const decision = evaluateLocalMcpToolCall({
            ...tool,
            permissionMode: effectiveMode(),
            t3Policy,
            projectPermissions: permissions,
            toolMeta: localMcpHub.getToolMetaAcrossConnections(tool.server, tool.toolName),
          });
          const value = decision.allowed
            ? (decision.approval ? { decision: 'ask', reason: decision.approval } : { decision: 'inherit' })
            : { decision: 'deny', reason: decision.reason };
          sendToRelay({ type: 'local_reply', controlId, value });
          return;
        }
      }

      if (!info) throw new Error('Local workspace is not bound for probe-only session');
      const boundReq = {
        ...request,
        cwd: info.cwd,
        projectId: info.projectId,
        sessionId,
        bridgeRequestId: controlId,
      };
      if ((boundReq.action === 'run' || boundReq.action === 'job') && typeof boundReq.requestId === 'string' && boundReq.requestId) {
        trackedJobIds.add(boundReq.requestId);
      }
      if (boundReq.action === 'run' && (!activeTurn || activeTurn.cancel)) {
        throw new Error('The current turn is stopping; no Windows job was submitted');
      }
      let value;
      if (lane === 'tool' && request?.action !== 'media-export') {
        value = await workspace.handle(boundReq, { signal: activeTurn?.controller.signal });
      } else {
        value = await workspace.control(boundReq);
        if (request?.action === 'media-export') {
          mediaRemapper.recordExport(value);
        }
      }
      if (value?.data?.requestId && typeof value.data.requestId === 'string') {
        trackedJobIds.add(value.data.requestId);
      }
      sendToRelay({ type: 'local_reply', controlId, value });
    } catch (err) {
      sendToRelay({ type: 'local_reply', controlId, error: err?.message ?? 'Local Windows operation failed' });
    }
  }

  // Serialize outgoing stdout frames so interrupt cancellation confirmation can be attached
  // right before the turn-ending result frame without reordering stream events.
  let stdoutChain = Promise.resolve();
  const enqueueClaudeOut = line => {
    stdoutChain = stdoutChain.then(async () => {
      let parsedOut = null;
      try {
        parsedOut = JSON.parse(line);
      } catch {
        process.stdout.write(`${line}\n`);
        return;
      }
      if (typeof parsedOut?.session_id === 'string' && parsedOut.session_id) {
        lastClaudeSessionId = parsedOut.session_id;
      }
      if (parsedOut?.type === 'system' && parsedOut.subtype === 'init' && typeof parsedOut.permissionMode === 'string') {
        observedClaudeMode = parsedOut.permissionMode;
      }
      if (parsedOut?.type === 'control_response') {
        const response = parsedOut.response;
        if (response && pendingModes.has(response.request_id)) {
          const mode = pendingModes.get(response.request_id);
          pendingModes.delete(response.request_id);
          if (response.subtype === 'success') {
            currentPermissionMode = mode;
            observedClaudeMode = mode;
            if (info) {
              await workspace.control({ action: 'permission', cwd: info.cwd, projectId: info.projectId, sessionId, mode })
                .catch(err => process.stderr.write(`Local workspace mode update failed: ${err.message}\n`));
            }
          }
        }
        if (pendingMcpUpdate && response?.request_id === pendingMcpUpdate.id) {
          pendingMcpUpdate.finish(response?.subtype === 'success');
          pendingMcpUpdate = null;
        }
      }
      const echoedPrompts = parsedOut?.user_message_uuids ?? [parsedOut?.user_message_uuid].filter(Boolean);
      if (parsedOut?.type === 'result' && parsedOut.origin?.kind !== 'task-notification'
          && (!activeTurn || !echoedPrompts.length || echoedPrompts.some(id => activeTurn.promptIds.has(id)))) {
        const turn = activeTurn;
        if (turn?.cancel) {
          const outcome = await turn.cancel;
          if (!outcome.confirmed) {
            const liveJobs = await withBoundedTimeout(listRelevantLocalJobs(workspace, info, sessionId, trackedJobIds), 1000, () => []);
            const idList = liveJobs.map(j => `${j.requestId}(${j.status})`).join(', ') || [...trackedJobIds].join(', ') || 'unknown';
            const warnText = `[Windows 任务停止未确认] ${outcome.error}。请通过 windows-workspace job (operation=status/output) 查询原任务状态（${idList}），禁止使用新 requestId 盲目重放。`;
            process.stderr.write(`${warnText}\n`);
            writeStdoutFrame(buildAssistantFrame(warnText, lastClaudeSessionId ?? sessionId));
          } else if (outcome.jobs.some(job => job.status === 'cancelled')) {
            const summary = outcome.jobs.filter(job => job.status === 'cancelled').map(j => `${j.requestId}(${j.status})`).join(', ');
            const okText = `[Windows 任务已停止] 已确认停止本轮 Windows 后台任务：${summary}。`;
            process.stderr.write(`${okText}\n`);
            writeStdoutFrame(buildAssistantFrame(okText, lastClaudeSessionId ?? sessionId));
          }
        }
        // Emitted before the result so T3 applies it to the live turn rather than buffering a wake.
        if (turn && !turn.cancel && !probeOnly) {
          for (const usageFrame of await usageSync.fetchFrames(lastClaudeSessionId ?? sessionId)) {
            writeStdoutFrame(usageFrame);
          }
        }
        if (activeTurn === turn) activeTurn = null;
      }
      const outFrames = mediaRemapper.rewriteOutgoingFrame(parsedOut);
      for (const outFrame of outFrames) {
        if (outFrame === parsedOut) process.stdout.write(`${line}\n`);
        else writeStdoutFrame(outFrame);
      }
    }).catch(() => {});
  };

  // Start reading T3 SDK stdin immediately (serialized FIFO) so early initialize / mcp_set_servers
  // frames are buffered safely even while multi-route SSH failover runs.
  let stdinChain = Promise.resolve();
  const stdinRl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  function startCancellingTurn() {
    if (info && activeTurn && !activeTurn.cancel) {
      activeTurn.controller.abort();
      activeTurn.cancel = cancelTurnWindowsJobs(activeTurn.id);
    }
    return activeTurn?.cancel;
  }
  function respondControlError(requestId, error) {
    stdoutChain = stdoutChain.then(() => writeStdoutFrame({
      type: 'control_response',
      response: { subtype: 'error', request_id: requestId, error },
    }));
  }
  stdinRl.on('line', line => {
    stdinChain = stdinChain.then(async () => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        process.stderr.write('Ignored invalid JSON from Claude Agent SDK input\n');
        return;
      }

      if (msg?.type === 'user') {
        const replySessionId = () => lastClaudeSessionId || (UUID_RE.test(msg.session_id ?? '') ? msg.session_id : sessionId);
        if (info) {
          try {
            msg = await enrichUserMessage(msg, { info, sessionId, workspace, envMod });
            if (sshExited || activeStopRequested) return;
            if (!activeTurn) {
              const id = randomUUID();
              await workspace.setTurn(sessionId, id);
              if (sshExited || activeStopRequested) return;
              activeTurn = { id, userMessageId: msg.uuid, promptIds: new Set(), controller: new AbortController() };
            }
          } catch (err) {
            const codeLabel = err?.code || 'HOOK_BLOCKED';
            const reasonText = `本地 Hook 阻止了本次提交（${codeLabel}）：${err?.message ?? 'Blocked by local workspace hook'}。消息未发送至 VPS，你可以修改输入后继续对话。`;
            process.stderr.write(`${reasonText}\n`);
            stdoutChain = stdoutChain.then(() => {
              const id = replySessionId();
              writeStdoutFrame(buildAssistantFrame(reasonText, id));
              if (!activeTurn) writeStdoutFrame(buildErrorResultFrame(reasonText, id, msg.uuid));
              else if (UUID_RE.test(msg.uuid ?? '')) {
                writeStdoutFrame({ type: 'command_lifecycle', command_uuid: msg.uuid, state: 'refused', session_id: id, uuid: randomUUID() });
              }
            });
            return;
          }
        }
        activeTurn ??= { id: randomUUID(), userMessageId: msg.uuid, promptIds: new Set(), controller: new AbortController() };
        if (msg.uuid) activeTurn.promptIds.add(msg.uuid);
        sendToRelay({ type: 'claude_in', line: JSON.stringify(msg) });
        return;
      }

      if (msg?.type === 'control_request' && msg.request?.subtype === 'set_permission_mode') {
        if (!PERMISSION_MODES.has(msg.request.mode) || typeof msg.request_id !== 'string') {
          respondControlError(msg.request_id, 'Invalid Claude permission mode request');
          return;
        }
        pendingModes.set(msg.request_id, msg.request.mode);
        sendToRelay({ type: 'claude_in', line });
        return;
      }

      if (msg?.type === 'control_request' && msg.request?.subtype === 'mcp_set_servers') {
        try {
          if (typeof msg.request_id !== 'string' || !msg.request_id) throw new Error('Missing MCP control request ID');
          if (pendingMcpUpdate) throw new Error('An MCP server update is already in progress');
          if (probeOnly && Object.keys(msg.request.servers ?? {}).length) throw new Error('Local MCP requires a bound Windows project');
          const update = localMcpHub.stageServers(msg.request.servers, config.remoteRoot, info?.cwd ?? cwd);
          pendingMcpUpdate = { ...update, id: msg.request_id };
          sendToRelay({
            type: 'claude_in',
            line: JSON.stringify({
              type: 'control_request',
              request_id: msg.request_id,
              request: { subtype: 'mcp_set_servers', servers: update.servers },
            }),
          });
        } catch (err) {
          const errMsg = err?.message ?? 'Invalid local MCP server configuration';
          process.stderr.write(`Rejected mcp_set_servers: ${errMsg}\n`);
          respondControlError(msg.request_id, errMsg);
        }
        return;
      }

      if (msg?.type === 'control_request' && msg.request?.subtype === 'interrupt') {
        startCancellingTurn();
        sendToRelay({ type: 'claude_in', line });
        return;
      }

      if (msg?.type === 'control_request' && msg.request?.subtype === 'initialize' && hasLocalConfig(msg.request)) {
        respondControlError(msg.request_id, 'initialize contains local-only MCP or environment configuration');
        return;
      }
      const forwardedMsg = mediaRemapper.rewriteIncomingFrame(msg);
      sendToRelay({ type: 'claude_in', line: forwardedMsg === msg ? line : JSON.stringify(forwardedMsg) });
    }).catch(err => {
      process.stderr.write(`Claude VPS shim stdin processing error: ${err?.message ?? err}\n`);
    });
  });
  stdinRl.on('close', () => {
    stdinChain = stdinChain.then(() => {
      activeStopRequested = true;
      sendToRelay({ type: 'stop' });
    });
  });

  const cleanup = async (code, { unexpectedDisconnect = false } = {}) => {
    if (sshExited) return;
    sshExited = true;

    await stdoutChain.catch(() => {});
    for (const trailing of mediaRemapper.flushPendingStreamBlocks()) {
      writeStdoutFrame(trailing);
    }
    await mediaRemapper.flushPersistence().catch(() => {});
    if (activeTurn?.cancel) await activeTurn.cancel;
    if (unexpectedDisconnect && (activeTurn || trackedJobIds.size > 0)) {
      const liveJobs = await withBoundedTimeout(listRelevantLocalJobs(workspace, info, sessionId, trackedJobIds), 2000, () => []);
      const jobText = liveJobs.length > 0
        ? liveJobs.map(j => `${j.requestId} (status=${j.status})`).join(', ')
        : ([...trackedJobIds].join(', ') || '无运行中任务记录');
      const recoveryMsg = `SSH 连接意外中断，当前轮次结果未知。Windows 本机任务已保留原 ID：${jobText}。重新连接后请先通过 windows-workspace job (operation=status/output) 查询原任务结果，严禁使用新 requestId 盲目重放。`;
      process.stderr.write(`${recoveryMsg}\n`);
      if (activeTurn) {
        writeStdoutFrame(buildAssistantFrame(recoveryMsg, lastClaudeSessionId ?? sessionId));
        writeStdoutFrame(buildErrorResultFrame(recoveryMsg, lastClaudeSessionId ?? sessionId, activeTurn.userMessageId));
      }
    }
    activeTurn = null;
    pendingMcpUpdate?.finish(false);
    pendingMcpUpdate = null;
    try { mcpRuntime?.closeMcpSession?.(sessionId); } catch {}
    await localMcpHub.closeAll().catch(() => {});
    await withBoundedTimeout(new Promise(resolve => process.stdout.write('', resolve)), 1000, () => {});
    process.exit(signalStop ? 130 : code);
  };

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      if (signalStop) return;
      activeStopRequested = true;
      const cancellation = startCancellingTurn();
      signalStop = (async () => {
        const outcome = await cancellation;
        if (outcome && !outcome.confirmed) process.stderr.write(`[Windows 任务停止未确认] ${outcome.error}\n`);
        try { activeSsh?.kill(); } catch {}
        await cleanup(130);
      })();
      sendToRelay({ type: 'stop' });
    });
  }

  const routes = new SshRoutes(config);
  const remoteNode = config.remoteNodeExecutable || 'node';
  const relayScript = `${config.remoteRoot}/claude-stream-relay.mjs`;
  const remoteCmd = `${shellQuote(remoteNode)} ${shellQuote(relayScript)}`;

  const connected = await routes.firstAvailable(async route => {
    const sshArgs = route.args(remoteCmd, { connectTimeout: 12, keepAlive: true });
    return new Promise((resolve, reject) => {
      const child = spawn(config.sshExecutable, sshArgs, {
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
          if (!usageSync.consumeResponseLine(frame.line)) enqueueClaudeOut(frame.line);
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
          void cleanup(1, { unexpectedDisconnect: !activeStopRequested });
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
          const unexpectedDisconnect = !activeStopRequested && (remoteExitCode === null || (code !== 0 && activeTurn));
          void cleanup(remoteExitCode !== null ? remoteExitCode : (code ?? 1), { unexpectedDisconnect });
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
