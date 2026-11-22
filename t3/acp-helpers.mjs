import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ADAPTER_VERSION = '1.3.1';
export const DEFAULT_MODEL_ID = 'default';
export const DEFAULT_MODEL = { modelId: DEFAULT_MODEL_ID, name: 'Claude VPS default' };

export const AVAILABLE_COMMANDS = [
  {
    name: 'compact',
    description: '压缩当前对话上下文 (Compact conversation context)',
    input: { type: 'text', hint: '可选：压缩时需要保留的重点说明' },
  },
  {
    name: 'usage',
    description: '查看账号 5h/7d 额度、上下文窗口、缓存、速度、费用与实际模型',
  },
  {
    name: 'status',
    description: '查看 Claude VPS Bridge 连接、SSH 路由、T3 MCP、模型、推理深度与会话状态',
  },
];

export function buildAvailableCommands(projectEnv) {
  const commands = AVAILABLE_COMMANDS.map(cmd => ({ ...cmd }));
  const seenCommands = new Set(commands.map(cmd => cmd.name.toLowerCase()));
  const seenSkills = new Set();
  let localCommandCount = 0;
  let localSkillCount = 0;

  const capabilities = Array.isArray(projectEnv?.capabilities) ? projectEnv.capabilities : [];
  for (const cap of capabilities) {
    if (!cap || typeof cap.name !== 'string') continue;
    const rawName = cap.name.trim().replace(/^[/$]+/, '');
    if (!rawName || /\s/.test(rawName)) continue;
    const desc = typeof cap.description === 'string' && cap.description.trim()
      ? cap.description.trim().slice(0, 200)
      : undefined;

    if (cap.kind === 'command') {
      const key = rawName.toLowerCase();
      if (seenCommands.has(key)) continue;
      seenCommands.add(key);
      localCommandCount++;
      commands.push({
        name: rawName,
        description: desc ?? 'Local project command',
      });
    } else if (cap.kind === 'skill') {
      const key = rawName.toLowerCase();
      if (seenSkills.has(key)) continue;
      seenSkills.add(key);
      localSkillCount++;
      commands.push({
        name: `$${rawName}`,
        description: desc ?? 'Local project skill',
      });
    }
  }

  return { commands, localSkillCount, localCommandCount };
}

function normalizePlanStatus(status) {
  const s = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (s === 'in_progress' || s === 'in-progress' || s === 'running' || s === 'active') return 'in_progress';
  if (s === 'completed' || s === 'done' || s === 'finished') return 'completed';
  return 'pending';
}

function normalizePlanPriority(priority) {
  const p = typeof priority === 'string' ? priority.trim().toLowerCase() : '';
  if (p === 'high' || p === 'medium' || p === 'low') return p;
  return 'medium';
}

function extractTextOutput(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output?.content)) {
    return output.content
      .filter(b => b?.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n');
  }
  return '';
}

function extractTaskIdFromOutput(output) {
  const raw = extractTextOutput(output);
  if (!raw) return null;
  const hashMatch = raw.match(/\bTask\s+#(\d+)\b/i);
  if (hashMatch) return hashMatch[1];
  const jsonMatch = raw.match(/"(?:taskId|id)"\s*:\s*"?([A-Za-z0-9_-]+)"?/i);
  if (jsonMatch) return jsonMatch[1];
  return null;
}

function rekeyMapInPlace(map, oldKey, newKey, value) {
  if (oldKey === newKey || !map.has(oldKey)) {
    map.set(newKey, value);
    return;
  }
  const entries = [...map.entries()];
  map.clear();
  for (const [k, v] of entries) {
    if (k === oldKey) map.set(newKey, value);
    else if (k !== newKey) map.set(k, v);
  }
}

export function extractPlanEntries(item, taskMap, outcome) {
  const toolName = String(item?.toolName ?? item?.tool ?? '').trim();
  const args = item?.arguments;
  if (!args || typeof args !== 'object') return null;

  if ((toolName === 'Todo' || toolName === 'TodoWrite') && Array.isArray(args.todos)) {
    const entries = [];
    for (const todo of args.todos) {
      if (!todo || typeof todo !== 'object') continue;
      const content = String(todo.content ?? todo.activeForm ?? todo.title ?? '').trim();
      if (!content) continue;
      entries.push({
        content,
        priority: normalizePlanPriority(todo.priority),
        status: normalizePlanStatus(todo.status),
      });
    }
    if (taskMap instanceof Map && entries.length) {
      taskMap.clear();
      args.todos.forEach((todo, index) => {
        const content = String(todo?.content ?? todo?.activeForm ?? todo?.title ?? '').trim();
        if (!content) return;
        const key = todo?.id !== undefined ? String(todo.id) : String(index + 1);
        taskMap.set(key, {
          content,
          priority: normalizePlanPriority(todo.priority),
          status: normalizePlanStatus(todo.status),
        });
      });
    }
    return entries.length ? entries : null;
  }

  if (toolName === 'TaskCreate' && taskMap instanceof Map) {
    const pendingKey = item.itemId ? `__pending_${item.itemId}` : null;
    if (outcome && outcome.status !== 'succeeded') {
      if (pendingKey && taskMap.has(pendingKey)) {
        taskMap.delete(pendingKey);
        return [...taskMap.values()];
      }
      return null;
    }
    const content = String(args.subject ?? args.description ?? args.activeForm ?? '').trim();
    if (!content) return null;
    const resolvedId = outcome
      ? (extractTaskIdFromOutput(item.output) ?? args.taskId ?? args.id ?? null)
      : (args.taskId ?? args.id ?? null);
    const entry = {
      content,
      priority: normalizePlanPriority(args.priority),
      status: normalizePlanStatus(args.status),
    };
    if (resolvedId !== null && resolvedId !== undefined) {
      const finalKey = String(resolvedId);
      if (pendingKey && taskMap.has(pendingKey)) {
        rekeyMapInPlace(taskMap, pendingKey, finalKey, entry);
      } else {
        taskMap.set(finalKey, entry);
      }
    } else {
      const key = pendingKey ?? String(taskMap.size + 1);
      taskMap.set(key, entry);
    }
    return [...taskMap.values()];
  }

  if (toolName === 'TaskUpdate' && taskMap instanceof Map) {
    if (outcome && outcome.status !== 'succeeded') return null;
    const key = args.taskId !== undefined ? String(args.taskId) : null;
    if (!key) return null;
    const rawStatus = typeof args.status === 'string' ? args.status.trim().toLowerCase() : '';
    if (rawStatus === 'deleted') {
      taskMap.delete(key);
      return [...taskMap.values()];
    }
    const existing = taskMap.get(key) ?? {
      content: String(args.subject ?? args.description ?? `Task ${key}`).trim(),
      priority: 'medium',
      status: 'pending',
    };
    taskMap.set(key, {
      content: typeof args.subject === 'string' && args.subject.trim()
        ? args.subject.trim()
        : (typeof args.description === 'string' && args.description.trim() ? args.description.trim() : existing.content),
      priority: args.priority ? normalizePlanPriority(args.priority) : existing.priority,
      status: args.status ? normalizePlanStatus(args.status) : existing.status,
    });
    return [...taskMap.values()];
  }

  return null;
}

// Re-export shared T3 MCP policy so ACP and Native Shim enforce identical allow/deny & Plan-mode rules.
export {
  PLAN_MODE_ALLOWED_T3_TOOLS,
  parseT3McpPolicy,
  isT3McpToolAllowed,
} from './mcp-policy.mjs';

export function normalizeThinkingOption(entry, catalogThinkingMap) {
  if (typeof entry === 'string') {
    const known = catalogThinkingMap.get(entry);
    return { id: entry, label: known?.label ?? entry };
  }
  if (entry && typeof entry === 'object' && typeof entry.id === 'string') {
    const known = catalogThinkingMap.get(entry.id);
    return { id: entry.id, label: entry.label ?? known?.label ?? entry.id };
  }
  return null;
}

export function resolveThinkingOptionsForModel(modelEntry, inspection, overrideOptions) {
  const catalogThinking = inspection?.catalog?.thinkingOptions ?? [];
  const thinkingMap = new Map(catalogThinking.map(opt => [opt.id, opt]));

  const normalizedOverrides = Array.isArray(overrideOptions) && overrideOptions.length > 0
    ? overrideOptions.map(entry => normalizeThinkingOption(entry, thinkingMap)).filter(Boolean)
    : [];
  for (const opt of normalizedOverrides) {
    if (!thinkingMap.has(opt.id)) thinkingMap.set(opt.id, opt);
  }

  if (Array.isArray(modelEntry?.supportedThinkingOptionIds) && modelEntry.supportedThinkingOptionIds.length > 0) {
    const supportedSet = new Set(modelEntry.supportedThinkingOptionIds);
    const base = normalizedOverrides.length > 0
      ? normalizedOverrides.filter(opt => supportedSet.has(opt.id))
      : [];
    if (base.length > 0) return base;
    return modelEntry.supportedThinkingOptionIds
      .map(id => normalizeThinkingOption(id, thinkingMap))
      .filter(Boolean);
  }

  if (normalizedOverrides.length > 0) return normalizedOverrides;
  return catalogThinking.map(opt => ({ id: opt.id, label: opt.label ?? opt.id }));
}

export function pickValidThinkingId(preferred, availableOptions, fallbackDefault) {
  if (!availableOptions.length) return null;
  if (preferred && availableOptions.some(opt => opt.id === preferred)) return preferred;
  if (fallbackDefault && availableOptions.some(opt => opt.id === fallbackDefault)) return fallbackDefault;
  if (availableOptions.some(opt => opt.id === 'auto')) return 'auto';
  return availableOptions[0].id;
}

export function findCatalogModel(inspection, modelId) {
  return (inspection?.catalog?.models ?? []).find(m => m?.ref?.id === modelId) ?? null;
}

export function buildSessionConfiguration(session, inspection, options = {}) {
  const catalog = inspection?.catalog ?? {};
  const catalogModels = (catalog.models ?? []).filter(m => typeof m?.ref?.id === 'string');
  const defaultThinkingId = catalog.defaultThinkingOptionId ?? 'auto';
  const permissionModes = (inspection?.permissionModes?.modes ?? []).filter(m => typeof m?.id === 'string');
  const hideModeOption = options.hideModeOption ?? (process.env.T3_CLAUDE_HIDE_MODE_OPTION === '1');

  const modelChoices = catalogModels.map(m => ({
    value: m.ref.id,
    name: m.label ?? m.ref.id,
    ...(m.resolvedModelLabel ? { description: m.resolvedModelLabel } : {}),
  }));
  if (!modelChoices.length) {
    modelChoices.push({ value: DEFAULT_MODEL_ID, name: DEFAULT_MODEL.name });
  }
  if (session.currentModelId && !modelChoices.some(c => c.value === session.currentModelId)) {
    modelChoices.push({
      value: session.currentModelId,
      name: session.currentModelId,
      ...(session.resolvedModelLabel ? { description: session.resolvedModelLabel } : {}),
    });
  }

  const availableModels = catalogModels.map(m => {
    const supported = resolveThinkingOptionsForModel(m, inspection);
    const defaultForModel = pickValidThinkingId(defaultThinkingId, supported, defaultThinkingId);
    return {
      modelId: m.ref.id,
      name: m.label ?? m.ref.id,
      ...(m.resolvedModelLabel ? { description: m.resolvedModelLabel } : {}),
      _meta: {
        supportsReasoningEffort: supported.length > 0,
        ...(defaultForModel ? { reasoningEffort: defaultForModel } : {}),
        reasoningEfforts: supported.map(o => ({ value: o.id, label: o.label })),
      },
    };
  });
  if (!availableModels.length) {
    availableModels.push({ ...DEFAULT_MODEL });
  }
  if (session.currentModelId && !availableModels.some(m => m.modelId === session.currentModelId)) {
    availableModels.push({
      modelId: session.currentModelId,
      name: session.currentModelId,
      ...(session.resolvedModelLabel ? { description: session.resolvedModelLabel } : {}),
    });
  }

  const configOptions = [
    {
      id: 'model',
      name: 'Model',
      description: 'Claude model on VPS',
      category: 'model',
      type: 'select',
      currentValue: session.currentModelId,
      options: modelChoices,
    },
  ];

  const thinkingOptions = session.availableThinkingOptions ?? [];
  if (thinkingOptions.length > 0 && session.currentThinkingId) {
    configOptions.push({
      id: 'thinking',
      name: 'Thinking',
      description: 'Claude reasoning effort level',
      category: 'thought_level',
      type: 'select',
      currentValue: session.currentThinkingId,
      options: thinkingOptions.map(opt => ({
        value: opt.id,
        name: opt.label ?? opt.id,
      })),
    });
  }

  let modes;
  if (permissionModes.length > 0) {
    const currentModeId = session.currentPermissionModeId
      ?? inspection?.permissionModes?.defaultModeId
      ?? permissionModes[0].id;
    const modeOptions = permissionModes.map(m => ({
      value: m.id,
      name: m.label ?? m.id,
      ...(m.description ? { description: m.description } : {}),
    }));
    if (!modeOptions.some(m => m.value === currentModeId)) {
      modeOptions.push({ value: currentModeId, name: currentModeId });
    }
    if (!hideModeOption) {
      configOptions.push({
        id: 'mode',
        name: 'Claude Mode',
        description: '远端 Claude Code 权限模式（与 T3 审批开关叠加生效）',
        category: 'mode',
        type: 'select',
        currentValue: currentModeId,
        options: modeOptions,
      });
    }
    modes = {
      currentModeId,
      availableModes: modeOptions.map(m => ({
        id: m.value,
        name: m.name,
        ...(m.description ? { description: m.description } : {}),
      })),
    };
  }

  return {
    configOptions,
    models: {
      currentModelId: session.currentModelId,
      availableModels,
    },
    ...(modes ? { modes } : {}),
  };
}

export function buildUsageUpdate(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const used = Number.isInteger(usage.contextUsedTokens) && usage.contextUsedTokens >= 0
    ? usage.contextUsedTokens
    : null;
  if (used === null) return null;
  const size = Number.isInteger(usage.contextWindowTokens) && usage.contextWindowTokens > 0
    ? usage.contextWindowTokens
    : 0;
  const cost = typeof usage.totalCostUsd === 'number' && Number.isFinite(usage.totalCostUsd) && usage.totalCostUsd >= 0
    ? { amount: usage.totalCostUsd, currency: 'USD' }
    : undefined;
  return {
    sessionUpdate: 'usage_update',
    used,
    size,
    ...(cost ? { cost } : {}),
  };
}

export function accumulateTurnUsage(current, request) {
  if (!request || typeof request !== 'object' || request.historical) return current;
  const num = v => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);
  const inputTokens = num(request.inputTokens);
  const cachedReadTokens = num(request.cachedInputTokens ?? request.cacheReadInputTokens);
  const cachedWriteTokens = num(request.cacheWriteInputTokens ?? request.cacheCreationInputTokens);
  const outputTokens = num(request.outputTokens);
  const thoughtTokens = num(request.reasoningOutputTokens ?? request.thoughtTokens);
  const totalTokens = num(request.totalTokens) || (inputTokens + outputTokens);
  if (totalTokens <= 0 && inputTokens <= 0 && outputTokens <= 0) return current;

  const prev = current ?? {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    thoughtTokens: 0,
  };
  return {
    inputTokens: prev.inputTokens + inputTokens,
    outputTokens: prev.outputTokens + outputTokens,
    totalTokens: prev.totalTokens + totalTokens,
    cachedReadTokens: prev.cachedReadTokens + cachedReadTokens,
    cachedWriteTokens: prev.cachedWriteTokens + cachedWriteTokens,
    thoughtTokens: prev.thoughtTokens + thoughtTokens,
  };
}

export function formatPromptResponseUsage(turnUsage) {
  if (!turnUsage || turnUsage.totalTokens <= 0) return undefined;
  return {
    totalTokens: turnUsage.totalTokens,
    inputTokens: turnUsage.inputTokens,
    outputTokens: turnUsage.outputTokens,
    ...(turnUsage.cachedReadTokens > 0 ? { cachedReadTokens: turnUsage.cachedReadTokens } : {}),
    ...(turnUsage.cachedWriteTokens > 0 ? { cachedWriteTokens: turnUsage.cachedWriteTokens } : {}),
    ...(turnUsage.thoughtTokens > 0 ? { thoughtTokens: turnUsage.thoughtTokens } : {}),
  };
}

export function convertPromptBlocks(prompt) {
  if (!Array.isArray(prompt) || !prompt.length) {
    throw Object.assign(new Error('Prompt must contain at least one content block'), { rpcCode: -32602 });
  }
  const result = [];
  for (const block of prompt) {
    if (!block || typeof block !== 'object') {
      throw Object.assign(new Error('Invalid prompt content block'), { rpcCode: -32602 });
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      result.push({ type: 'text', text: block.text });
    } else if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
      result.push({
        type: 'image',
        imageUrl: `data:${block.mimeType};base64,${block.data}`,
      });
    } else if (block.type === 'resource_link' && typeof block.uri === 'string') {
      if (block.uri.startsWith('file://')) {
        try {
          const fsPath = fileURLToPath(block.uri);
          if (/\.(png|jpe?g|webp|gif|pdf)$/i.test(fsPath) && path.win32.isAbsolute(fsPath)) {
            result.push({ type: 'localImage', path: fsPath });
            continue;
          }
          result.push({ type: 'text', text: `Referenced file: ${fsPath}` });
          continue;
        } catch {
          // Fall through to generic URI text.
        }
      }
      result.push({ type: 'text', text: `Referenced resource: ${block.name ? `${block.name} (${block.uri})` : block.uri}` });
    } else if (block.type === 'resource' && block.resource && typeof block.resource === 'object') {
      const res = block.resource;
      if (typeof res.text === 'string') {
        const header = res.uri ? `[Embedded resource: ${res.uri}]\n` : '';
        result.push({ type: 'text', text: `${header}${res.text}` });
      } else if (typeof res.blob === 'string' && typeof res.mimeType === 'string' && res.mimeType.startsWith('image/')) {
        result.push({ type: 'image', imageUrl: `data:${res.mimeType};base64,${res.blob}` });
      } else {
        throw Object.assign(new Error(`Unsupported embedded resource type in prompt: ${res.mimeType ?? 'unknown'}`), { rpcCode: -32602 });
      }
    } else {
      throw Object.assign(new Error(`Unsupported ACP prompt block type: ${String(block.type)}`), { rpcCode: -32602 });
    }
  }
  return result;
}

export function extractSlashCommand(prompt) {
  if (!Array.isArray(prompt) || prompt.length !== 1 || prompt[0]?.type !== 'text' || typeof prompt[0].text !== 'string') {
    return null;
  }
  const match = prompt[0].text.trim().match(/^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { name: match[1].toLowerCase(), arg: (match[2] ?? '').trim() };
}

export function extractSessionTitle(prompt) {
  const raw = (prompt ?? []).find(b => b?.type === 'text' && b.text?.trim())?.text;
  if (!raw) return null;
  let candidate = raw;
  const userReq = candidate.match(/<user_request>\s*([\s\S]*?)\s*<\/user_request>/i);
  if (userReq) {
    candidate = userReq[1];
  } else {
    candidate = candidate
      .replace(/<t3_code(?:_orchestration)?_instructions>[\s\S]*?<\/t3_code(?:_orchestration)?_instructions>/gi, '')
      .replace(/<runtime_info>[\s\S]*?<\/runtime_info>/gi, '')
      .replace(/<pull_request_linking>[\s\S]*?<\/pull_request_linking>/gi, '');
  }
  const handoffMarker = candidate.lastIndexOf('\nUser message:\n');
  if (handoffMarker !== -1 && /Context handoff\s*\(/i.test(candidate.slice(0, handoffMarker))) {
    candidate = candidate.slice(handoffMarker + '\nUser message:\n'.length);
  }
  const cleaned = candidate.replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned.startsWith('/')) return null;
  return cleaned.slice(0, 80);
}

export function buildQuestionElicitation(interaction) {
  const questions = Array.isArray(interaction?.questions) ? interaction.questions : [];
  if (!questions.length) return null;

  const properties = {};
  const required = [];
  const otherCompanionIds = new Set();

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const id = typeof q.id === 'string' && q.id.trim() ? q.id.trim() : `question-${i + 1}`;
    const title = (q.header || q.title || interaction.title || `Question ${i + 1}`).trim();
    const description = (q.prompt || q.question || title).trim();
    const options = Array.isArray(q.options) ? q.options : [];
    const hasOptions = options.length > 0 && (q.type === 'choice' || q.type === undefined);

    if (hasOptions && q.multiple === true) {
      properties[id] = {
        type: 'array',
        title,
        description,
        items: {
          anyOf: options.map(opt => ({
            const: String(opt.value ?? opt.label),
            title: String(opt.label ?? opt.value),
            ...(opt.description ? { description: String(opt.description) } : {}),
          })),
        },
        minItems: q.optional ? 0 : 1,
        maxItems: options.length,
      };
      if (!q.optional) required.push(id);
    } else if (hasOptions) {
      properties[id] = {
        type: 'string',
        title,
        description,
        oneOf: options.map(opt => ({
          const: String(opt.value ?? opt.label),
          title: String(opt.label ?? opt.value),
          ...(opt.description ? { description: String(opt.description) } : {}),
        })),
      };
      if (q.allowOther === true) {
        const companionId = `${id}__other`;
        properties[companionId] = {
          type: 'string',
          title: 'Other',
          description: 'Custom answer',
        };
        otherCompanionIds.add(id);
      } else if (!q.optional) {
        required.push(id);
      }
    } else {
      properties[id] = {
        type: 'string',
        title,
        description,
      };
      if (!q.optional) required.push(id);
    }
  }

  return {
    message: interaction.title ?? 'Claude needs your input',
    requestedSchema: {
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
    },
    otherCompanionIds,
  };
}

export function mapElicitationAnswers(interaction, content) {
  const answers = {};
  const questions = Array.isArray(interaction?.questions) ? interaction.questions : [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const id = typeof q.id === 'string' && q.id.trim() ? q.id.trim() : `question-${i + 1}`;
    const raw = content?.[id] ?? content?.[`${id}__other`];
    if (Array.isArray(raw)) {
      answers[id] = raw.map(v => String(v));
    } else if (raw !== undefined && raw !== null && String(raw) !== '') {
      answers[id] = [String(raw)];
    } else {
      answers[id] = [];
    }
  }
  return answers;
}

export function formatResetTime(value, nowMs = Date.now()) {
  if (value === null || value === undefined) return null;
  const date = typeof value === 'number'
    ? new Date(value > 1e12 ? value : value * 1000)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const diffSec = Math.max(0, Math.round((date.getTime() - nowMs) / 1000));
  const days = Math.floor(diffSec / 86400);
  const hours = Math.floor((diffSec % 86400) / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);
  const rel = days > 0
    ? `${days}天 ${hours}小时后`
    : hours > 0
      ? `${hours}小时 ${mins}分钟后`
      : mins > 0
        ? `${mins}分钟后`
        : `${diffSec}秒后`;
  const pad = n => String(n).padStart(2, '0');
  const local = `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `${local}（${rel}）`;
}

export function formatTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function formatPercent(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return `${Math.round(n * 10) / 10}%`;
}

export function formatUsageReport({ session, inspection, account, credits, bridgeVersion, nowMs = Date.now() }) {
  const lines = ['### Claude VPS Bridge 用量与账号状态', ''];
  const usage = session.latestUsage ?? {};
  const effectiveCredits = account?.credits ?? credits ?? null;

  // 1. Account & Credits (5h / 7d)
  lines.push('#### 账号与额度');
  if (account?.email || account?.plan) {
    const parts = [];
    if (account.email) parts.push(`账号：\`${account.email}\``);
    if (account.plan) parts.push(`套餐：\`${account.plan}\``);
    lines.push(`- ${parts.join(' · ')}`);
  }

  const fiveHourPct = effectiveCredits?.periodType === 'five_hour'
    ? effectiveCredits.usedPercent
    : usage.planFiveHourUsedPercent;
  const fiveHourReset = effectiveCredits?.periodType === 'five_hour'
    ? effectiveCredits.resetsAt
    : usage.planFiveHourResetsAtUnix;

  if (typeof fiveHourPct === 'number') {
    const resetText = formatResetTime(fiveHourReset, nowMs);
    lines.push(`- **5 小时窗口**：已用 **${formatPercent(fiveHourPct)}**${resetText ? ` · 重置时间：${resetText}` : ''}`);
  } else if (typeof effectiveCredits?.usedPercent === 'number') {
    const resetText = formatResetTime(effectiveCredits.resetsAt, nowMs);
    lines.push(`- **主窗口（${effectiveCredits.periodType ?? 'quota'}）**：已用 **${formatPercent(effectiveCredits.usedPercent)}**${resetText ? ` · 重置时间：${resetText}` : ''}`);
  }

  const productUsage = Array.isArray(effectiveCredits?.productUsage) ? effectiveCredits.productUsage : [];
  let printedSevenDay = false;
  for (const item of productUsage) {
    if (typeof item?.usagePercent !== 'number') continue;
    const isSevenDay = item.periodType === 'seven_day';
    if (isSevenDay) printedSevenDay = true;
    const label = isSevenDay ? '7 天窗口' : (item.product ?? item.periodType ?? '其他窗口');
    const resetText = formatResetTime(item.resetsAt, nowMs);
    lines.push(`- **${label}**：已用 **${formatPercent(item.usagePercent)}**${resetText ? ` · 重置时间：${resetText}` : ''}`);
  }
  if (!printedSevenDay && typeof usage.planSevenDayUsedPercent === 'number') {
    const resetText = formatResetTime(usage.planSevenDayResetsAtUnix, nowMs);
    lines.push(`- **7 天窗口**：已用 **${formatPercent(usage.planSevenDayUsedPercent)}**${resetText ? ` · 重置时间：${resetText}` : ''}`);
  }

  if (!account && !effectiveCredits && usage.planFiveHourUsedPercent === undefined && usage.planSevenDayUsedPercent === undefined) {
    lines.push('- 暂未获取到账号额度快照（远端额度查询可能暂不可用或尚未返回）。');
  }

  // 2. Context window, tokens, cache, cost
  lines.push('', '#### 当前会话上下文与消耗');
  if (Number.isInteger(usage.contextUsedTokens) && Number.isInteger(usage.contextWindowTokens) && usage.contextWindowTokens > 0) {
    const pct = usage.contextUsagePercent ?? (usage.contextUsedTokens / usage.contextWindowTokens) * 100;
    lines.push(`- **上下文窗口**：${formatTokens(usage.contextUsedTokens)} / ${formatTokens(usage.contextWindowTokens)}（**${formatPercent(pct)}**）`);
  } else if (Number.isInteger(usage.contextUsedTokens)) {
    lines.push(`- **当前上下文**：${formatTokens(usage.contextUsedTokens)} tokens`);
  } else {
    lines.push('- **上下文窗口**：本会话暂无已上报的上下文统计（发送一轮对话后会更新）。');
  }

  const tokenParts = [];
  if (Number.isInteger(usage.inputTokens)) tokenParts.push(`输入 ${formatTokens(usage.inputTokens)}`);
  if (Number.isInteger(usage.cachedInputTokens)) tokenParts.push(`缓存读取 ${formatTokens(usage.cachedInputTokens)}`);
  if (Number.isInteger(usage.cacheWriteInputTokens)) tokenParts.push(`缓存写入 ${formatTokens(usage.cacheWriteInputTokens)}`);
  if (Number.isInteger(usage.outputTokens)) tokenParts.push(`输出 ${formatTokens(usage.outputTokens)}`);
  if (Number.isInteger(usage.reasoningOutputTokens)) tokenParts.push(`推理 ${formatTokens(usage.reasoningOutputTokens)}`);
  if (tokenParts.length) lines.push(`- **Token 明细**：${tokenParts.join(' · ')}`);

  const perfParts = [];
  if (typeof usage.cacheHitRatePercent === 'number') perfParts.push(`最近缓存命中率 ${formatPercent(usage.cacheHitRatePercent)}`);
  if (typeof usage.sessionCacheHitRatePercent === 'number') perfParts.push(`会话缓存命中率 ${formatPercent(usage.sessionCacheHitRatePercent)}`);
  if (typeof usage.outputTokensPerSecond === 'number') perfParts.push(`输出速度 ${usage.outputTokensPerSecond.toFixed(1)} tok/s`);
  if (typeof usage.timeToFirstOutputMs === 'number') perfParts.push(`首字延迟 ${usage.timeToFirstOutputMs} ms`);
  if (perfParts.length) lines.push(`- **缓存与速度**：${perfParts.join(' · ')}`);

  if (typeof usage.totalCostUsd === 'number' && Number.isFinite(usage.totalCostUsd)) {
    lines.push(`- **累计估算费用**：$${usage.totalCostUsd.toFixed(4)} USD`);
  }

  const promptCache = Array.isArray(usage.composerIndicators)
    ? usage.composerIndicators.find(i => i?.id === 'prompt-cache')
    : null;
  if (promptCache && Number.isSafeInteger(promptCache.expiresAtUnix)) {
    const remainSec = Math.floor(promptCache.expiresAtUnix - nowMs / 1000);
    if (remainSec > 0) {
      const m = Math.floor(remainSec / 60);
      const s = remainSec % 60;
      lines.push(`- **Prompt Cache 有效倒计时**：剩余 ${m}分 ${String(s).padStart(2, '0')}秒`);
    } else {
      lines.push('- **Prompt Cache**：已过期');
    }
  }

  // 3. Active configuration & observed model
  const catalogModel = findCatalogModel(inspection, session.currentModelId);
  const modelLabel = catalogModel?.label ?? session.currentModelId;
  const resolvedLabel = session.resolvedModelLabel ?? catalogModel?.resolvedModelLabel;
  const observed = session.observedModels?.length ? session.observedModels.join(', ') : null;
  const thinkingObj = (session.availableThinkingOptions ?? []).find(o => o.id === session.currentThinkingId);
  const modeObj = (inspection?.permissionModes?.modes ?? []).find(m => m.id === session.currentPermissionModeId);

  lines.push('', '#### 当前会话配置');
  lines.push(`- **模型选择**：${modelLabel}${resolvedLabel ? `（解析：\`${resolvedLabel}\`）` : ''}`);
  if (observed) lines.push(`- **实测响应模型**：\`${observed}\``);
  if (session.currentThinkingId) lines.push(`- **推理深度**：${thinkingObj?.label ?? session.currentThinkingId}（\`${session.currentThinkingId}\`）`);
  if (session.currentPermissionModeId) lines.push(`- **权限模式**：${modeObj?.label ?? session.currentPermissionModeId}（\`${session.currentPermissionModeId}\`）`);
  if (bridgeVersion) lines.push(`- **Bridge / 适配器版本**：Bridge ${bridgeVersion} · ACP Adapter ${ADAPTER_VERSION}`);

  return lines.join('\n');
}

export function formatStatusReport({
  session,
  inspection,
  account,
  credits,
  bridgeVersion,
  sshRoute,
  t3Mcp,
  localCapabilities,
  nowMs = Date.now(),
}) {
  const catalogModel = findCatalogModel(inspection, session.currentModelId);
  const resolvedLabel = session.resolvedModelLabel ?? catalogModel?.resolvedModelLabel;
  const thinkingObj = (session.availableThinkingOptions ?? []).find(o => o.id === session.currentThinkingId);
  const modeObj = (inspection?.permissionModes?.modes ?? []).find(m => m.id === session.currentPermissionModeId);
  const effectiveCredits = account?.credits ?? credits ?? null;
  const usage = session.latestUsage ?? {};
  const nativeId = session.nativeRef?.nativeSessionId ?? session.native?.nativeWriterRef?.nativeSessionId ?? '尚未分配';

  const lines = [
    '### Claude VPS Bridge 会话状态',
    '',
    `- **版本**：Bridge \`${bridgeVersion ?? 'unknown'}\` · T3 ACP Adapter \`${ADAPTER_VERSION}\``,
    `- **本机项目**：\`${session.cwd}\``,
    ...(session.native?.remoteCwd ? [`- **VPS 工作目录**：\`${session.native.remoteCwd}\``] : []),
    `- **会话 ID**：T3 \`${session.id}\` · Claude 原生 \`${nativeId}\``,
    `- **当前模型**：${catalogModel?.label ?? session.currentModelId}${resolvedLabel ? `（\`${resolvedLabel}\`）` : ''}`,
    ...(session.observedModels?.length ? [`- **实测响应模型**：\`${session.observedModels.join(', ')}\``] : []),
    `- **推理深度**：${thinkingObj?.label ?? session.currentThinkingId ?? '默认'}`,
    `- **Claude 权限模式**：${modeObj?.label ?? session.currentPermissionModeId ?? 'default'}`,
  ];

  if (sshRoute && typeof sshRoute === 'object' && sshRoute.route) {
    const routeParts = [`\`${sshRoute.route}\``];
    if (sshRoute.routeType && sshRoute.routeType !== sshRoute.route) routeParts.push(sshRoute.routeType);
    if (sshRoute.state) routeParts.push(`状态：${sshRoute.state}`);
    if (sshRoute.ingress?.kind && sshRoute.ingress.kind !== 'unknown') {
      routeParts.push(`入口：${sshRoute.ingress.process ? `${sshRoute.ingress.kind}/${sshRoute.ingress.process}` : sshRoute.ingress.kind}`);
    }
    lines.push(`- **SSH 路由**：${routeParts.join(' · ')}`);
  }

  if (t3Mcp) {
    if (t3Mcp.enabled) {
      const mcpDetail = t3Mcp.connected
        ? `已连通${typeof t3Mcp.toolCount === 'number' ? ` · ${t3Mcp.toolCount} 个 T3 工具` : ''}`
        : '已开启（等待 VPS Claude 首次握手）';
      const errSuffix = t3Mcp.lastError ? `（最近错误：${t3Mcp.lastError}）` : '';
      lines.push(`- **T3 MCP 桥接**：${mcpDetail}${errSuffix}`);
    } else {
      lines.push('- **T3 MCP 桥接**：未启用（当前客户端未注入 ACP MCP 服务）');
    }
  }

  if (localCapabilities) {
    if (localCapabilities.error) {
      lines.push(`- **本机项目扩展**：未加载（${localCapabilities.error}）`);
    } else if (localCapabilities.skills > 0 || localCapabilities.commands > 0) {
      lines.push(`- **本机项目扩展**：${localCapabilities.skills} 个 Skills · ${localCapabilities.commands} 个 Commands（会话打开时同步至补全菜单）`);
    }
  }

  if (Number.isInteger(usage.contextUsedTokens) && Number.isInteger(usage.contextWindowTokens) && usage.contextWindowTokens > 0) {
    const pct = usage.contextUsagePercent ?? (usage.contextUsedTokens / usage.contextWindowTokens) * 100;
    lines.push(`- **上下文占用**：${formatTokens(usage.contextUsedTokens)} / ${formatTokens(usage.contextWindowTokens)}（${formatPercent(pct)}）`);
  }

  const fiveHourPct = effectiveCredits?.periodType === 'five_hour' ? effectiveCredits.usedPercent : usage.planFiveHourUsedPercent;
  const sevenDay = Array.isArray(effectiveCredits?.productUsage)
    ? effectiveCredits.productUsage.find(p => p?.periodType === 'seven_day')
    : null;
  const sevenDayPct = sevenDay?.usagePercent ?? usage.planSevenDayUsedPercent;
  if (typeof fiveHourPct === 'number' || typeof sevenDayPct === 'number') {
    const parts = [];
    if (typeof fiveHourPct === 'number') {
      const reset = formatResetTime(effectiveCredits?.resetsAt ?? usage.planFiveHourResetsAtUnix, nowMs);
      parts.push(`5h ${formatPercent(fiveHourPct)}${reset ? ` (${reset})` : ''}`);
    }
    if (typeof sevenDayPct === 'number') {
      const reset = formatResetTime(sevenDay?.resetsAt ?? usage.planSevenDayResetsAtUnix, nowMs);
      parts.push(`7d ${formatPercent(sevenDayPct)}${reset ? ` (${reset})` : ''}`);
    }
    lines.push(`- **账号额度**：${parts.join(' · ')}`);
  }

  lines.push('- **已适配能力**：模型切换、按模型推理深度、权限模式/Plan 模式、上下文用量、`/usage` 额度查询、`/compact` 压缩、图片附件、交互式提问与计划审批、会话恢复与分支（Fork）、T3 原生 MCP 工具透传（Preview/HTML/Delegate 等）、本地 Skills/Commands 自动补全、Plan 任务面板与流式工具输出。');
  return lines.join('\n');
}

export function extractFileChangePresentation(item, sessionCwd) {
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  if (!changes.length) return { title: 'Edit files', locations: undefined, content: [] };

  const locations = [];
  const seen = new Set();
  const content = [];
  const summaryLines = [];

  for (const change of changes) {
    if (!change || typeof change !== 'object') continue;
    const rawPath = change.path ?? change.filePath ?? change.targetPath;
    const trimmedPath = typeof rawPath === 'string' && rawPath.trim()
      ? resolveWinPath(sessionCwd, rawPath.trim())
      : null;
    if (trimmedPath && !seen.has(trimmedPath.toLowerCase())) {
      seen.add(trimmedPath.toLowerCase());
      locations.push({ path: trimmedPath });
    }
    if (trimmedPath && typeof change.newText === 'string') {
      content.push({
        type: 'diff',
        path: trimmedPath,
        ...(typeof change.oldText === 'string' ? { oldText: change.oldText } : {}),
        newText: change.newText,
      });
    } else if (typeof change.unifiedDiff === 'string' && change.unifiedDiff.trim()) {
      summaryLines.push(change.unifiedDiff.trim());
    } else if (typeof change.diff === 'string' && change.diff.trim()) {
      summaryLines.push(change.diff.trim());
    } else if (typeof change.patch === 'string' && change.patch.trim()) {
      summaryLines.push(change.patch.trim());
    } else if (trimmedPath) {
      const action = change.kind ?? change.type ?? 'updated';
      summaryLines.push(`${action}: ${trimmedPath}`);
    }
  }

  if (summaryLines.length && !content.length) {
    content.push({ type: 'content', content: { type: 'text', text: summaryLines.join('\n\n') } });
  }

  const title = locations.length === 1
    ? `Edit ${path.win32.basename(locations[0].path)}`
    : locations.length > 1
      ? `Edit ${locations.length} files`
      : 'Edit files';

  return {
    title,
    locations: locations.length ? locations : undefined,
    content,
  };
}

const WORKSPACE_CMD_PREFIX_RE = /^\s*(?:\/usr\/local\/bin\/|\/[^\s'"]+\/)?windows-workspace\s+/;

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
    return {
      action,
      path: targetPath,
      ...(offsetMatch ? { offset: Number(offsetMatch[1]) } : {}),
      ...(limitMatch ? { limit: Number(limitMatch[1]) } : {}),
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

function parseWorkspaceEnvelope(output) {
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
    // Not a complete JSON envelope yet.
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
    if (op.action === 'edit' && typeof targetPath === 'string' && typeof op.oldText === 'string' && typeof op.newText === 'string') {
      out.push({ type: 'diff', path: targetPath, oldText: op.oldText, newText: op.newText });
    } else if (op.action === 'write' && typeof targetPath === 'string' && typeof op.content === 'string') {
      out.push({ type: 'diff', path: targetPath, newText: op.content });
    } else if (typeof data.change?.unifiedDiff === 'string' && data.change.unifiedDiff.trim()) {
      out.push({ type: 'content', content: { type: 'text', text: data.change.unifiedDiff.trim() } });
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

export function presentWorkspaceToolCall(item, sessionCwd, outcome) {
  if (!item || typeof item !== 'object') return null;
  const op = parseWorkspaceCommand(item.command);
  if (!op) return null;

  const rel = displayRelPath(sessionCwd, op.path);
  const abs = resolveWinPath(sessionCwd, op.path);
  const envelope = outcome ? parseWorkspaceEnvelope(item.output) : null;

  let title = `Workspace ${op.action}`;
  let kind = 'other';
  let name = 'Workspace';
  let locations = abs ? [{ path: abs }] : undefined;
  let rawInput = op;
  let content = [];

  if (op.action === 'read') {
    kind = 'read';
    name = 'Read';
    const range = Number.isInteger(op.offset) || Number.isInteger(op.limit)
      ? ` (L${(op.offset ?? 0) + 1}${op.limit ? `-${(op.offset ?? 0) + op.limit}` : '+'})`
      : '';
    title = `Read ${rel}${range}`;
    if (abs) locations = [{ path: abs, ...(Number.isInteger(op.offset) && op.offset > 0 ? { line: op.offset + 1 } : {}) }];
    rawInput = { path: op.path, ...(op.offset !== undefined ? { offset: op.offset } : {}), ...(op.limit !== undefined ? { limit: op.limit } : {}) };
  } else if (op.action === 'list') {
    kind = 'read';
    name = 'List';
    title = `List ${rel}`;
    rawInput = { path: op.path ?? '.' };
  } else if (op.action === 'search') {
    kind = 'search';
    name = 'Grep';
    const pat = compactOneLine(String(op.pattern ?? ''), 40);
    title = pat
      ? `Search "${pat}"${rel && rel !== '.' ? ` in ${rel}` : ''}`
      : `Search ${rel}`;
    rawInput = { pattern: op.pattern, path: op.path ?? '.' };
  } else if (op.action === 'edit') {
    kind = 'edit';
    name = 'Edit';
    title = `Edit ${rel}`;
    if (abs && typeof op.oldText === 'string' && typeof op.newText === 'string') {
      content.push({ type: 'diff', path: abs, oldText: op.oldText, newText: op.newText });
    }
    rawInput = { path: op.path, oldText: op.oldText, newText: op.newText };
  } else if (op.action === 'write') {
    kind = 'edit';
    name = 'Write';
    title = `Write ${rel}`;
    if (abs && typeof op.content === 'string') {
      content.push({ type: 'diff', path: abs, newText: op.content });
    }
    rawInput = { path: op.path };
  } else if (op.action === 'run') {
    kind = 'execute';
    name = typeof op.executable === 'string' && op.executable.trim() ? op.executable.trim() : 'PowerShell';
    const cmdText = typeof op.script === 'string' && op.script.trim()
      ? op.script.trim()
      : [op.executable, ...(Array.isArray(op.args) ? op.args : [])].filter(Boolean).join(' ');
    const summary = compactOneLine(cmdText, 76) || 'Run local command';
    title = summary;
    const workDir = resolveWinPath(sessionCwd, op.workingDirectory);
    locations = workDir ? [{ path: workDir }] : undefined;
    rawInput = { command: cmdText, ...(op.workingDirectory ? { workingDirectory: op.workingDirectory } : {}) };
  } else if (op.action === 'job' || op.action === 'jobs') {
    kind = 'execute';
    name = 'Task';
    title = op.action === 'jobs'
      ? 'List background tasks'
      : `Task ${op.operation ?? 'status'}${op.requestId ? ` (${op.requestId})` : ''}`;
    locations = undefined;
  } else if (op.action === 'batch') {
    kind = 'read';
    name = 'Batch';
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
    name = 'Skill';
    title = `Load ${op.id ?? 'capability'}`;
    locations = undefined;
  } else if (op.action === 'isolation') {
    kind = 'execute';
    name = 'Worktree';
    title = `Worktree ${op.operation ?? 'status'}`;
    locations = undefined;
  } else if (op.action === 'artifact' || op.action === 'media') {
    kind = 'read';
    name = op.action === 'media' ? 'Media' : 'Artifact';
    title = `${name} ${rel}`;
  } else if (op.action === 'agent') {
    kind = 'other';
    name = 'Agent';
    const argvText = Array.isArray(op.argv) ? compactOneLine(op.argv.join(' '), 60) : '';
    title = argvText ? `Agent ${argvText}` : 'Agent';
    locations = undefined;
  } else if (op.action === 'status' || op.action === 'info' || op.action === 'context') {
    kind = 'read';
    name = 'Workspace';
    title = `Inspect workspace ${op.action}`;
  }

  if (envelope) {
    const formatted = formatWorkspaceEnvelopeContent(op, envelope, abs, sessionCwd);
    if (formatted) content = formatted;
  }

  return {
    title,
    kind,
    name,
    locations,
    rawInput,
    content,
  };
}
