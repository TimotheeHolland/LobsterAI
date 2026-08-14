import { OpenClawCronRunMetadataKey } from '../../../shared/cowork/openclawCronSessionKey';
import type { CoworkMessage } from '../../coworkStore';
import {
  calculateGatewayContextPercent,
  extractGatewayAssistantTurnUsages,
  extractGatewayHistoryEntriesWithTurnUsage,
  normalizeGatewayModelIdentity,
  shouldSuppressHeartbeatText,
} from '../openclawHistory';
import {
  isSameHistoryEntry,
  type ReconciledConversationEntry,
} from './openclawConversationReconciliation';

export type CronRunHistoryEntry = ReconciledConversationEntry;

export type CronRunLocalHistoryEntry = CronRunHistoryEntry & {
  id: string;
  originalText: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
};

export const getCronRunHistorySessionKey = (metadata: unknown): string | null => {
  if (!isRecord(metadata)) return null;
  const value = metadata[OpenClawCronRunMetadataKey.SessionKey];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

const getCronRunHistoryEntryIndex = (metadata: unknown): number | null => {
  if (!isRecord(metadata)) return null;
  const value = metadata[OpenClawCronRunMetadataKey.EntryIndex];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
};

const withCronRunHistoryMetadata = (
  entry: CronRunHistoryEntry,
  sessionKey: string,
  entryIndex: number,
): CronRunHistoryEntry => ({
  ...entry,
  metadata: {
    ...(entry.metadata ?? {}),
    [OpenClawCronRunMetadataKey.SessionKey]: sessionKey,
    [OpenClawCronRunMetadataKey.EntryIndex]: entryIndex,
  },
});

export const buildCronRunHistoryEntries = (
  historyMessages: unknown[],
  sessionKey: string,
  contextTokens?: number,
  options: { latestTurnActive?: boolean } = {},
): CronRunHistoryEntry[] => {
  const entries: CronRunHistoryEntry[] = [];
  const historyEntries = extractGatewayHistoryEntriesWithTurnUsage(historyMessages);
  const latestTurn = extractGatewayAssistantTurnUsages(historyMessages).at(-1);
  const latestAssistantEntryIndex = latestTurn?.targetAssistantIndex != null
    ? historyEntries.findLastIndex(entry => entry.role === 'assistant')
    : -1;

  for (let historyEntryIndex = 0; historyEntryIndex < historyEntries.length; historyEntryIndex += 1) {
    const entry = historyEntries[historyEntryIndex];
    const role = entry.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = entry.text.trim();
    if (!text || shouldSuppressHeartbeatText(role, text)) continue;

    let metadata: Record<string, unknown> | undefined;
    if (role === 'assistant') {
      const isActiveLatestTurn = historyEntryIndex === latestAssistantEntryIndex
        && options.latestTurnActive === true;
      const usage = isActiveLatestTurn ? undefined : entry.usage;
      if (usage || entry.model || isActiveLatestTurn) {
        metadata = isActiveLatestTurn
          ? { isStreaming: true, isFinal: false }
          : {};
      }
      if (usage && metadata) {
        metadata.usage = {
          ...(usage.input != null && { inputTokens: usage.input }),
          ...(usage.output != null && { outputTokens: usage.output }),
          ...(usage.cacheRead != null && { cacheReadTokens: usage.cacheRead }),
          ...(usage.cacheWrite != null && { cacheWriteTokens: usage.cacheWrite }),
        };
      }
      if (entry.model && metadata) {
        metadata.model = normalizeGatewayModelIdentity(
          entry.model,
          entry.modelProvider,
        )?.ref ?? entry.model;
      }
      if (historyEntryIndex === latestAssistantEntryIndex && !isActiveLatestTurn && metadata) {
        const contextPercent = calculateGatewayContextPercent(usage, contextTokens);
        if (contextPercent != null) {
          metadata.contextPercent = contextPercent;
        }
      }
    }

    entries.push(withCronRunHistoryMetadata({
      role,
      text,
      ...(metadata && { metadata }),
      ...(entry.timestamp != null && { timestamp: entry.timestamp }),
    }, sessionKey, entries.length));
  }

  return entries;
};

export const buildCronRunLocalHistoryEntries = (
  messages: CoworkMessage[],
): CronRunLocalHistoryEntry[] => {
  return messages
    .filter((message) => message.type === 'user' || message.type === 'assistant')
    .map((message) => ({
      id: message.id,
      role: message.type as 'user' | 'assistant',
      text: message.content.trim(),
      originalText: message.content,
      metadata: isRecord(message.metadata) ? message.metadata : undefined,
      timestamp: message.timestamp,
    }))
    .filter((entry) => entry.text && !shouldSuppressHeartbeatText(entry.role, entry.text));
};

export const hasCronRunHistoryForSession = (
  messages: CoworkMessage[],
  sessionKey: string,
): boolean => {
  return messages.some((message) => getCronRunHistorySessionKey(message.metadata) === sessionKey);
};

export const isLocalConversationCoveredByCronHistory = (
  localEntries: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>,
  authoritativeEntries: ReadonlyArray<CronRunHistoryEntry>,
): boolean => {
  if (localEntries.length > authoritativeEntries.length) return false;

  // The first authoritative fetch commonly repairs a locally persisted
  // streaming assistant row. When topology and user anchors are identical,
  // assistant text is allowed to change from partial to final and the caller
  // performs one metadata-preserving replacement.
  if (
    localEntries.length === authoritativeEntries.length
    && localEntries.every((local, index) => (
      local.role === authoritativeEntries[index].role
      && (local.role !== 'user' || local.text === authoritativeEntries[index].text)
    ))
  ) {
    return true;
  }

  let authIdx = 0;
  for (const local of localEntries) {
    let matched = false;
    while (authIdx < authoritativeEntries.length) {
      const authoritative = authoritativeEntries[authIdx++];
      if (isSameHistoryEntry(local, authoritative)) {
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }
  return true;
};

export const shouldReplaceLocalConversationWithCronHistory = (
  localEntries: ReadonlyArray<CronRunLocalHistoryEntry>,
  authoritativeEntries: ReadonlyArray<CronRunHistoryEntry>,
  sessionKey: string,
): boolean => {
  const hasOtherCronRunHistory = localEntries.some((entry) => {
    const importedSessionKey = getCronRunHistorySessionKey(entry.metadata);
    return Boolean(importedSessionKey && importedSessionKey !== sessionKey);
  });

  return !hasOtherCronRunHistory
    && isLocalConversationCoveredByCronHistory(localEntries, authoritativeEntries);
};

export const findCronRunHistoryLocalMatch = (
  authoritative: CronRunHistoryEntry,
  localEntries: ReadonlyArray<CronRunLocalHistoryEntry>,
  usedLocalMessageIds: ReadonlySet<string>,
  sessionKey: string,
  allowedCurrentRunUntaggedMessageIds: ReadonlySet<string> = new Set(),
): CronRunLocalHistoryEntry | undefined => {
  const authoritativeEntryIndex = getCronRunHistoryEntryIndex(authoritative.metadata);
  if (authoritativeEntryIndex != null) {
    const indexedMatch = localEntries.find((entry) => (
      !usedLocalMessageIds.has(entry.id)
      && entry.role === authoritative.role
      && getCronRunHistorySessionKey(entry.metadata) === sessionKey
      && getCronRunHistoryEntryIndex(entry.metadata) === authoritativeEntryIndex
    ));
    if (indexedMatch) return indexedMatch;
  }

  const hasOtherCronRunHistory = localEntries.some((entry) => {
    const importedSessionKey = getCronRunHistorySessionKey(entry.metadata);
    return Boolean(importedSessionKey && importedSessionKey !== sessionKey);
  });
  if (hasOtherCronRunHistory && allowedCurrentRunUntaggedMessageIds.size === 0) {
    // Once another run is present, an untagged identical row can be an
    // ordinary user follow-up. Text alone cannot prove ownership by this run.
    return undefined;
  }

  if (hasOtherCronRunHistory) {
    // Only explicit assistant ids and user ids recorded by this turn's
    // successful gateway prefetch are strongly bound to the run-scoped key.
    // Never infer the preceding local user: it may be an ordinary follow-up
    // when gateway user history is still lagging.
    const currentRunCandidates = localEntries.filter((entry) => (
      allowedCurrentRunUntaggedMessageIds.has(entry.id)
      && !getCronRunHistorySessionKey(entry.metadata)
      && !usedLocalMessageIds.has(entry.id)
      && entry.role === authoritative.role
    ));
    const exactMatches = currentRunCandidates.filter(entry => (
      isSameHistoryEntry(entry, authoritative)
    ));
    if (exactMatches.length === 1) return exactMatches[0];
    if (authoritative.role === 'assistant' && currentRunCandidates.length === 1) {
      // A single strongly-bound streaming assistant can be corrected from its
      // partial text to the final authoritative run entry.
      return currentRunCandidates[0];
    }
    return undefined;
  }

  const untaggedMatches = localEntries.filter((entry) => {
    if (usedLocalMessageIds.has(entry.id)) return false;
    if (!isSameHistoryEntry(entry, authoritative)) return false;
    const importedSessionKey = getCronRunHistorySessionKey(entry.metadata);
    return !importedSessionKey;
  });
  // Without the stable run/index marker, repeated text from another run or a
  // user follow-up is indistinguishable. Do not mutate an arbitrary row; the
  // caller can append the authoritative entry and future syncs will use its
  // stable marker.
  return untaggedMatches.length === 1 ? untaggedMatches[0] : undefined;
};
