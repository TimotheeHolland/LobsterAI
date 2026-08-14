import type { CoworkMessage } from '../../../coworkStore';
import { shouldSuppressHeartbeatText } from '../../openclawHistory';
import {
  parseSubagentGatewayHistoryMessages,
  type ParseSubagentGatewayHistoryOptions,
} from './historyParser';

export type SubagentChildHistorySyncPlan = {
  changed: boolean;
  cursor: number;
  entriesToStore: SubagentChildHistoryEntry[];
  localEntries: SubagentChildHistoryEntry[];
};

export type SubagentChildHistoryEntry = {
  type: CoworkMessage['type'];
  content: string;
  metadata?: Record<string, unknown>;
  timestamp?: number;
};

const normalizeMetadata = (metadata: CoworkMessage['metadata']): Record<string, unknown> | undefined => (
  metadata ? { ...metadata } : undefined
);

const sortForStableJson = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortForStableJson);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortForStableJson((value as Record<string, unknown>)[key]);
  }
  return sorted;
};

const stableJson = (value: unknown): string => JSON.stringify(sortForStableJson(value));

const mergeHistoryMetadata = (
  localMetadata: Record<string, unknown> | undefined,
  historyMetadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (!localMetadata && !historyMetadata) return undefined;
  const localUsage = localMetadata?.usage;
  const historyUsage = historyMetadata?.usage;
  const mergedUsage = (
    (localUsage && typeof localUsage === 'object' && !Array.isArray(localUsage))
    || (historyUsage && typeof historyUsage === 'object' && !Array.isArray(historyUsage))
  ) ? {
      ...(localUsage && typeof localUsage === 'object' && !Array.isArray(localUsage)
        ? localUsage as Record<string, unknown>
        : {}),
      ...(historyUsage && typeof historyUsage === 'object' && !Array.isArray(historyUsage)
        ? historyUsage as Record<string, unknown>
        : {}),
    } : undefined;

  const mergedMetadata: Record<string, unknown> = {
    ...(localMetadata ?? {}),
    ...(historyMetadata ?? {}),
    ...(mergedUsage && { usage: mergedUsage }),
  };
  const historyTurnIsActive = historyMetadata?.isStreaming === true
    || historyMetadata?.isFinal === false;
  if (historyTurnIsActive) {
    delete mergedMetadata.usage;
    delete mergedMetadata.contextPercent;
  }
  return mergedMetadata;
};

const isSameHistoryMessage = (
  left: SubagentChildHistoryEntry,
  right: SubagentChildHistoryEntry,
): boolean => (
  left.type === right.type
  && left.content === right.content
  && stableJson(left.metadata ?? null) === stableJson(right.metadata ?? null)
);

const buildLocalEntries = (localMessages: CoworkMessage[]): {
  entries: SubagentChildHistoryEntry[];
  normalizedLocalUserContent: boolean;
} => {
  let normalizedLocalUserContent = false;
  const entries = localMessages
    .filter((message) => message.type !== 'system')
    .map((message) => {
      const content = message.type === 'user'
        ? normalizeSubagentVisibleUserText(message.content)
        : message.content;
      if (message.type === 'user' && content !== message.content) {
        normalizedLocalUserContent = true;
      }
      return {
        type: message.type,
        content,
        timestamp: message.timestamp,
        metadata: normalizeMetadata(message.metadata),
      };
    })
    .filter((entry) => entry.type === 'tool_use' || entry.content.trim());

  return { entries, normalizedLocalUserContent };
};

const toStoredEntry = (message: CoworkMessage): SubagentChildHistoryEntry | null => {
  if (message.type !== 'tool_use' && !message.content.trim()) {
    return null;
  }

  if (message.type === 'user') {
    const content = normalizeSubagentVisibleUserText(message.content).trim();
    if (!content || shouldSuppressHeartbeatText('user', content)) {
      return null;
    }
    return {
      type: 'user',
      content,
      timestamp: message.timestamp,
      metadata: normalizeMetadata(message.metadata),
    };
  }

  if (message.type === 'assistant') {
    const content = message.content.trim();
    if (!content || shouldSuppressHeartbeatText('assistant', content)) {
      return null;
    }
    return {
      type: 'assistant',
      content,
      timestamp: message.timestamp,
      metadata: {
        isStreaming: false,
        isFinal: true,
        ...(message.metadata ?? {}),
      },
    };
  }

  if (message.type === 'system') return null;

  return {
    type: message.type,
    content: message.content,
    timestamp: message.timestamp,
    metadata: normalizeMetadata(message.metadata),
  };
};

type IndexedNonUserEntry = {
  entry: SubagentChildHistoryEntry;
  index: number;
  turnIndex: number;
};

const indexNonUserEntriesByTurn = (
  entries: SubagentChildHistoryEntry[],
): IndexedNonUserEntry[] => {
  const indexed: IndexedNonUserEntry[] = [];
  let turnIndex = -1;
  for (const entry of entries) {
    if (entry.type === 'user') {
      turnIndex += 1;
      continue;
    }
    indexed.push({ entry, index: indexed.length, turnIndex: Math.max(turnIndex, 0) });
  }
  return indexed;
};

/**
 * Match metadata only inside the same logical user turn. Exact topology can be
 * paired positionally even when authoritative text was corrected. When the
 * gateway adds tool topology, exact entries are paired first and the remaining
 * visible assistant roots are aligned from the tail of that turn.
 */
const buildIndexedNonUserMetadataMatches = (
  localEntries: IndexedNonUserEntry[],
  historyEntries: IndexedNonUserEntry[],
): Map<number, number> => {
  const matches = new Map<number, number>();
  const turnIndexes = new Set(historyEntries.map(entry => entry.turnIndex));

  for (const turnIndex of turnIndexes) {
    const localTurn = localEntries.filter(entry => entry.turnIndex === turnIndex);
    const historyTurn = historyEntries.filter(entry => entry.turnIndex === turnIndex);
    if (
      localTurn.length === historyTurn.length
      && localTurn.every((entry, index) => entry.entry.type === historyTurn[index].entry.type)
    ) {
      for (let index = 0; index < historyTurn.length; index += 1) {
        matches.set(historyTurn[index].index, localTurn[index].index);
      }
      continue;
    }

    const usedLocalIndexes = new Set<number>();
    let localSearchIndex = localTurn.length - 1;
    for (let historyIndex = historyTurn.length - 1; historyIndex >= 0; historyIndex -= 1) {
      const historyEntry = historyTurn[historyIndex];
      for (let localIndex = localSearchIndex; localIndex >= 0; localIndex -= 1) {
        const localEntry = localTurn[localIndex];
        if (
          localEntry.entry.type === historyEntry.entry.type
          && localEntry.entry.content === historyEntry.entry.content
        ) {
          matches.set(historyEntry.index, localEntry.index);
          usedLocalIndexes.add(localEntry.index);
          localSearchIndex = localIndex - 1;
          break;
        }
      }
    }

    const unmatchedLocalAssistants = localTurn.filter(entry => (
      entry.entry.type === 'assistant' && !usedLocalIndexes.has(entry.index)
    ));
    const unmatchedHistoryAssistants = historyTurn.filter(entry => (
      entry.entry.type === 'assistant' && !matches.has(entry.index)
    ));
    let localAssistantIndex = unmatchedLocalAssistants.length - 1;
    let historyAssistantIndex = unmatchedHistoryAssistants.length - 1;
    while (localAssistantIndex >= 0 && historyAssistantIndex >= 0) {
      const localEntry = unmatchedLocalAssistants[localAssistantIndex];
      const historyEntry = unmatchedHistoryAssistants[historyAssistantIndex];
      matches.set(historyEntry.index, localEntry.index);
      localAssistantIndex -= 1;
      historyAssistantIndex -= 1;
    }
  }

  return matches;
};

export const buildSubagentNonUserMetadataMatches = (
  localEntries: SubagentChildHistoryEntry[],
  historyEntries: SubagentChildHistoryEntry[],
): Map<number, number> => buildIndexedNonUserMetadataMatches(
  indexNonUserEntriesByTurn(localEntries),
  indexNonUserEntriesByTurn(historyEntries),
);

export const normalizeSubagentVisibleUserText = (text: string): string => {
  const currentRequestMarker = '[Current user request]';
  const currentRequestIndex = text.lastIndexOf(currentRequestMarker);
  if (currentRequestIndex >= 0) {
    const visible = text.slice(currentRequestIndex + currentRequestMarker.length).trim();
    if (visible) return visible;
  }

  const taskMarker = '[Subagent Task]';
  const taskIndex = text.lastIndexOf(taskMarker);
  if (taskIndex >= 0) {
    const taskStart = taskIndex + taskMarker.length;
    const taskTail = text.slice(taskStart);
    const beginMatch = /\n\s*Begin\. Execute the assigned task to completion\./.exec(taskTail);
    const visible = (beginMatch ? taskTail.slice(0, beginMatch.index) : taskTail).trim();
    if (visible) return visible;
  }

  return text;
};

export type SubagentLogicalTurnAlignment = {
  localStartIndex: number;
  historyStartIndex: number;
  overlapTurnCount: number;
};

const collectNormalizedUserAnchors = (
  entries: SubagentChildHistoryEntry[],
): Array<{ content: string; entryIndex: number }> => entries.flatMap((entry, entryIndex) => {
  if (entry.type !== 'user') return [];
  const content = normalizeSubagentVisibleUserText(entry.content).trim();
  return content ? [{ content, entryIndex }] : [];
});

const countAnchorSequenceOccurrences = (
  anchors: string[],
  sequence: string[],
): number => {
  if (sequence.length === 0 || sequence.length > anchors.length) return 0;
  let count = 0;
  for (let start = 0; start <= anchors.length - sequence.length; start += 1) {
    if (sequence.every((anchor, index) => anchors[start + index] === anchor)) {
      count += 1;
    }
  }
  return count;
};

/**
 * Find a unique overlap between the authoritative history prefix and the local
 * conversation suffix. This supports bounded history without letting a stale
 * older turn overwrite a newer local turn. Repeated user-anchor sequences are
 * rejected because their assistant metadata cannot be bound safely.
 */
export const findSubagentLogicalTurnAlignment = (
  localEntries: SubagentChildHistoryEntry[],
  historyEntries: SubagentChildHistoryEntry[],
): SubagentLogicalTurnAlignment | null => {
  const localAnchors = collectNormalizedUserAnchors(localEntries);
  const historyAnchors = collectNormalizedUserAnchors(historyEntries);

  if (localAnchors.length === 0 || historyAnchors.length === 0) return null;

  const localContents = localAnchors.map(anchor => anchor.content);
  const historyContents = historyAnchors.map(anchor => anchor.content);
  const maxOverlap = Math.min(localContents.length, historyContents.length);
  for (let overlap = maxOverlap; overlap >= 1; overlap -= 1) {
    const localSuffix = localContents.slice(localContents.length - overlap);
    const historyPrefix = historyContents.slice(0, overlap);
    if (!localSuffix.every((anchor, index) => anchor === historyPrefix[index])) continue;
    if (
      countAnchorSequenceOccurrences(localContents, localSuffix) !== 1
      || countAnchorSequenceOccurrences(historyContents, historyPrefix) !== 1
    ) return null;
    return {
      localStartIndex: localAnchors[localAnchors.length - overlap].entryIndex,
      historyStartIndex: historyAnchors[0].entryIndex,
      overlapTurnCount: overlap,
    };
  }
  return null;
};

export const buildSubagentChildHistorySyncPlan = (
  localMessages: CoworkMessage[],
  historyMessages: unknown[],
  historyOptions: Pick<
    ParseSubagentGatewayHistoryOptions,
    'contextTokens' | 'sessionModel' | 'latestTurnActive'
  > = {},
): SubagentChildHistorySyncPlan => {
  const { entries: localEntries, normalizedLocalUserContent } = buildLocalEntries(localMessages);
  const parsedHistoryMessages = parseSubagentGatewayHistoryMessages(historyMessages, historyOptions);
  const parsedHistoryEntries = parsedHistoryMessages
    .map(toStoredEntry)
    .filter((entry): entry is SubagentChildHistoryEntry => entry !== null);
  if (parsedHistoryEntries.length === 0) {
    return {
      changed: false,
      cursor: 0,
      entriesToStore: [],
      localEntries,
    };
  }

  const alignment = localEntries.length > 0
    ? findSubagentLogicalTurnAlignment(localEntries, parsedHistoryEntries)
    : { localStartIndex: 0, historyStartIndex: 0, overlapTurnCount: 0 };
  if (!alignment) {
    return {
      changed: normalizedLocalUserContent,
      cursor: localEntries.length,
      entriesToStore: localEntries,
      localEntries,
    };
  }

  const localPrefix = localEntries.slice(0, alignment.localStartIndex);
  const localCoveredEntries = localEntries.slice(alignment.localStartIndex);
  const historyCoveredEntries = parsedHistoryEntries.slice(alignment.historyStartIndex);
  const localUsers = localCoveredEntries.filter(entry => entry.type === 'user');
  const localNonUsers = indexNonUserEntriesByTurn(localCoveredEntries);
  const historyNonUsers = indexNonUserEntriesByTurn(historyCoveredEntries);
  const metadataMatches = buildIndexedNonUserMetadataMatches(localNonUsers, historyNonUsers);
  const mergedHistoryEntries: SubagentChildHistoryEntry[] = [];
  let localUserIndex = 0;
  let historyNonUserIndex = 0;

  for (const historyEntry of historyCoveredEntries) {
    if (historyEntry.type === 'user') {
      mergedHistoryEntries.push(localUsers[localUserIndex++] ?? historyEntry);
      continue;
    }
    const matchingLocalIndex = metadataMatches.get(historyNonUserIndex);
    if (matchingLocalIndex != null) {
      historyEntry.metadata = mergeHistoryMetadata(
        localNonUsers[matchingLocalIndex].entry.metadata,
        historyEntry.metadata,
      );
    }
    historyNonUserIndex += 1;
    mergedHistoryEntries.push(historyEntry);
  }

  const mergedEntries = [...localPrefix, ...mergedHistoryEntries];

  const isInSync = !normalizedLocalUserContent
    && localEntries.length === mergedEntries.length
    && localEntries.every((entry, index) =>
      isSameHistoryMessage(entry, mergedEntries[index]),
    );

  return {
    changed: !isInSync,
    cursor: mergedEntries.length,
    entriesToStore: mergedEntries,
    localEntries,
  };
};
