import { isInternalCompactionSystemText } from '../../common/coworkSystemMessages';
import {
  parseScheduledReminderPrompt,
  parseSimpleScheduledReminderText,
} from '../../scheduledTask/reminderText';

type GatewayHistoryRole = 'user' | 'assistant' | 'system';

export interface GatewayUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  /** Full prompt size used for ctx% (input + cache read + cache write). */
  promptTokens?: number;
}

export interface GatewayHistoryEntry {
  role: GatewayHistoryRole;
  text: string;
  timestamp?: number;
  usage?: GatewayUsage;
  model?: string;
  modelProvider?: string;
  mediaAttachments?: GatewayHistoryMediaAttachment[];
}

export interface GatewayModelIdentity {
  model: string;
  provider?: string;
  ref: string;
}

export interface GatewayHistoryMediaAttachment {
  localPath: string;
  mimeType?: string;
}

const HEARTBEAT_ACK_RE = /^[`*_~"'“”‘’()[\]{}<>.,!?;:，。！？；：\s-]{0,8}HEARTBEAT_OK[`*_~"'“”‘’()[\]{}<>.,!?;:，。！？；：\s-]{0,8}$/i;
const SILENT_REPLY_RE = /^[`*_~"'“”‘’()[\]{}<>.,!?;:，。！？；：\s-]{0,8}NO_REPLY[`*_~"'“”‘’()[\]{}<>.,!?;:，。！？；：\s-]{0,8}$/i;
const SILENT_REPLY_TOKEN = 'NO_REPLY';
const HEARTBEAT_PROMPT_MARKERS = [
  'read heartbeat.md if it exists',
  'when reading heartbeat.md',
  'reply heartbeat_ok',
  'do not infer or repeat old tasks from prior chats',
] as const;
const PRE_COMPACTION_MEMORY_FLUSH_MARKERS = [
  'pre-compaction memory flush',
  'store durable memories only in memory/',
  'reply with no_reply',
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
};

const normalizeTokenCount = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(Math.max(Math.trunc(value), 0), Number.MAX_SAFE_INTEGER);
};

const firstTokenCount = (
  record: Record<string, unknown>,
  keys: readonly string[],
): number | undefined => {
  for (const key of keys) {
    const value = normalizeTokenCount(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
};

const nestedTokenCount = (
  record: Record<string, unknown>,
  parentKey: string,
  childKey: string,
): number | undefined => {
  const parent = record[parentKey];
  return isRecord(parent) ? normalizeTokenCount(parent[childKey]) : undefined;
};

export const normalizeGatewayHistoryModel = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const model = value.trim();
  return model && model !== 'gateway-injected' ? model : undefined;
};

const normalizeGatewayModelProvider = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const provider = value.trim();
  return provider || undefined;
};

/**
 * Normalize OpenClaw's two model identity shapes: transcript messages may use
 * either `provider/model` or separate `provider` + `model`, while sessionInfo
 * uses `modelProvider` + `model`. The full ref is suitable for provider-aware
 * model-catalog lookups without changing the user-visible model label.
 */
export const normalizeGatewayModelIdentity = (
  modelValue: unknown,
  providerValue?: unknown,
): GatewayModelIdentity | undefined => {
  const rawModel = normalizeGatewayHistoryModel(modelValue);
  if (!rawModel) return undefined;

  const explicitProvider = normalizeGatewayModelProvider(providerValue);
  const slashIndex = rawModel.indexOf('/');
  const hasExplicitProviderPrefix = Boolean(
    explicitProvider && rawModel.startsWith(`${explicitProvider}/`),
  );
  const inferredProvider = !explicitProvider && slashIndex > 0
    ? rawModel.slice(0, slashIndex).trim()
    : undefined;
  const model = hasExplicitProviderPrefix
    ? rawModel.slice((explicitProvider?.length ?? 0) + 1).trim()
    : !explicitProvider && slashIndex > 0
      ? rawModel.slice(slashIndex + 1).trim()
      : rawModel;
  if (!model) return undefined;
  const provider = explicitProvider ?? inferredProvider;
  return {
    model,
    ...(provider ? { provider } : {}),
    ref: provider ? `${provider}/${model}` : model,
  };
};

/**
 * sessionInfo describes the session's current model, which can already have
 * changed after the target assistant completed. Only lend its context window
 * when it can prove compatibility with the target message model.
 */
export const isGatewaySessionModelCompatible = (
  targetModel: unknown,
  targetProvider: unknown,
  sessionModel: unknown,
  sessionProvider: unknown,
): boolean => {
  const target = normalizeGatewayModelIdentity(targetModel, targetProvider);
  if (!target) return false;
  const session = normalizeGatewayModelIdentity(sessionModel, sessionProvider);
  if (!session || target.model !== session.model) return false;
  if (Boolean(target.provider) !== Boolean(session.provider)) return false;
  if (target.provider !== session.provider) return false;
  return true;
};

export interface GatewaySessionInfoContext {
  applies: boolean;
  model?: string;
  modelProvider?: string;
  contextTokens?: number;
  hasActiveRun: boolean;
  hasActiveExecution: boolean;
  hasTerminalExecution: boolean;
}

export const resolveGatewaySessionInfoContext = (
  targetModel: unknown,
  targetProvider: unknown,
  rawSessionInfo: unknown,
): GatewaySessionInfoContext => {
  const sessionInfo = isRecord(rawSessionInfo) ? rawSessionInfo : undefined;
  const model = normalizeGatewayHistoryModel(sessionInfo?.model);
  const modelProvider = normalizeGatewayModelProvider(
    sessionInfo?.modelProvider ?? sessionInfo?.provider,
  );
  const applies = Boolean(sessionInfo) && isGatewaySessionModelCompatible(
    targetModel,
    targetProvider,
    model,
    modelProvider,
  );
  const contextTokens = applies
    ? normalizeTokenCount(sessionInfo?.contextTokens)
    : undefined;
  const status = typeof sessionInfo?.status === 'string'
    ? sessionInfo.status.trim().toLowerCase()
    : '';
  const subagentRunState = typeof sessionInfo?.subagentRunState === 'string'
    ? sessionInfo.subagentRunState.trim().toLowerCase()
    : '';
  const hasActiveRun = sessionInfo?.hasActiveRun === true;
  const activeStates = ['running', 'active', 'streaming'];
  const terminalStatuses = ['done', 'failed', 'killed', 'timeout', 'completed', 'idle'];
  const terminalSubagentStates = ['historical', 'interrupted'];
  const hasActiveExecution = hasActiveRun
    || sessionInfo?.hasActiveSubagentRun === true
    // A concrete subagent state is more specific than the parent/session
    // status. In particular, historical/interrupted must not be reactivated by
    // a stale `status: running` field from the enclosing session row.
    || (subagentRunState
      ? activeStates.includes(subagentRunState)
      : activeStates.includes(status));
  const hasTerminalExecution = !hasActiveExecution && (subagentRunState
    ? terminalSubagentStates.includes(subagentRunState)
    : terminalStatuses.includes(status));
  return {
    applies,
    ...(model ? { model } : {}),
    ...(modelProvider ? { modelProvider } : {}),
    ...(contextTokens != null && contextTokens > 0 ? { contextTokens } : {}),
    hasActiveRun,
    hasActiveExecution,
    hasTerminalExecution,
  };
};

/**
 * Normalize usage emitted by OpenClaw transcripts and provider-compatible
 * payloads. OpenClaw v2026.6.1 chat.history preserves the documented scalar
 * subset; direct/provider payloads may additionally contain llama-style fields
 * and nested OpenAI cache details handled here for compatibility.
 */
export const normalizeGatewayUsage = (rawUsage: unknown): GatewayUsage | undefined => {
  if (!isRecord(rawUsage)) return undefined;

  const explicitCacheRead = firstTokenCount(rawUsage, [
    'cacheRead',
    'cacheReadTokens',
    'cache_read',
    'cache_read_input_tokens',
  ]);
  const openAiCacheRead = firstTokenCount(rawUsage, ['cached_tokens'])
    ?? nestedTokenCount(rawUsage, 'input_tokens_details', 'cached_tokens')
    ?? nestedTokenCount(rawUsage, 'prompt_tokens_details', 'cached_tokens');
  const cacheRead = explicitCacheRead ?? openAiCacheRead;
  const cacheWrite = firstTokenCount(rawUsage, [
    'cacheWrite',
    'cacheWriteTokens',
    'cache_write',
    'cache_creation_input_tokens',
  ]);

  const rawInput = firstTokenCount(rawUsage, [
    'input',
    'inputTokens',
    'input_tokens',
    'promptTokens',
    'prompt_tokens',
    'prompt_n',
  ]) ?? nestedTokenCount(rawUsage, 'timings', 'prompt_n');
  const usesOpenAiStylePromptTotals = rawUsage.cached_tokens !== undefined
    || (isRecord(rawUsage.input_tokens_details)
      && rawUsage.input_tokens_details.cached_tokens !== undefined)
    || (isRecord(rawUsage.prompt_tokens_details)
      && rawUsage.prompt_tokens_details.cached_tokens !== undefined);
  const input = rawInput != null && usesOpenAiStylePromptTotals && cacheRead != null
    ? Math.max(rawInput - cacheRead, 0)
    : rawInput;
  const output = firstTokenCount(rawUsage, [
    'output',
    'outputTokens',
    'output_tokens',
    'completionTokens',
    'completion_tokens',
    'predicted_n',
  ]) ?? nestedTokenCount(rawUsage, 'timings', 'predicted_n');
  const totalTokens = firstTokenCount(rawUsage, ['total', 'totalTokens', 'total_tokens']);
  const promptTokens = input != null
    ? Math.min(input + (cacheRead ?? 0) + (cacheWrite ?? 0), Number.MAX_SAFE_INTEGER)
    : undefined;

  if (
    input == null
    && output == null
    && cacheRead == null
    && cacheWrite == null
    && totalTokens == null
  ) {
    return undefined;
  }

  return {
    ...(input != null && { input }),
    ...(output != null && { output }),
    ...(cacheRead != null && { cacheRead }),
    ...(cacheWrite != null && { cacheWrite }),
    ...(totalTokens != null && { totalTokens }),
    ...(promptTokens != null && { promptTokens }),
  };
};

export const calculateGatewayContextPercent = (
  usage: GatewayUsage | undefined,
  contextTokens: number | undefined,
): number | undefined => {
  const hasPromptUsage = usage?.input != null
    || usage?.cacheRead != null
    || usage?.cacheWrite != null;
  if (
    !hasPromptUsage
    || typeof contextTokens !== 'number'
    || !Number.isFinite(contextTokens)
    || contextTokens <= 0
  ) {
    return undefined;
  }

  const promptTokens = usage?.promptTokens ?? (
    (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0)
  );
  if (!Number.isFinite(promptTokens) || promptTokens < 0) return undefined;

  return Math.min(Math.round((promptTokens / contextTokens) * 100), 100);
};

/**
 * Merge two representations of the same API-call usage snapshot. The message
 * payload is preferred field-by-field, while a top-level protocol payload can
 * fill aliases that an intermediary omitted. Canonical input is already
 * uncached, so promptTokens can be safely recomputed after the merge.
 */
export const mergeGatewayUsageSnapshots = (
  preferred: GatewayUsage | undefined,
  fallback: GatewayUsage | undefined,
): GatewayUsage | undefined => {
  if (!preferred && !fallback) return undefined;

  const input = preferred?.input ?? fallback?.input;
  const output = preferred?.output ?? fallback?.output;
  const cacheRead = preferred?.cacheRead ?? fallback?.cacheRead;
  const cacheWrite = preferred?.cacheWrite ?? fallback?.cacheWrite;
  const totalTokens = preferred?.totalTokens ?? fallback?.totalTokens;
  const hasPromptUsage = input != null || cacheRead != null || cacheWrite != null;
  const promptTokens = hasPromptUsage
    ? Math.min(
      (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0),
      Number.MAX_SAFE_INTEGER,
    )
    : undefined;

  return {
    ...(input != null && { input }),
    ...(output != null && { output }),
    ...(cacheRead != null && { cacheRead }),
    ...(cacheWrite != null && { cacheWrite }),
    ...(totalTokens != null && { totalTokens }),
    ...(promptTokens != null && { promptTokens }),
  };
};

const sumUsageField = (
  usages: ReadonlyArray<GatewayUsage>,
  field: 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'totalTokens',
): number | undefined => {
  let hasValue = false;
  let total = 0;
  for (const usage of usages) {
    const value = usage[field];
    if (value == null) continue;
    hasValue = true;
    total = Math.min(total + value, Number.MAX_SAFE_INTEGER);
  }
  return hasValue ? total : undefined;
};

/**
 * Match OpenClaw v2026.6.1 message-group usage semantics: token counters are
 * summed across assistant calls while ctx% uses the largest single-call prompt.
 */
export const aggregateGatewayUsage = (
  candidates: ReadonlyArray<GatewayUsage | undefined>,
): GatewayUsage | undefined => {
  const usages = candidates.filter((usage): usage is GatewayUsage => usage != null);
  if (usages.length === 0) return undefined;

  const input = sumUsageField(usages, 'input');
  const output = sumUsageField(usages, 'output');
  const cacheRead = sumUsageField(usages, 'cacheRead');
  const cacheWrite = sumUsageField(usages, 'cacheWrite');
  const totalTokens = usages.every(usage => usage.totalTokens != null)
    ? sumUsageField(usages, 'totalTokens')
    : undefined;
  let hasPromptTokens = false;
  let promptTokens = 0;
  for (const usage of usages) {
    const hasPromptUsage = usage.input != null
      || usage.cacheRead != null
      || usage.cacheWrite != null;
    if (!hasPromptUsage) continue;
    hasPromptTokens = true;
    const callPromptTokens = usage.promptTokens ?? Math.min(
      (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
      Number.MAX_SAFE_INTEGER,
    );
    promptTokens = Math.max(promptTokens, callPromptTokens);
  }

  return {
    ...(input != null && { input }),
    ...(output != null && { output }),
    ...(cacheRead != null && { cacheRead }),
    ...(cacheWrite != null && { cacheWrite }),
    ...(totalTokens != null && { totalTokens }),
    ...(hasPromptTokens && { promptTokens }),
  };
};

const collectTextChunks = (value: unknown): string[] => {
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? [text] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectTextChunks(item));
  }

  if (!isRecord(value)) {
    return [];
  }

  const chunks: string[] = [];
  if (typeof value.text === 'string') {
    const text = value.text.trim();
    if (text) {
      chunks.push(text);
    }
  }
  // Skip thinking blocks from regular text extraction (handled separately)
  // if (value.type === 'thinking') → see collectThinkingChunks()

  if (value.content !== undefined) {
    chunks.push(...collectTextChunks(value.content));
  }
  if (value.parts !== undefined) {
    chunks.push(...collectTextChunks(value.parts));
  }

  return chunks;
};

const parseGatewayTimestamp = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const extractGatewayTimestamp = (message: Record<string, unknown>): number | undefined => {
  return parseGatewayTimestamp(message.timestamp)
    ?? parseGatewayTimestamp(message.createdAt)
    ?? parseGatewayTimestamp(message.created_at)
    ?? parseGatewayTimestamp(message.time);
};

const getStringArrayField = (message: Record<string, unknown>, keys: string[]): string[] => {
  for (const key of keys) {
    const value = message[key];
    if (typeof value === 'string' && value.trim()) {
      return [value.trim()];
    }
    if (Array.isArray(value)) {
      return value
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean);
    }
  }
  return [];
};

const extractGatewayMediaAttachments = (message: Record<string, unknown>): GatewayHistoryMediaAttachment[] | undefined => {
  const paths = getStringArrayField(message, ['MediaPaths', 'mediaPaths', 'MediaPath', 'mediaPath']);
  if (paths.length === 0) {
    return undefined;
  }

  const mimeTypes = getStringArrayField(message, ['MediaTypes', 'mediaTypes', 'MediaType', 'mediaType']);
  const seen = new Set<string>();
  const attachments: GatewayHistoryMediaAttachment[] = [];
  for (let index = 0; index < paths.length; index += 1) {
    const localPath = paths[index];
    const key = localPath.replace(/\\/g, '/').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const mimeType = mimeTypes[index] || mimeTypes[0];
    attachments.push({
      localPath,
      ...(mimeType ? { mimeType } : {}),
    });
  }

  return attachments.length > 0 ? attachments : undefined;
};

export const extractGatewayMessageText = (message: unknown): string => {
  if (typeof message === 'string') {
    return message;
  }
  if (!isRecord(message)) {
    return '';
  }

  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const chunks = collectTextChunks(content);
    if (chunks.length > 0) {
      return chunks.join('\n');
    }
  }
  if (isRecord(content)) {
    const chunks = collectTextChunks(content);
    if (chunks.length > 0) {
      return chunks.join('\n');
    }
  }
  if (typeof message.text === 'string') {
    return message.text;
  }
  return '';
};

const collectThinkingChunks = (value: unknown): string[] => {
  if (typeof value === 'string') return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectThinkingChunks(item));
  }
  if (!isRecord(value)) return [];

  const chunks: string[] = [];
  if (value.type === 'thinking' && typeof value.thinking === 'string') {
    const thinking = value.thinking.trim();
    if (thinking) {
      chunks.push(thinking);
    }
  }
  for (const key of ['reasoning_content', 'reasoning', 'reasoning_text'] as const) {
    if (typeof value[key] === 'string') {
      const thinking = value[key].trim();
      if (thinking) {
        chunks.push(thinking);
      }
    }
  }
  if (value.content !== undefined) {
    chunks.push(...collectThinkingChunks(value.content));
  }
  if (value.parts !== undefined) {
    chunks.push(...collectThinkingChunks(value.parts));
  }
  return chunks;
};

export const extractGatewayMessageThinking = (message: unknown): string => {
  if (!isRecord(message)) return '';
  return collectThinkingChunks(message).join('\n\n').trim();
};

export const buildScheduledReminderSystemMessage = (text: string): string | null => {
  const parsed = parseScheduledReminderPrompt(text);
  if (!parsed) {
    return parseSimpleScheduledReminderText(text)?.reminderText ?? null;
  }

  return parsed.reminderText;
};

export const isHeartbeatAckText = (text: string): boolean => HEARTBEAT_ACK_RE.test(text.trim());

export const isSilentReplyText = (text: string): boolean => SILENT_REPLY_RE.test(text.trim());

export const isSilentReplyPrefixText = (text: string): boolean => {
  const trimmed = text.trimStart();
  if (!trimmed || trimmed.length < 2) return false;
  if (isSilentReplyText(trimmed)) return false;
  if (trimmed !== trimmed.toUpperCase()) return false;
  if (/[^A-Z_]/.test(trimmed)) return false;
  const tokenUpper = SILENT_REPLY_TOKEN.toUpperCase();
  if (!tokenUpper.startsWith(trimmed)) return false;
  if (trimmed.includes('_')) return true;
  return trimmed === 'NO';
};

const TRAILING_SILENT_REPLY_RE = /\n\s*NO_REPLY\s*$/i;

export const stripTrailingSilentReplyToken = (text: string): string => {
  return text.replace(TRAILING_SILENT_REPLY_RE, '').trimEnd();
};

const TRAILING_SILENT_REPLY_PARTIAL_TOKENS = [
  'NO_REPLY', 'NO_REPL', 'NO_REP', 'NO_RE', 'NO_R', 'NO_', 'NO',
];

export const stripTrailingSilentReplyTail = (text: string): string => {
  const stripped = text.replace(TRAILING_SILENT_REPLY_RE, '');
  if (stripped !== text) return stripped.trimEnd();
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline < 0) return text;
  const tail = text.slice(lastNewline + 1).trim().toUpperCase();
  if (!tail) return text;
  for (const token of TRAILING_SILENT_REPLY_PARTIAL_TOKENS) {
    if (tail === token) {
      return text.slice(0, lastNewline).trimEnd();
    }
  }
  return text;
};

export const isHeartbeatPromptText = (text: string): boolean => {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return HEARTBEAT_PROMPT_MARKERS.every((marker) => normalized.includes(marker));
};

export const isPreCompactionMemoryFlushPromptText = (text: string): boolean => {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return PRE_COMPACTION_MEMORY_FLUSH_MARKERS.every((marker) => normalized.includes(marker));
};

export const shouldSuppressHeartbeatText = (role: GatewayHistoryRole, text: string): boolean => {
  if ((role === 'assistant' || role === 'system') && (isHeartbeatAckText(text) || isSilentReplyText(text))) {
    return true;
  }
  if (role === 'user' && (isHeartbeatPromptText(text) || isPreCompactionMemoryFlushPromptText(text))) {
    return true;
  }
  return false;
};

export const extractGatewayHistoryEntry = (message: unknown): GatewayHistoryEntry | null => {
  if (!isRecord(message)) {
    return null;
  }

  const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
  if (role !== 'user' && role !== 'assistant' && role !== 'system') {
    return null;
  }

  let text = extractGatewayMessageText(message).trim();
  const mediaAttachments = extractGatewayMediaAttachments(message);
  if (!text && !(role === 'user' && mediaAttachments?.length)) {
    return null;
  }
  if (role === 'assistant') {
    text = stripTrailingSilentReplyToken(text);
    if (!text) {
      return null;
    }
  }
  if (shouldSuppressHeartbeatText(role, text)) {
    return null;
  }
  if (role === 'system' && isInternalCompactionSystemText(text)) {
    return null;
  }

  const reminderSystemMessage = role === 'user'
    ? buildScheduledReminderSystemMessage(text)
    : null;
  const timestamp = extractGatewayTimestamp(message);
  if (reminderSystemMessage) {
    return {
      role: 'system',
      text: reminderSystemMessage,
      ...(timestamp != null && { timestamp }),
    };
  }

  // Extract usage and model for assistant messages
  let usage: GatewayUsage | undefined;
  let model: string | undefined;
  let modelProvider: string | undefined;
  if (role === 'assistant') {
    usage = normalizeGatewayUsage(message.usage);
    model = normalizeGatewayHistoryModel(message.model);
    if (model) {
      modelProvider = normalizeGatewayModelProvider(message.provider ?? message.modelProvider);
    }
  }

  return {
    role,
    text,
    ...(timestamp != null && { timestamp }),
    ...(usage && { usage }),
    ...(model && { model }),
    ...(modelProvider && { modelProvider }),
    ...(mediaAttachments && { mediaAttachments }),
  };
};

export const extractGatewayHistoryEntries = (messages: unknown[]): GatewayHistoryEntry[] => {
  return messages
    .map((message) => extractGatewayHistoryEntry(message))
    .filter((entry): entry is GatewayHistoryEntry => entry !== null);
};

export interface GatewayAssistantTurnUsage {
  startIndex: number;
  endIndex: number;
  targetAssistantIndex?: number;
  usage?: GatewayUsage;
  model?: string;
  modelProvider?: string;
}

const getGatewayHistoryRole = (message: unknown): string => {
  if (!isRecord(message) || typeof message.role !== 'string') return '';
  return message.role.trim().toLowerCase();
};

const isVisibleGatewayAssistantMessage = (message: unknown): boolean => {
  if (getGatewayHistoryRole(message) !== 'assistant') return false;
  const text = stripTrailingSilentReplyToken(extractGatewayMessageText(message)).trim();
  return Boolean(text && !shouldSuppressHeartbeatText('assistant', text));
};

const hasGatewayUsageBreakdown = (usage: GatewayUsage | undefined): boolean => {
  return usage?.input != null
    || usage?.output != null
    || usage?.cacheRead != null
    || usage?.cacheWrite != null;
};

export const extractGatewayAssistantTurnUsages = (
  messages: unknown[],
): GatewayAssistantTurnUsage[] => {
  const turns: GatewayAssistantTurnUsage[] = [];

  const appendTurn = (startIndex: number, endIndex: number): void => {
    if (endIndex < startIndex) return;
    const usages: GatewayUsage[] = [];
    let model: string | undefined;
    let modelProvider: string | undefined;
    let targetAssistantIndex: number | undefined;

    for (let index = startIndex; index <= endIndex; index += 1) {
      const message = messages[index];
      if (getGatewayHistoryRole(message) !== 'assistant') continue;
      const rawText = extractGatewayMessageText(message).trim();
      // Pure housekeeping acknowledgements are intentionally invisible. Their
      // usage/model belongs to that hidden maintenance call and must not be
      // folded into an earlier visible reply when a bounded history window no
      // longer contains the internal user boundary. Tool-only assistant calls
      // have no text and still participate in the turn aggregate.
      if (rawText && shouldSuppressHeartbeatText('assistant', rawText)) continue;
      const record = isRecord(message) ? message : undefined;
      const usage = normalizeGatewayUsage(record?.usage);
      const callModel = normalizeGatewayHistoryModel(record?.model);
      if (usage) usages.push(usage);
      if (callModel) {
        model = callModel;
        modelProvider = normalizeGatewayModelProvider(record?.provider ?? record?.modelProvider);
      }
      if (isVisibleGatewayAssistantMessage(message)) {
        targetAssistantIndex = index;
      }
    }
    const usage = aggregateGatewayUsage(usages);
    turns.push({
      startIndex,
      endIndex,
      ...(targetAssistantIndex != null && { targetAssistantIndex }),
      ...(usage && { usage }),
      ...(model && { model }),
      ...(modelProvider && { modelProvider }),
    });
  };

  let turnStartIndex = 0;
  for (let index = 0; index < messages.length; index += 1) {
    if (getGatewayHistoryRole(messages[index]) !== 'user') continue;
    if (index > turnStartIndex) {
      appendTurn(turnStartIndex, index - 1);
    }
    turnStartIndex = index;
  }
  appendTurn(turnStartIndex, messages.length - 1);

  return turns;
};

/**
 * Extract visible history entries and attach metadata only to the last visible
 * assistant in each user turn. Tool-call-only assistant records still
 * contribute to the aggregate without changing the visible message topology.
 * The aggregate is withheld until the target visible call has its own usage,
 * preventing a lagging transcript from permanently persisting a partial sum.
 */
export const extractGatewayHistoryEntriesWithTurnUsage = (
  messages: unknown[],
): GatewayHistoryEntry[] => {
  const turnByTargetIndex = new Map(
    extractGatewayAssistantTurnUsages(messages)
      .filter((turn) => turn.targetAssistantIndex != null)
      .map((turn) => [turn.targetAssistantIndex as number, turn]),
  );

  const entries: GatewayHistoryEntry[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const entry = extractGatewayHistoryEntry(messages[index]);
    if (!entry) continue;
    const turn = turnByTargetIndex.get(index);
    if (entry.role === 'assistant') {
      const metadataFreeEntry = { ...entry };
      delete metadataFreeEntry.usage;
      delete metadataFreeEntry.model;
      delete metadataFreeEntry.modelProvider;
      if (!turn) {
        entries.push(metadataFreeEntry);
        continue;
      }
      const targetMessage = messages[index];
      const record = isRecord(targetMessage) ? targetMessage : undefined;
      const targetCallUsage = normalizeGatewayUsage(record?.usage);
      entries.push({
        ...metadataFreeEntry,
        ...(turn.usage && hasGatewayUsageBreakdown(targetCallUsage)
          ? { usage: turn.usage }
          : {}),
        ...(turn.model ? { model: turn.model } : {}),
        ...(turn.modelProvider ? { modelProvider: turn.modelProvider } : {}),
      });
      continue;
    }
    entries.push(entry);
  }

  return entries;
};
