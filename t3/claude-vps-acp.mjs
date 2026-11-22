import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectBridge } from './bridge-installation.mjs';
import { evaluateLocalMcpToolCall, isLocalMcpServerName, normalizeMcpName, resolveLocalMcpTool } from './mcp-policy.mjs';
import {
  ADAPTER_VERSION,
  AVAILABLE_COMMANDS,
  DEFAULT_MODEL_ID,
  accumulateTurnUsage,
  buildAvailableCommands,
  buildQuestionElicitation,
  buildSessionConfiguration,
  buildUsageUpdate,
  convertPromptBlocks,
  extractFileChangePresentation,
  extractPlanEntries,
  extractSessionTitle,
  extractSlashCommand,
  findCatalogModel,
  formatPercent,
  formatPromptResponseUsage,
  formatStatusReport,
  formatUsageReport,
  mapElicitationAnswers,
  parseT3McpPolicy,
  parseWorkspaceCommand,
  pickValidThinkingId,
  presentWorkspaceToolCall,
  resolveThinkingOptionsForModel,
} from './acp-helpers.mjs';

const localMcpClientUrl = new URL('./http-mcp-client.mjs', import.meta.url);
const { LocalMcpHub } = await import(existsSync(localMcpClientUrl) ? localMcpClientUrl : new URL('../t3-native/http-mcp-client.mjs', import.meta.url));
const stateDir = fileURLToPath(new URL('./sessions/', import.meta.url));
const UUID_RE = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const BRIDGE_NOTICE_PREFIXES = [
  'bridge-link-',
  'windows-context-',
  'windows-cancel-',
  'windows-stop-hook-',
  'windows-presentation-warning-',
];

const sessions = new Map();
const pendingRequests = new Map();
const processAbort = new AbortController();
const mcpConnections = new Map();
const mcpConnecting = new Map();
const mcpPolicy = parseT3McpPolicy();
const clientCaps = {
  elicitationForm: false,
  compaction: false,
  notices: false,
  clientName: '',
};

function resolveSessionForMcp(request) {
  if (typeof request?.acpSessionId !== 'string' || !request.acpSessionId) return null;
  return sessions.get(request.acpSessionId) ?? null;
}

function isMcpConnectionError(err) {
  const msg = String(err?.message ?? '');
  return /unknown mcp-over-acp connection|disconnected|stopped|http 404|http 400|socket|connection/i.test(msg);
}

async function ensureT3McpConnection(localConnId, request, session) {
  const existing = mcpConnections.get(localConnId);
  if (existing) return existing;
  const inflight = mcpConnecting.get(localConnId);
  if (inflight) return inflight;
  const task = (async () => {
    const serverId = session.acpMcpServers.get(request.server);
    const connected = await askClient('mcp/connect', { serverId }, processAbort.signal);
    if (typeof connected?.connectionId !== 'string' || !connected.connectionId) {
      throw new Error('T3 Code MCP connect did not return a connectionId');
    }
    const entry = {
      acpConnId: connected.connectionId,
      bridgeSessionId: request.sessionId,
      acpSessionId: session?.id ?? request.acpSessionId ?? null,
      serverId,
    };
    mcpConnections.set(localConnId, entry);
    if (request.server === 't3-code') {
      session.t3Mcp.connected = true;
      session.t3Mcp.lastError = null;
    }
    return entry;
  })().finally(() => {
    mcpConnecting.delete(localConnId);
  });
  mcpConnecting.set(localConnId, task);
  return task;
}

async function disconnectT3McpConnection(localConnId) {
  const inflight = mcpConnecting.get(localConnId);
  if (inflight) await inflight.catch(() => {});
  const entry = mcpConnections.get(localConnId);
  if (!entry) return;
  mcpConnections.delete(localConnId);
  if (!processAbort.signal.aborted) {
    await withTimeout(
      askClient('mcp/disconnect', { connectionId: entry.acpConnId }, processAbort.signal),
      3000,
    ).catch(() => {});
  }
}

async function handleT3McpRequest(request) {
  const session = resolveSessionForMcp(request);
  if (!session) throw new Error('Unknown or unauthorized T3 MCP session');
  const permissions = async () => {
    if (!loadProjectEnvironment) throw new Error('Local MCP project policy is unavailable');
    return (await loadProjectEnvironment(session.cwd)).permissions;
  };
  if (request.action === 'preflight') {
    const tool = resolveLocalMcpTool(session.mcpNames, request.request?.tool);
    if (!tool) return { decision: 'deny', reason: 'Local MCP server is not registered for this session' };
    const decision = evaluateLocalMcpToolCall({
      ...tool, t3Policy: mcpPolicy, projectPermissions: await permissions(),
    });
    if (!decision.allowed) return { decision: 'deny', reason: decision.reason };
    if (request.permissionMode) session.mcpPermissionMode = request.permissionMode;
    return decision.approval ? { decision: 'ask', reason: decision.approval } : { decision: 'inherit' };
  }
  const localConnId = request.connectionId;
  if (typeof localConnId !== 'string' || !localConnId) {
    throw new Error('Missing MCP connectionId');
  }
  const frame = request.frame;
  const currentMode = () => session.currentPermissionModeId === 'plan' || session.mcpPermissionMode === 'plan'
    ? 'plan' : session.currentPermissionModeId ?? session.mcpPermissionMode ?? 'plan';
  const permissionMode = currentMode();
  let projectPermissions = request.close || !['tools/list', 'tools/call'].includes(frame?.method) ? null : await permissions();
  if (session.localMcpHub.has(request.server)) {
    return session.localMcpHub.handle(request, { permissionMode, t3Policy: mcpPolicy, projectPermissions });
  }
  if (!session.acpMcpServers.has(request.server)) throw new Error('Local MCP server is not registered for this session');
  const connectionKey = JSON.stringify([session.id, request.server, localConnId]);
  if (request.close) {
    await disconnectT3McpConnection(connectionKey);
    session.mcpCatalogs.delete(connectionKey);
    return {};
  }
  if (!frame || typeof frame !== 'object' || typeof frame.method !== 'string') {
    throw new Error('Invalid MCP JSON-RPC frame');
  }
  if (frame.method === 'initialize') session.mcpCatalogs.delete(connectionKey);
  const isNotification = frame.id === undefined || frame.id === null;
  const decide = (toolName, mode) => evaluateLocalMcpToolCall({
    server: request.server, toolName, permissionMode: mode, t3Policy: mcpPolicy, projectPermissions,
    toolMeta: session.mcpCatalogs.get(connectionKey)?.get(toolName),
  });
  if (frame.method === 'tools/call') {
    const decision = decide(frame.params?.name, permissionMode);
    if (!decision.allowed) {
      return {
        jsonrpc: '2.0',
        id: frame.id,
        error: {
          code: -32602,
          message: decision.reason,
        },
      };
    }
  }
  try {
    const entry = await ensureT3McpConnection(connectionKey, request, session);
    if (frame.method === 'tools/call') {
      projectPermissions = await permissions();
      const latest = decide(frame.params.name, currentMode());
      if (!latest.allowed) return { jsonrpc: '2.0', id: frame.id, error: { code: -32602, message: latest.reason } };
    }
    const payload = {
      connectionId: entry.acpConnId,
      method: frame.method,
      ...(frame.params !== undefined ? { params: frame.params } : {}),
    };
    if (isNotification) {
      send({ method: 'mcp/notification', params: payload });
      return {};
    }
    let result = await askClient('mcp/message', payload, processAbort.signal);
    if (frame.method === 'tools/list' && Array.isArray(result?.tools)) {
      const catalog = (frame.params?.cursor && session.mcpCatalogs.get(connectionKey)) || new Map();
      for (const tool of result.tools) {
        if (typeof tool?.name !== 'string') continue;
        catalog.set(tool.name, {
          known: true,
          readOnlyHint: tool.annotations?.readOnlyHint === true,
          destructiveHint: tool.annotations?.destructiveHint !== undefined && tool.annotations.destructiveHint !== false,
        });
      }
      session.mcpCatalogs.set(connectionKey, catalog);
      const filteredTools = result.tools.filter(tool => decide(tool?.name, 'default').allowed);
      result = { ...result, tools: filteredTools };
      if (request.server === 't3-code') {
        session.t3Mcp.connected = true;
        session.t3Mcp.toolCount = filteredTools.length;
      }
    }
    if (request.server === 't3-code') session.t3Mcp.lastError = null;
    return { jsonrpc: '2.0', id: frame.id, result: result ?? {} };
  } catch (err) {
    if (isMcpConnectionError(err)) {
      mcpConnections.delete(connectionKey);
      session.mcpCatalogs.delete(connectionKey);
      if (request.server === 't3-code') session.t3Mcp.connected = false;
    }
    if (request.server === 't3-code') session.t3Mcp.lastError = err?.message ?? 'T3 MCP request failed';
    if (isNotification) return {};
    return {
      jsonrpc: '2.0',
      id: frame.id,
      error: { code: -32603, message: err?.message ?? 'T3 MCP request failed' },
    };
  }
}

function closeT3McpForSession(bridgeSessionId) {
  const targets = [];
  for (const [localConnId, entry] of mcpConnections.entries()) {
    if (entry.bridgeSessionId === bridgeSessionId) targets.push(localConnId);
  }
  for (const localConnId of targets) {
    void disconnectT3McpConnection(localConnId);
  }
}

async function closeAllT3Mcp() {
  const ids = [...mcpConnections.keys()];
  await Promise.allSettled(ids.map(id => disconnectT3McpConnection(id)));
}

async function loadBridge(bridgeContext) {
  const info = await inspectBridge();
  const { root, entry } = info;
  // The installation stamp belongs to the CodexHost background process.
  const activation = pathToFileURL(path.join(root, 'runtime', 'activation.mjs')).href;
  const hook = registerHooks({
    load(url, context, nextLoad) {
      if (url === activation) {
        return { format: 'module', shortCircuit: true, source: 'export async function recordLoadedInstall() {}' };
      }
      return nextLoad(url, context);
    },
  });
  try {
    const { createHarnessAdapter } = await import(pathToFileURL(entry));
    let loadProjectEnvironment = null;
    try {
      const envMod = await import(pathToFileURL(path.join(root, 'runtime', 'project-environment.mjs')));
      if (typeof envMod?.projectEnvironment === 'function') {
        loadProjectEnvironment = envMod.projectEnvironment;
      }
    } catch {
      // Optional: local skills/commands autocomplete degrades cleanly if unavailable.
    }
    return { adapter: createHarnessAdapter(bridgeContext), info, loadProjectEnvironment };
  } finally {
    hook.deregister();
  }
}

const { adapter: bridge, info: bridgeInfo, loadProjectEnvironment } = await loadBridge({
  onMcpRequest: handleT3McpRequest,
  onMcpSessionClosed: closeT3McpForSession,
});

const text = value => ({ type: 'text', text: value });
const send = value => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
const error = (code, message) => Object.assign(new Error(message), { rpcCode: code });
const unwrap = result => {
  if (!result?.ok) throw new Error(result?.error?.message ?? 'Claude VPS Bridge request failed');
  return result.value;
};

function update(session, value) {
  send({ method: 'session/update', params: { sessionId: session.id, update: value } });
}

function askClient(method, params, signal) {
  signal.throwIfAborted();
  const id = `bridge-${randomUUID()}`;
  const { promise, resolve, reject } = Promise.withResolvers();
  const abort = () => reject(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  pendingRequests.set(id, { resolve, reject });
  send({ id, method, params });
  return promise.finally(() => {
    pendingRequests.delete(id);
    signal.removeEventListener('abort', abort);
  });
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Operation timed out')), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function sessionFile(id) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw error(-32602, 'Invalid Claude VPS session ID');
  }
  return path.join(stateDir, `${id}.json`);
}

function isProbeClient() {
  return clientCaps.clientName === 't3-code-provider-test';
}

async function renameWithRetry(src, dest) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await rename(src, dest);
      return;
    } catch (err) {
      if ((err.code === 'EPERM' || err.code === 'EBUSY') && attempt < 3) {
        await new Promise(r => setTimeout(r, 20 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

function persistSession(session) {
  if (!session.nativeRef || isProbeClient() || session.closing) return Promise.resolve();
  const task = (session.persistQueue ?? Promise.resolve()).then(async () => {
    if (!session.nativeRef || isProbeClient() || session.closing) return;
    const record = {
      sessionId: session.id,
      cwd: session.cwd,
      nativeRef: session.nativeRef,
      ...(session.currentModelId ? { modelId: session.currentModelId } : {}),
      ...(session.currentThinkingId ? { thinkingOptionId: session.currentThinkingId } : {}),
      ...(session.currentPermissionModeId ? { permissionModeId: session.currentPermissionModeId } : {}),
      ...(session.lastCheckpoint ? { lastCheckpoint: session.lastCheckpoint } : {}),
      ...(session.title ? { title: session.title } : {}),
      updatedAt: new Date().toISOString(),
    };
    const signature = JSON.stringify({
      cwd: record.cwd,
      nativeRef: record.nativeRef,
      modelId: record.modelId,
      thinkingOptionId: record.thinkingOptionId,
      permissionModeId: record.permissionModeId,
      lastCheckpoint: record.lastCheckpoint,
      title: record.title,
    });
    if (signature === session.savedSignature) return;
    const target = sessionFile(session.id);
    const temp = `${target}.${randomUUID()}.tmp`;
    await mkdir(stateDir, { recursive: true });
    try {
      await writeFile(temp, JSON.stringify(record), { flag: 'wx' });
      await renameWithRetry(temp, target);
      session.savedSignature = signature;
    } finally {
      await rm(temp, { force: true });
    }
  });
  session.persistQueue = task.catch(() => {});
  return task;
}

async function readSavedSession(id) {
  const file = sessionFile(id);
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw error(-32602, `Saved Claude VPS session not found: ${id}`);
    throw err;
  }
  return JSON.parse(raw);
}

function getSession(id) {
  const session = sessions.get(id);
  if (!session?.native) throw error(-32602, 'Claude VPS session is not open');
  return session;
}

let inspectionPromise;
function getInspection(refresh = false) {
  if (refresh || !inspectionPromise) {
    inspectionPromise = bridge.inspect({ refresh }).then(result => {
      if (result?.status === 'unavailable') {
        inspectionPromise = null;
      }
      return result ?? {};
    }).catch(err => {
      inspectionPromise = null;
      throw err;
    });
  }
  return inspectionPromise;
}

function emitUsageIfChanged(session, usage) {
  const payload = buildUsageUpdate(usage);
  if (!payload) return;
  const key = JSON.stringify(payload);
  if (key === session.lastUsageKey) return;
  session.lastUsageKey = key;
  update(session, payload);
}

function maybeEmitQuotaNotice(session, usage) {
  if (!clientCaps.notices || !usage || typeof usage !== 'object') return;
  const warnings = [];
  if (typeof usage.planFiveHourUsedPercent === 'number' && usage.planFiveHourUsedPercent >= 90 && !session.warnedFiveHour) {
    session.warnedFiveHour = true;
    warnings.push(`5 小时窗口额度已达 ${formatPercent(usage.planFiveHourUsedPercent)}`);
  }
  if (typeof usage.planSevenDayUsedPercent === 'number' && usage.planSevenDayUsedPercent >= 90 && !session.warnedSevenDay) {
    session.warnedSevenDay = true;
    warnings.push(`7 天窗口额度已达 ${formatPercent(usage.planSevenDayUsedPercent)}`);
  }
  if (warnings.length) {
    update(session, {
      sessionUpdate: 'notice',
      severity: 'warning',
      title: 'Claude 额度提醒',
      description: `${warnings.join('；')}。可输入 /usage 查看详细重置时间。`,
    });
  }
}

async function syncSessionState(session, state) {
  if (!state || typeof state !== 'object') return;
  const inspection = await getInspection().catch(() => ({}));
  let configChanged = false;
  let modeChanged = false;

  if (state.nativeRef) {
    session.nativeRef = state.nativeRef;
  }
  if (typeof state.effectiveModel?.id === 'string' && state.effectiveModel.id !== session.currentModelId) {
    session.currentModelId = state.effectiveModel.id;
    const catalogModel = findCatalogModel(inspection, session.currentModelId);
    session.availableThinkingOptions = resolveThinkingOptionsForModel(catalogModel, inspection, state.availableThinkingOptions);
    configChanged = true;
  }
  if (typeof state.resolvedModelLabel === 'string' && state.resolvedModelLabel !== session.resolvedModelLabel) {
    session.resolvedModelLabel = state.resolvedModelLabel;
  }
  if (Array.isArray(state.availableThinkingOptions) && state.availableThinkingOptions.length > 0) {
    const catalogModel = findCatalogModel(inspection, session.currentModelId);
    const nextThinkingOptions = resolveThinkingOptionsForModel(catalogModel, inspection, state.availableThinkingOptions);
    if (JSON.stringify(nextThinkingOptions) !== JSON.stringify(session.availableThinkingOptions)) {
      session.availableThinkingOptions = nextThinkingOptions;
      configChanged = true;
    }
  }
  if (typeof state.effectiveThinkingOptionId === 'string' && state.effectiveThinkingOptionId !== session.currentThinkingId) {
    session.currentThinkingId = state.effectiveThinkingOptionId;
    configChanged = true;
  }
  if (typeof state.effectivePermissionModeId === 'string' && state.effectivePermissionModeId !== session.currentPermissionModeId) {
    session.currentPermissionModeId = state.effectivePermissionModeId;
    session.mcpPermissionMode = undefined;
    configChanged = true;
    modeChanged = true;
  }

  await persistSession(session);

  if (session.initialized) {
    if (configChanged) {
      const { configOptions } = buildSessionConfiguration(session, inspection);
      update(session, { sessionUpdate: 'config_option_update', configOptions });
    }
    if (modeChanged && session.currentPermissionModeId) {
      update(session, { sessionUpdate: 'current_mode_update', currentModeId: session.currentPermissionModeId });
    }
  }
}

function toolTitle(item) {
  if (item.type === 'subagentDelegation') {
    const first = Array.isArray(item.subagents) ? item.subagents[0] : null;
    return first?.description ?? first?.title ?? item.title ?? 'Subagent';
  }
  return item.command ?? item.toolName ?? item.tool ?? item.type;
}

function toolKind(item) {
  const name = String(toolTitle(item)).toLowerCase();
  if (item.type === 'commandExecution' || /(?:^|_)run$/.test(name)) return 'execute';
  if (item.type === 'fileChange' || /(?:^|_)(?:edit|write)$/.test(name)) return 'edit';
  if (item.type === 'contextCompaction') return 'think';
  if (item.type === 'webSearch' || /(?:^|_)(?:search|glob|grep|web)/.test(name)) return 'search';
  if (/(?:^|_)read$/.test(name)) return 'read';
  return 'other';
}

function toolLocations(item) {
  const args = item?.arguments;
  if (!args || typeof args !== 'object') return undefined;
  const candidate = args.path ?? args.filePath ?? args.file_path;
  if (typeof candidate === 'string' && candidate.trim()) {
    return [{ path: candidate.trim() }];
  }
  return undefined;
}

function toolContent(item) {
  const output = typeof item.output === 'string'
    ? [text(item.output)]
    : (item.output?.content ?? []).filter(block => block.type === 'text');
  return output.filter(block => block.text).map(content => ({ type: 'content', content }));
}

function isBridgeNoticeItem(item) {
  return item.type === 'agentMessage'
    && item.phase === 'commentary'
    && typeof item.itemId === 'string'
    && BRIDGE_NOTICE_PREFIXES.some(prefix => item.itemId.startsWith(prefix));
}

function displayItem(session, turn, item, outcome) {
  const previous = turn.items.get(item.itemId);

  if (item.type === 'contextCompaction') {
    if (clientCaps.compaction) {
      const status = outcome
        ? (outcome.status === 'succeeded' ? 'completed' : outcome.status === 'cancelled' ? 'cancelled' : 'failed')
        : 'in_progress';
      update(session, {
        sessionUpdate: 'compaction_update',
        compactionId: item.itemId,
        status,
        ...(outcome?.error?.message ? { error: outcome.error.message } : {}),
      });
    } else {
      const status = outcome ? (outcome.status === 'succeeded' ? 'completed' : 'failed') : 'in_progress';
      update(session, {
        sessionUpdate: previous ? 'tool_call_update' : 'tool_call',
        toolCallId: item.itemId,
        title: 'Compact context',
        kind: 'think',
        status,
      });
    }
    turn.items.set(item.itemId, { ...item, finished: Boolean(outcome) });
    return;
  }

  if (isBridgeNoticeItem(item) && clientCaps.notices) {
    if (outcome && item.text?.trim()) {
      const isWarning = item.itemId.startsWith('bridge-link-') || item.itemId.includes('warning') || item.itemId.includes('hook');
      update(session, {
        sessionUpdate: 'notice',
        severity: isWarning ? 'warning' : 'info',
        title: 'Claude VPS Bridge',
        description: item.text.trim(),
      });
    }
    turn.items.set(item.itemId, { ...item, finished: Boolean(outcome) });
    return;
  }

  if (item.type === 'agentMessage' || item.type === 'reasoning') {
    const shown = previous?.text ?? '';
    const suffix = item.text?.startsWith(shown) ? item.text.slice(shown.length) : (!shown && item.text ? item.text : '');
    if (suffix) {
      const sessionUpdate = item.type === 'reasoning' ? 'agent_thought_chunk' : 'agent_message_chunk';
      update(session, { sessionUpdate, content: text(suffix) });
    }
  } else if (item.type === 'fileChange') {
    const status = outcome ? (outcome.status === 'succeeded' ? 'completed' : 'failed') : 'in_progress';
    const { title, locations, content } = extractFileChangePresentation(item, session.cwd);
    update(session, {
      sessionUpdate: previous ? 'tool_call_update' : 'tool_call',
      toolCallId: item.itemId,
      title,
      kind: 'edit',
      status,
      ...(locations ? { locations } : {}),
      ...(content.length ? { content } : {}),
    });
  } else {
    const planEntries = extractPlanEntries(item, session.tasks, outcome);
    if (planEntries) {
      const planKey = JSON.stringify(planEntries);
      if (planKey !== session.lastPlanKey) {
        session.lastPlanKey = planKey;
        update(session, { sessionUpdate: 'plan', entries: planEntries });
      }
    }
    const translated = presentWorkspaceToolCall(item, session.cwd, outcome);
    const content = translated ? (translated.content.length ? translated.content : (outcome ? toolContent(item) : [])) : toolContent(item);
    const locations = translated ? translated.locations : toolLocations(item);
    const rawName = translated
      ? translated.name
      : (typeof item.toolName === 'string' && item.toolName.trim()
          ? item.toolName.trim()
          : (typeof item.tool === 'string' && item.tool.trim() ? item.tool.trim() : undefined));
    const status = outcome ? (outcome.status === 'succeeded' ? 'completed' : 'failed') : 'in_progress';
    update(session, {
      sessionUpdate: previous ? 'tool_call_update' : 'tool_call',
      toolCallId: item.itemId,
      title: translated ? translated.title : toolTitle(item),
      kind: translated ? translated.kind : toolKind(item),
      status,
      ...(rawName ? { name: rawName } : {}),
      ...(translated
        ? { rawInput: translated.rawInput }
        : (item.arguments === undefined ? {} : { rawInput: item.arguments })),
      ...(outcome && item.output !== undefined ? { rawOutput: item.output } : {}),
      ...(locations ? { locations } : {}),
      ...(content.length ? { content } : {}),
    });
  }
  turn.items.set(item.itemId, { ...item, finished: Boolean(outcome) });
}

const permissionKinds = {
  allowOnce: 'allow_once',
  allowForSession: 'allow_always',
  allowAlways: 'allow_always',
  deny: 'reject_once',
};

async function respondToInteraction(session, turn, interaction) {
  if (interaction.turnId !== turn.id) return;
  const { interactionId } = interaction;
  const controller = new AbortController();
  turn.interactions.set(interactionId, controller);
  try {
    let response;
    if (interaction.type === 'approval') {
      const deny = interaction.actions.find(action => action.effect === 'deny');
      const commands = [...turn.items.values()].filter(item => !item.finished && item.type === 'commandExecution');
      const item = turn.items.get(interaction.itemId) ??
        (interaction.title === 'Bash' && commands.length === 1 ? commands[0] : undefined);
      const options = interaction.actions
        .filter(action => Object.hasOwn(permissionKinds, action.effect))
        .map(action => ({ optionId: action.id, name: action.label, kind: permissionKinds[action.effect] }));
      const translated = item ? presentWorkspaceToolCall(item, session.cwd, null) : null;
      const approvalLocations = translated?.locations ?? (item ? toolLocations(item) : undefined);
      const approvalTitle = translated
        ? [translated.title, interaction.description].filter(Boolean).join('\n')
        : [interaction.title, interaction.description, item?.command].filter(Boolean).join('\n');
      const reply = await askClient('session/request_permission', {
        sessionId: session.id,
        toolCall: {
          toolCallId: item?.itemId ?? interaction.itemId ?? interactionId,
          title: approvalTitle,
          ...(translated ? { kind: translated.kind, rawInput: translated.rawInput } : (item ? { kind: toolKind(item) } : {})),
          ...(approvalLocations ? { locations: approvalLocations } : {}),
        },
        options,
      }, controller.signal).catch(() => null);
      const selected = reply?.outcome?.outcome === 'selected' &&
        options.find(option => option.optionId === reply.outcome.optionId);
      const actionId = selected ? selected.optionId : deny?.id;
      if (actionId === undefined) return await cancel(session);
      response = { type: 'approval', actionId };
    } else if (interaction.type === 'question') {
      const form = clientCaps.elicitationForm ? buildQuestionElicitation(interaction) : null;
      if (!form) {
        response = { type: 'question', answers: {}, cancelled: true };
      } else {
        const reply = await askClient('elicitation/create', {
          sessionId: session.id,
          mode: 'form',
          message: form.message,
          requestedSchema: form.requestedSchema,
        }, controller.signal).catch(() => null);
        if (reply?.action === 'accept' && reply.content && typeof reply.content === 'object') {
          response = {
            type: 'question',
            answers: mapElicitationAnswers(interaction, reply.content),
          };
        } else {
          response = { type: 'question', answers: {}, cancelled: true };
        }
      }
    } else {
      response = { type: 'question', answers: {}, cancelled: true };
    }
    if (session.turn === turn && !controller.signal.aborted) {
      unwrap(await session.native.execute({ type: 'interaction.respond', interactionId, response }));
    }
  } finally {
    turn.interactions.delete(interactionId);
  }
}

async function consume(session) {
  try {
    for await (const output of session.native.outputs) {
      const turn = session.turn;
      if (output.kind === 'interaction') {
        if (turn) void respondToInteraction(session, turn, output.interaction).catch(turn.reject);
        continue;
      }
      const event = output.event;
      if (event.type === 'session.state.changed') {
        await syncSessionState(session, event.state);
      } else if (event.type === 'session.usage.changed') {
        if (event.usage && typeof event.usage === 'object') {
          session.latestUsage = event.usage;
          emitUsageIfChanged(session, event.usage);
          maybeEmitQuotaNotice(session, event.usage);
        }
      } else if (event.type === 'usage.request') {
        const req = event.request;
        if (req && !req.historical) {
          if (typeof req.model === 'string' && req.model.trim() && req.model !== '<synthetic>') {
            session.observedModels ??= [];
            if (!session.observedModels.includes(req.model)) {
              session.observedModels.push(req.model);
              if (session.observedModels.length > 16) session.observedModels.shift();
            }
          }
          if (turn) {
            turn.usage = accumulateTurnUsage(turn.usage, req);
          }
        }
      } else if (event.type === 'session.faulted') {
        throw new Error(event.error.message);
      } else if (turn && event.turnId === turn.id) {
        if (event.type === 'item.started') displayItem(session, turn, event.item);
        if (event.type === 'item.updated') {
          const item = turn.items.get(event.itemId);
          if (item && event.update?.type === 'text.append') {
            displayItem(session, turn, { ...item, text: (item.text ?? '') + event.update.text });
          } else if (item && event.update?.type === 'output.append' && typeof event.update.text === 'string') {
            const nextOutput = typeof item.output === 'string' ? item.output + event.update.text : event.update.text;
            turn.items.set(event.itemId, { ...item, output: nextOutput });
            if (event.update.text.length > 0 && !parseWorkspaceCommand(item.command)) {
              update(session, {
                sessionUpdate: 'tool_call_content_chunk',
                toolCallId: item.itemId,
                content: { type: 'content', content: text(event.update.text) },
              });
            }
          }
        }
        if (event.type === 'subagent.state.changed') {
          const targetId = event.itemId ?? event.subagentId;
          const item = targetId ? turn.items.get(targetId) : null;
          if (item) {
            const nextStatus = event.state === 'completed' || event.state === 'succeeded'
              ? 'completed'
              : event.state === 'failed' || event.state === 'error'
                ? 'failed'
                : 'in_progress';
            const summary = typeof event.summary === 'string' && event.summary.trim()
              ? [{ type: 'content', content: text(event.summary.trim()) }]
              : undefined;
            update(session, {
              sessionUpdate: 'tool_call_update',
              toolCallId: item.itemId,
              status: nextStatus,
              ...(summary ? { content: summary } : {}),
            });
          }
        }
        if (event.type === 'item.completed') displayItem(session, turn, event.snapshot.item, event.snapshot.outcome);
        if (event.type === 'interaction.closed') turn.interactions.get(event.interactionId)?.abort();
        if (event.type === 'turn.completed') {
          if (event.nativeTurnRef?.nativeSessionId && event.nativeTurnRef?.nativeTurnKey) {
            session.lastCheckpoint = {
              harnessId: event.nativeTurnRef.harnessId ?? session.nativeRef?.harnessId ?? 'claude-vps',
              nativeSessionId: event.nativeTurnRef.nativeSessionId,
              checkpointId: event.nativeTurnRef.nativeTurnKey,
              formatVersion: 1,
            };
            void persistSession(session).catch(() => {});
          }
          turn.resolve(event.outcome);
        }
      }
    }
    throw new Error('Claude VPS Bridge closed its event stream');
  } catch (failure) {
    if (!session.closing) {
      session.failure = failure;
      session.turn?.reject(failure);
    }
  }
}

async function syncAvailableCommands(session, force = false) {
  if (!sessions.has(session.id) || session.closing) return;
  let availableCommands = AVAILABLE_COMMANDS;
  if (typeof loadProjectEnvironment === 'function') {
    try {
      const projectEnv = await loadProjectEnvironment(session.cwd);
      const built = buildAvailableCommands(projectEnv);
      availableCommands = built.commands;
      session.localCapabilities = {
        skills: built.localSkillCount,
        commands: built.localCommandCount,
        error: null,
      };
    } catch (err) {
      session.localCapabilities = {
        skills: 0,
        commands: 0,
        error: err?.message ?? '加载失败',
      };
    }
  }
  if (!sessions.has(session.id) || session.closing) return;
  const sig = JSON.stringify(availableCommands);
  if (!force && sig === session.lastCommandsSignature) return;
  session.lastCommandsSignature = sig;
  update(session, {
    sessionUpdate: 'available_commands_update',
    availableCommands,
  });
}

function schedulePostOpenNotifications(session) {
  setImmediate(async () => {
    if (!sessions.has(session.id) || session.closing) return;
    session.initialized = true;
    await syncAvailableCommands(session, true);
    if (!sessions.has(session.id) || session.closing) return;
    if (session.latestUsage) {
      emitUsageIfChanged(session, session.latestUsage);
    }
  });
}

function checkpointFromSnapshot(snapshot, sourceRef) {
  const turns = snapshot?.turns ?? [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn?.checkpoint?.checkpointId) return turn.checkpoint;
    if (turn?.nativeTurnRef?.nativeSessionId && turn?.nativeTurnRef?.nativeTurnKey) {
      return {
        harnessId: turn.nativeTurnRef.harnessId ?? sourceRef.harnessId,
        nativeSessionId: turn.nativeTurnRef.nativeSessionId,
        checkpointId: turn.nativeTurnRef.nativeTurnKey,
        formatVersion: 1,
      };
    }
  }
  return null;
}

async function resolveForkCheckpoint(source, sourceSaved, localCwd) {
  if (source?.native) {
    const snap = await source.native.readSnapshot().catch(() => null);
    if (snap?.ok) {
      const cp = checkpointFromSnapshot(snap.value, sourceSaved.nativeRef);
      if (cp) return cp;
    }
  }
  if (sourceSaved.lastCheckpoint?.checkpointId) return sourceSaved.lastCheckpoint;
  const tempOpened = await bridge.open({ kind: 'resume', cwd: localCwd, nativeRef: sourceSaved.nativeRef }).catch(() => null);
  if (!tempOpened?.ok) return null;
  try {
    const snap = await tempOpened.value.readSnapshot().catch(() => null);
    return snap?.ok ? checkpointFromSnapshot(snap.value, sourceSaved.nativeRef) : null;
  } finally {
    await tempOpened.value.close().catch(() => {});
  }
}

function parseMcpServers(mcpServers = [], cwd) {
  if (!Array.isArray(mcpServers)) throw error(-32602, 'MCP servers must be an array');
  const names = new Map();
  const acpMcpServers = new Map();
  const local = Object.create(null);
  const stringMap = (pairs, label) => {
    if (pairs === undefined) return undefined;
    if (!Array.isArray(pairs) || !pairs.every(p => typeof p?.name === 'string' && typeof p.value === 'string')) {
      throw error(-32602, `Invalid MCP ${label}`);
    }
    return Object.fromEntries(pairs.map(({ name, value }) => [name, value]));
  };
  for (const item of mcpServers) {
    const name = item?.type === 'acp' && item.serverId === 't3-code' ? 't3-code' : item?.name;
    if (!isLocalMcpServerName(name)) throw error(-32602, 'Invalid MCP server name');
    const normalized = normalizeMcpName(name);
    if (names.has(normalized)) throw error(-32602, 'Duplicate or ambiguous MCP server name');
    names.set(normalized, name);
    if (item.type === 'acp') {
      if (typeof item.serverId !== 'string' || !item.serverId || ['url', 'env', 'headers', 'command', 'args', 'cwd'].some(key => Object.hasOwn(item, key))) {
        throw error(-32602, 'Invalid ACP MCP server configuration');
      }
      acpMcpServers.set(name, item.serverId);
    } else {
      const { name: _name, ...config } = item;
      if (Object.hasOwn(config, 'headers')) config.headers = stringMap(config.headers, 'headers');
      if (Object.hasOwn(config, 'env')) config.env = stringMap(config.env, 'env');
      local[name] = config;
    }
  }
  const localMcpHub = new LocalMcpHub();
  try { localMcpHub.registerServers(local, '/unused', cwd); } catch (err) { throw error(-32602, err.message); }
  return { mcpNames: [...names.values()], acpMcpServers, localMcpHub, mcpCatalogs: new Map() };
}

async function openSession({ cwd, sessionId, forkFromSessionId, mcpServers }) {
  if (typeof cwd !== 'string' || !path.win32.isAbsolute(cwd)) {
    throw error(-32602, 'Select a local Windows project in T3 Code');
  }
  const localCwd = await realpath(cwd);
  const id = forkFromSessionId ? randomUUID() : (sessionId ?? randomUUID());
  if (!forkFromSessionId && sessions.has(id)) return sessions.get(id).opening;

  const mcp = parseMcpServers(mcpServers, localCwd);
  const session = {
    ...mcp,
    id,
    cwd: localCwd,
    observedModels: [],
    latestUsage: null,
    t3Mcp: {
      enabled: mcp.mcpNames.includes('t3-code'),
      serverId: mcp.acpMcpServers.get('t3-code') ?? null,
      connected: false,
      toolCount: null,
      lastError: null,
    },
    localCapabilities: null,
    tasks: new Map(),
    lastPlanKey: null,
    initialized: false,
    closing: false,
  };

  const opening = (async () => {
    let saved = null;
    let openInput = { kind: 'create', cwd: localCwd };

    if (forkFromSessionId) {
      const source = sessions.get(forkFromSessionId);
      const sourceSaved = source?.nativeRef
        ? {
            cwd: source.cwd,
            nativeRef: source.nativeRef,
            lastCheckpoint: source.lastCheckpoint,
            modelId: source.currentModelId,
            thinkingOptionId: source.currentThinkingId,
            permissionModeId: source.currentPermissionModeId,
          }
        : await readSavedSession(forkFromSessionId);
      if (sourceSaved.cwd !== localCwd || !sourceSaved.nativeRef) {
        throw error(-32602, 'Fork source session belongs to a different Windows project or has no native session reference');
      }
      const checkpoint = await resolveForkCheckpoint(source, sourceSaved, localCwd);
      if (!checkpoint) {
        throw error(-32602, 'Fork source session has no completed turns to branch from yet');
      }
      saved = sourceSaved;
      openInput = {
        kind: 'fork',
        cwd: localCwd,
        sourceRef: sourceSaved.nativeRef,
        checkpoint,
      };
    } else if (sessionId) {
      saved = await readSavedSession(sessionId);
      if (saved.cwd !== localCwd || !saved.nativeRef) {
        throw error(-32602, 'Saved Claude VPS session belongs to a different Windows project');
      }
      session.nativeRef = saved.nativeRef;
      session.lastCheckpoint = saved.lastCheckpoint;
      session.title = saved.title;
      openInput = {
        kind: 'resume',
        cwd: localCwd,
        nativeRef: saved.nativeRef,
        ...(saved.modelId && saved.modelId !== DEFAULT_MODEL_ID ? { model: { id: saved.modelId } } : {}),
        ...(saved.thinkingOptionId ? { thinkingOptionId: saved.thinkingOptionId } : {}),
        ...(saved.permissionModeId ? { permissionModeId: saved.permissionModeId } : {}),
      };
    }

    if (session.mcpNames.length) {
      openInput = { ...openInput, t3Mcp: session.t3Mcp.enabled, localMcpServers: session.mcpNames, acpSessionId: id };
    }

    const [inspection, openedNative] = await Promise.all([
      getInspection(),
      bridge.open(openInput).then(unwrap),
    ]);

    session.native = openedNative;
    session.nativeRef = openedNative.initialState?.nativeRef ?? openedNative.nativeWriterRef ?? session.nativeRef;
    session.latestUsage = openedNative.initialUsage ?? null;

    const catalog = inspection.catalog ?? {};
    const defaultModelId = catalog.defaultModel?.id ?? catalog.models?.[0]?.ref?.id ?? DEFAULT_MODEL_ID;
    const defaultThinkingId = catalog.defaultThinkingOptionId ?? 'auto';
    const defaultModeId = inspection.permissionModes?.defaultModeId ?? 'default';

    session.currentModelId = openedNative.initialState?.effectiveModel?.id ?? saved?.modelId ?? defaultModelId;
    const catalogModel = findCatalogModel(inspection, session.currentModelId);
    session.resolvedModelLabel = openedNative.initialState?.resolvedModelLabel ?? catalogModel?.resolvedModelLabel ?? null;
    session.availableThinkingOptions = resolveThinkingOptionsForModel(
      catalogModel,
      inspection,
      openedNative.initialState?.availableThinkingOptions,
    );
    session.currentThinkingId = pickValidThinkingId(
      openedNative.initialState?.effectiveThinkingOptionId ?? saved?.thinkingOptionId,
      session.availableThinkingOptions,
      defaultThinkingId,
    );
    session.currentPermissionModeId = openedNative.initialState?.effectivePermissionModeId
      ?? saved?.permissionModeId
      ?? defaultModeId;

    await persistSession(session);
    void consume(session);
    schedulePostOpenNotifications(session);

    const configuration = buildSessionConfiguration(session, inspection);
    return {
      sessionId: id,
      ...configuration,
    };
  })();

  session.opening = opening;
  sessions.set(id, session);
  try {
    return await opening;
  } catch (failure) {
    sessions.delete(id);
    session.closing = true;
    await session.native?.close().catch(() => {});
    await session.localMcpHub.closeAll();
    throw failure;
  }
}

async function setModel(session, modelId, inspection) {
  if (typeof modelId !== 'string' || !modelId.trim()) {
    throw error(-32602, 'Invalid Claude VPS model ID');
  }
  const catalogModels = inspection.catalog?.models ?? [];
  const known = catalogModels.some(m => m?.ref?.id === modelId) || modelId === DEFAULT_MODEL_ID || modelId === session.currentModelId;
  if (!known && catalogModels.length > 0) {
    throw error(-32602, `Unknown Claude VPS model: ${modelId}`);
  }
  if (modelId !== session.currentModelId && modelId !== DEFAULT_MODEL_ID) {
    unwrap(await session.native.execute({ type: 'model.select', model: { id: modelId } }));
    session.currentModelId = modelId;
    const catalogModel = findCatalogModel(inspection, modelId);
    session.resolvedModelLabel = catalogModel?.resolvedModelLabel ?? null;
    session.availableThinkingOptions = resolveThinkingOptionsForModel(catalogModel, inspection);
    const nextThinking = pickValidThinkingId(
      session.currentThinkingId,
      session.availableThinkingOptions,
      inspection.catalog?.defaultThinkingOptionId ?? 'auto',
    );
    if (nextThinking && nextThinking !== session.currentThinkingId) {
      await session.native.execute({ type: 'thinking.select', thinkingOptionId: nextThinking }).catch(() => {});
      session.currentThinkingId = nextThinking;
    }
    await persistSession(session);
  }
}

async function setThinking(session, thinkingOptionId, inspection) {
  if (typeof thinkingOptionId !== 'string' || !thinkingOptionId.trim()) {
    throw error(-32602, 'Invalid Claude VPS thinking option');
  }
  const allowed = session.availableThinkingOptions?.length
    ? session.availableThinkingOptions
    : (inspection.catalog?.thinkingOptions ?? []);
  if (allowed.length > 0 && !allowed.some(opt => opt.id === thinkingOptionId)) {
    throw error(-32602, `Unsupported thinking level "${thinkingOptionId}" for current model`);
  }
  if (thinkingOptionId !== session.currentThinkingId) {
    unwrap(await session.native.execute({ type: 'thinking.select', thinkingOptionId }));
    session.currentThinkingId = thinkingOptionId;
    await persistSession(session);
  }
}

async function setPermissionMode(session, modeId, inspection) {
  if (typeof modeId !== 'string' || !modeId.trim()) {
    throw error(-32602, 'Invalid Claude VPS permission mode');
  }
  const modes = inspection.permissionModes?.modes ?? [];
  if (modes.length > 0 && !modes.some(m => m.id === modeId)) {
    throw error(-32602, `Unknown Claude VPS permission mode: ${modeId}`);
  }
  if (modeId !== session.currentPermissionModeId) {
    unwrap(await session.native.execute({ type: 'permissionMode.select', permissionModeId: modeId }));
    session.currentPermissionModeId = modeId;
    session.mcpPermissionMode = undefined;
    await persistSession(session);
  }
}

async function setConfigOption({ sessionId, configId, value }) {
  const session = getSession(sessionId);
  const inspection = await getInspection();
  if (configId === 'model') {
    await setModel(session, value, inspection);
  } else if (configId === 'thinking') {
    await setThinking(session, value, inspection);
  } else if (configId === 'mode') {
    await setPermissionMode(session, value, inspection);
  } else {
    throw error(-32602, `Unknown Claude VPS config option: ${String(configId)}`);
  }
  const { configOptions } = buildSessionConfiguration(session, inspection);
  return { configOptions };
}

async function selectModel({ sessionId, modelId }) {
  const session = getSession(sessionId);
  const inspection = await getInspection();
  await setModel(session, modelId, inspection);
  return {};
}

async function selectMode({ sessionId, modeId }) {
  const session = getSession(sessionId);
  const inspection = await getInspection();
  await setPermissionMode(session, modeId, inspection);
  return {};
}

async function readSshRouteState() {
  try {
    const raw = await readFile(path.join(bridgeInfo.root, 'runtime', 'state', 'ssh-route.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function handleLocalSlashCommand(session, command) {
  const inspection = await getInspection().catch(() => ({}));
  const [accountRes, sshRouteRes] = await Promise.allSettled([
    withTimeout(bridge.inspectAccount(), 8000),
    command.name === 'status' ? readSshRouteState() : Promise.resolve(null),
    session.native.refreshUsage ? withTimeout(session.native.refreshUsage(), 4000) : Promise.resolve(),
  ]);
  const account = accountRes.status === 'fulfilled' ? accountRes.value : null;
  const sshRoute = sshRouteRes.status === 'fulfilled' ? sshRouteRes.value : null;
  const credits = bridge.credits?.() ?? null;

  if (session.latestUsage) {
    emitUsageIfChanged(session, session.latestUsage);
  }

  const report = command.name === 'status'
    ? formatStatusReport({
        session,
        inspection,
        account,
        credits,
        bridgeVersion: bridgeInfo.version,
        sshRoute,
        t3Mcp: session.t3Mcp,
        localCapabilities: session.localCapabilities,
      })
    : formatUsageReport({ session, inspection, account, credits, bridgeVersion: bridgeInfo.version });

  update(session, { sessionUpdate: 'agent_message_chunk', content: text(report) });
  return { stopReason: 'end_turn' };
}

async function prompt({ sessionId, prompt }) {
  const session = getSession(sessionId);
  if (session.failure) throw session.failure;
  if (session.turn) throw error(-32600, 'Claude VPS session already has an active turn');

  const slash = extractSlashCommand(prompt);
  if (slash && (slash.name === 'usage' || slash.name === 'account' || slash.name === 'status')) {
    return handleLocalSlashCommand(session, slash);
  }

  void syncAvailableCommands(session, false);

  const bridgeInput = slash?.name === 'compact' ? null : convertPromptBlocks(prompt);

  if (!session.title) {
    const title = extractSessionTitle(prompt);
    if (title) {
      session.title = title;
      update(session, {
        sessionUpdate: 'session_info_update',
        title,
        updatedAt: new Date().toISOString(),
      });
      void persistSession(session).catch(() => {});
    }
  }

  const { promise, resolve, reject } = Promise.withResolvers();
  void promise.catch(() => {});
  const turn = {
    id: randomUUID(),
    items: new Map(),
    interactions: new Map(),
    usage: null,
    resolve,
    reject,
  };
  session.turn = turn;

  if (slash?.name === 'compact') {
    turn.admission = session.native.commands.execute({
      turnId: turn.id,
      commandId: 'claude.compact',
      ...(slash.arg ? { arguments: { text: slash.arg } } : {}),
    }).then(unwrap);
  } else {
    turn.admission = session.native.execute({
      type: 'turn.start',
      turnId: turn.id,
      input: bridgeInput,
    }).then(unwrap);
  }

  try {
    await turn.admission;
    const outcome = await promise;
    if (outcome.status === 'failed') throw new Error(outcome.error?.message ?? 'Claude VPS turn failed');
    const usage = formatPromptResponseUsage(turn.usage);
    return {
      stopReason: outcome.status === 'cancelled' ? 'cancelled' : 'end_turn',
      ...(usage ? { usage } : {}),
    };
  } finally {
    session.turn = null;
    for (const controller of turn.interactions.values()) controller.abort();
  }
}

async function cancel(session) {
  const turn = session.turn;
  if (!turn) return;
  turn.cancellation ??= (async () => {
    await turn.admission;
    if (session.turn === turn) unwrap(await session.native.execute({ type: 'turn.cancel', turnId: turn.id }));
  })();
  return turn.cancellation;
}

async function closeSession({ sessionId }) {
  const session = sessions.get(sessionId);
  if (!session) return {};
  session.closing = true;
  sessions.delete(sessionId);
  await session.native?.close().catch(() => {});
  const keys = [...mcpConnections].filter(([, connection]) => connection.acpSessionId === sessionId).map(([key]) => key);
  await Promise.allSettled(keys.map(key => disconnectT3McpConnection(key)));
  await session.localMcpHub.closeAll();
  return {};
}

async function listSessions({ cwd }) {
  let targetCwd = null;
  if (typeof cwd === 'string' && cwd.trim()) {
    targetCwd = await realpath(cwd).catch(() => path.resolve(cwd));
  }
  let entries = [];
  try {
    entries = await readdir(stateDir, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const results = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const id = entry.name.slice(0, -5);
    if (!UUID_RE.test(id)) continue;
    try {
      const saved = JSON.parse(await readFile(path.join(stateDir, entry.name), 'utf8'));
      if (typeof saved?.cwd !== 'string' || !saved.nativeRef) continue;
      if (targetCwd && saved.cwd.toLowerCase() !== targetCwd.toLowerCase()) continue;
      results.push({
        sessionId: id,
        cwd: saved.cwd,
        title: typeof saved.title === 'string' ? saved.title : null,
        updatedAt: typeof saved.updatedAt === 'string' ? saved.updatedAt : null,
      });
    } catch {
      // Ignore corrupt session index entries.
    }
  }
  results.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  return { sessions: results, nextCursor: null };
}

async function deleteSession({ sessionId }) {
  await closeSession({ sessionId });
  if (typeof sessionId === 'string' && UUID_RE.test(sessionId)) {
    await rm(sessionFile(sessionId), { force: true });
  }
  return {};
}

const methods = {
  initialize: params => {
    clientCaps.elicitationForm = Boolean(params?.clientCapabilities?.elicitation?.form);
    clientCaps.compaction = Boolean(params?.clientCapabilities?.session?.compaction);
    clientCaps.notices = Boolean(params?.clientCapabilities?.session?.notices);
    clientCaps.clientName = typeof params?.clientInfo?.name === 'string' ? params.clientInfo.name : '';
    return {
      protocolVersion: 1,
      agentInfo: { name: 'claude-vps-bridge', version: ADAPTER_VERSION, title: 'Claude VPS Bridge' },
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: {
          acp: true,
          http: true,
        },
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true,
        },
        sessionCapabilities: {
          resume: {},
          fork: {},
          close: {},
          list: {},
          delete: {},
        },
      },
      authMethods: [],
    };
  },
  'session/new': params => openSession({ cwd: params.cwd, mcpServers: params.mcpServers }),
  'session/resume': async params => {
    const { configOptions, models, modes } = await openSession(params);
    return { configOptions, models, ...(modes ? { modes } : {}) };
  },
  'session/fork': params => openSession({
    cwd: params.cwd,
    forkFromSessionId: params.sessionId,
    mcpServers: params.mcpServers,
  }),
  'session/load': async params => {
    const { configOptions, models, modes } = await openSession(params);
    const session = getSession(params.sessionId);
    if (session.title) {
      update(session, { sessionUpdate: 'session_info_update', title: session.title, updatedAt: new Date().toISOString() });
    }
    const history = unwrap(await session.native.readSnapshot());
    let restoredPlan = null;
    for (const turn of history.turns ?? []) {
      for (const block of turn.input ?? []) {
        if (block.type === 'text') update(session, { sessionUpdate: 'user_message_chunk', content: text(block.text) });
      }
      for (const { item, outcome } of turn.items ?? []) {
        if (item.type === 'agentMessage' && item.text && !isBridgeNoticeItem(item)) {
          update(session, { sessionUpdate: 'agent_message_chunk', content: text(item.text) });
        } else {
          const entries = extractPlanEntries(item, session.tasks, outcome);
          if (entries) restoredPlan = entries;
        }
      }
    }
    if (restoredPlan?.length) {
      session.lastPlanKey = JSON.stringify(restoredPlan);
      update(session, { sessionUpdate: 'plan', entries: restoredPlan });
    }
    return { configOptions, models, ...(modes ? { modes } : {}) };
  },
  'session/close': closeSession,
  'session/list': listSessions,
  'session/delete': deleteSession,
  'session/set_config_option': setConfigOption,
  'session/set_model': selectModel,
  'session/set_mode': selectMode,
  'session/prompt': prompt,
  'session/cancel': params => cancel(getSession(params.sessionId)),
};

async function receive(line) {
  let message;
  try {
    message = JSON.parse(line);
    if (!message.method) {
      const request = pendingRequests.get(message.id);
      if (message.error) request?.reject(new Error(message.error.message));
      else request?.resolve(message.result);
      return;
    }
    if (!Object.hasOwn(methods, message.method)) throw error(-32601, `Unsupported ACP method ${message.method}`);
    const result = await methods[message.method](message.params ?? {});
    if (message.id !== undefined) send({ id: message.id, result: result ?? {} });
  } catch (failure) {
    if (message?.id !== undefined) {
      send({ id: message.id, error: { code: failure.rpcCode ?? -32603, message: failure.message } });
    } else if (!message) {
      send({ id: null, error: { code: -32700, message: 'Invalid JSON' } });
    } else {
      console.error(failure.message);
    }
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => { if (line.trim()) void receive(line); });
lines.on('close', async () => {
  processAbort.abort(new Error('ACP client disconnected'));
  for (const request of pendingRequests.values()) request.reject(new Error('ACP client disconnected'));
  for (const session of sessions.values()) session.closing = true;
  await closeAllT3Mcp();
  await Promise.allSettled([...sessions.values()].flatMap(session => [session.native?.close(), session.localMcpHub.closeAll()]));
  await bridge.close();
});
