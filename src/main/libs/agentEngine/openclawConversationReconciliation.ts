import * as path from 'path';

export type ReconciledConversationEntry = {
  role: 'user' | 'assistant';
  text: string;
  metadata?: Record<string, unknown>;
  timestamp?: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
};

const normalizeLocalMediaPathKey = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\\/g, '/').toLowerCase();
};

export const getLocalMediaAttachmentsKey = (metadata: unknown): string => {
  if (!isRecord(metadata) || !Array.isArray(metadata.localMediaAttachments)) {
    return '';
  }
  return metadata.localMediaAttachments
    .map((item) => {
      if (!isRecord(item)) return '';
      const localPath = normalizeLocalMediaPathKey(item.localPath);
      if (!localPath) return '';
      const mimeType = typeof item.mimeType === 'string' ? item.mimeType.trim().toLowerCase() : '';
      return `${localPath}\x1e${mimeType}`;
    })
    .filter(Boolean)
    .sort()
    .join('\x1f');
};

export const buildGatewayMediaMetadata = (
  entry: { mediaAttachments?: Array<{ localPath: string; mimeType?: string }> },
): Record<string, unknown> | undefined => {
  const attachments = entry.mediaAttachments
    ?.map((attachment) => {
      const localPath = attachment.localPath.trim();
      if (!localPath) return null;
      const mimeType = attachment.mimeType?.trim();
      return {
        localPath,
        ...(mimeType ? { mimeType } : {}),
        name: path.basename(localPath),
      };
    })
    .filter((attachment): attachment is { localPath: string; mimeType?: string; name: string } => attachment !== null);

  return attachments?.length ? { localMediaAttachments: attachments } : undefined;
};

export const isSameHistoryEntry = (
  left: { role: 'user' | 'assistant'; text: string },
  right: { role: 'user' | 'assistant'; text: string },
): boolean => left.role === right.role && left.text === right.text;

export const isSameReconciledEntry = (
  left: { role: 'user' | 'assistant'; text: string; metadata?: Record<string, unknown> },
  right: { role: 'user' | 'assistant'; text: string; metadata?: Record<string, unknown> },
): boolean => {
  return isSameHistoryEntry(left, right)
    && getLocalMediaAttachmentsKey(left.metadata) === getLocalMediaAttachmentsKey(right.metadata);
};

const isValidMessageTimestamp = (value: unknown): value is number => {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
};

export const applyLocalTimestampsToEntries = (
  entries: ReconciledConversationEntry[],
  localEntries: Array<{ role: 'user' | 'assistant'; text: string; timestamp?: number }>,
): ReconciledConversationEntry[] => {
  const matches = buildTurnScopedMetadataMatches(entries, localEntries);
  return entries.map((entry, index) => {
    if (isValidMessageTimestamp(entry.timestamp)) {
      return entry;
    }
    const localIndex = matches.get(index);
    const timestamp = localIndex == null ? undefined : localEntries[localIndex]?.timestamp;
    return timestamp != null ? { ...entry, timestamp } : entry;
  });
};

type IndexedConversationTurn = {
  userIndex: number;
  assistantIndexes: number[];
};

const buildIndexedConversationTurns = (
  entries: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>,
): { leadingAssistantIndexes: number[]; turns: IndexedConversationTurn[] } => {
  const leadingAssistantIndexes: number[] = [];
  const turns: IndexedConversationTurn[] = [];
  let currentTurn: IndexedConversationTurn | undefined;
  for (let index = 0; index < entries.length; index += 1) {
    if (entries[index].role === 'user') {
      currentTurn = { userIndex: index, assistantIndexes: [] };
      turns.push(currentTurn);
    } else if (currentTurn) {
      currentTurn.assistantIndexes.push(index);
    } else {
      leadingAssistantIndexes.push(index);
    }
  }
  return { leadingAssistantIndexes, turns };
};

const findLinearUserTurnAlignment = (
  authoritativeTurns: IndexedConversationTurn[],
  authoritativeEntries: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>,
  localTurns: IndexedConversationTurn[],
  localEntries: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>,
): { authoritativeStart: number; localStart: number; length: number } | null => {
  const authoritativeTexts = authoritativeTurns.map(turn => authoritativeEntries[turn.userIndex].text);
  const localTexts = localTurns.map(turn => localEntries[turn.userIndex].text);
  const matchesAt = (
    authoritativeStart: number,
    localStart: number,
    length: number,
  ): boolean => {
    for (let offset = 0; offset < length; offset += 1) {
      if (authoritativeTexts[authoritativeStart + offset] !== localTexts[localStart + offset]) {
        return false;
      }
    }
    return true;
  };

  if (authoritativeTexts.length === 0 || localTexts.length === 0) return null;
  if (
    authoritativeTexts.length === localTexts.length
    && matchesAt(0, 0, authoritativeTexts.length)
  ) {
    return { authoritativeStart: 0, localStart: 0, length: authoritativeTexts.length };
  }
  if (localTexts.length < authoritativeTexts.length) {
    const authoritativeStart = authoritativeTexts.length - localTexts.length;
    const prefixMatches = matchesAt(0, 0, localTexts.length);
    const suffixMatches = matchesAt(authoritativeStart, 0, localTexts.length);
    if (prefixMatches && suffixMatches && authoritativeStart !== 0) return null;
    if (prefixMatches) {
      return { authoritativeStart: 0, localStart: 0, length: localTexts.length };
    }
    if (suffixMatches) {
      return { authoritativeStart, localStart: 0, length: localTexts.length };
    }
  } else if (authoritativeTexts.length < localTexts.length) {
    const localStart = localTexts.length - authoritativeTexts.length;
    const prefixMatches = matchesAt(0, 0, authoritativeTexts.length);
    const suffixMatches = matchesAt(0, localStart, authoritativeTexts.length);
    if (prefixMatches && suffixMatches && localStart !== 0) return null;
    if (prefixMatches) {
      return { authoritativeStart: 0, localStart: 0, length: authoritativeTexts.length };
    }
    if (suffixMatches) {
      return { authoritativeStart: 0, localStart, length: authoritativeTexts.length };
    }
  }
  return null;
};

const pairAssistantIndexesWithinTurn = (
  authoritativeIndexes: number[],
  authoritativeEntries: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>,
  localIndexes: number[],
  localEntries: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>,
  matches: Map<number, number>,
): void => {
  if (authoritativeIndexes.length === localIndexes.length) {
    for (let index = 0; index < authoritativeIndexes.length; index += 1) {
      matches.set(authoritativeIndexes[index], localIndexes[index]);
    }
    return;
  }

  const usedLocalIndexes = new Set<number>();
  let localSearchOffset = localIndexes.length - 1;
  for (let offset = authoritativeIndexes.length - 1; offset >= 0; offset -= 1) {
    const authoritativeIndex = authoritativeIndexes[offset];
    for (let localOffset = localSearchOffset; localOffset >= 0; localOffset -= 1) {
      const localIndex = localIndexes[localOffset];
      if (authoritativeEntries[authoritativeIndex].text === localEntries[localIndex].text) {
        matches.set(authoritativeIndex, localIndex);
        usedLocalIndexes.add(localIndex);
        localSearchOffset = localOffset - 1;
        break;
      }
    }
  }

  const remainingAuthoritative = authoritativeIndexes.filter(index => !matches.has(index));
  const remainingLocal = localIndexes.filter(index => !usedLocalIndexes.has(index));
  let authoritativeOffset = remainingAuthoritative.length - 1;
  let localOffset = remainingLocal.length - 1;
  while (authoritativeOffset >= 0 && localOffset >= 0) {
    matches.set(remainingAuthoritative[authoritativeOffset], remainingLocal[localOffset]);
    authoritativeOffset -= 1;
    localOffset -= 1;
  }
};

const buildTurnScopedMetadataMatches = (
  entries: ReconciledConversationEntry[],
  localEntries: ReadonlyArray<{
    role: 'user' | 'assistant';
    text: string;
    metadata?: Record<string, unknown>;
  }>,
): Map<number, number> => {
  const matches = new Map<number, number>();
  const authoritative = buildIndexedConversationTurns(entries);
  const local = buildIndexedConversationTurns(localEntries);
  const alignment = findLinearUserTurnAlignment(
    authoritative.turns,
    entries,
    local.turns,
    localEntries,
  );
  if (alignment) {
    for (let offset = 0; offset < alignment.length; offset += 1) {
      const authoritativeTurn = authoritative.turns[alignment.authoritativeStart + offset];
      const localTurn = local.turns[alignment.localStart + offset];
      matches.set(authoritativeTurn.userIndex, localTurn.userIndex);
      pairAssistantIndexesWithinTurn(
        authoritativeTurn.assistantIndexes,
        entries,
        localTurn.assistantIndexes,
        localEntries,
        matches,
      );
    }
  }

  if (
    local.turns.length === 0
    && authoritative.turns.length === 1
    && local.leadingAssistantIndexes.length > 0
  ) {
    pairAssistantIndexesWithinTurn(
      authoritative.turns[0].assistantIndexes,
      entries,
      local.leadingAssistantIndexes,
      localEntries,
      matches,
    );
  }

  // A bounded history tail can begin with assistant messages before its first
  // user anchor. Preserve metadata there only for exact, ordered text matches.
  let localOffset = local.leadingAssistantIndexes.length - 1;
  for (let offset = authoritative.leadingAssistantIndexes.length - 1; offset >= 0; offset -= 1) {
    const authoritativeIndex = authoritative.leadingAssistantIndexes[offset];
    for (; localOffset >= 0; localOffset -= 1) {
      const localIndex = local.leadingAssistantIndexes[localOffset];
      if (entries[authoritativeIndex].text === localEntries[localIndex].text) {
        matches.set(authoritativeIndex, localIndex);
        localOffset -= 1;
        break;
      }
    }
  }
  return matches;
};

/**
 * Preserve local-only metadata when an authoritative history window replaces
 * matching conversation entries. Matching is scoped to aligned user turns so
 * repeated assistant text cannot move usage/custom metadata across turns;
 * gateway usage/model fields remain authoritative and nested usage values are
 * merged field by field.
 */
export const mergeLocalMetadataIntoEntries = (
  entries: ReconciledConversationEntry[],
  localEntries: Array<{
    role: 'user' | 'assistant';
    text: string;
    metadata?: Record<string, unknown>;
  }>,
): ReconciledConversationEntry[] => {
  const result = entries.map(entry => ({ ...entry }));
  const metadataMatches = buildTurnScopedMetadataMatches(entries, localEntries);

  for (let entryIndex = result.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const entry = result[entryIndex];
    const matchingLocalIndex = metadataMatches.get(entryIndex);
    if (matchingLocalIndex == null) continue;

    const localMetadata = localEntries[matchingLocalIndex].metadata;
    const authoritativeMetadata = entry.metadata;
    const hasLocalMetadata = Boolean(localMetadata && Object.keys(localMetadata).length > 0);
    const hasAuthoritativeMetadata = Boolean(
      authoritativeMetadata && Object.keys(authoritativeMetadata).length > 0,
    );
    if (hasLocalMetadata || hasAuthoritativeMetadata) {
      const localUsage = isRecord(localMetadata?.usage) ? localMetadata.usage : undefined;
      const authoritativeUsage = isRecord(authoritativeMetadata?.usage)
        ? authoritativeMetadata.usage
        : undefined;
      const authoritativeTurnIsActive = authoritativeMetadata?.isStreaming === true
        || authoritativeMetadata?.isFinal === false;
      const metadata: Record<string, unknown> = {
        ...(localMetadata ?? {}),
        ...(authoritativeMetadata ?? {}),
        ...(localUsage || authoritativeUsage ? {
          usage: {
            ...(localUsage ?? {}),
            ...(authoritativeUsage ?? {}),
          },
        } : {}),
        ...(entry.role === 'assistant' ? {
          isStreaming: authoritativeTurnIsActive,
          isFinal: !authoritativeTurnIsActive,
        } : {}),
      };
      if (authoritativeTurnIsActive) {
        delete metadata.usage;
        delete metadata.contextPercent;
      }
      result[entryIndex] = {
        ...entry,
        metadata,
      };
    }
  }

  return result;
};

/**
 * Find the tail-alignment point between local and authoritative entries.
 *
 * `chat.history` can return a bounded tail window that starts in the middle of
 * a turn, often with an assistant entry before the first user anchor. Prefer a
 * full role/text overlap first; then fall back to user-message anchors and
 * report both the local and authoritative start indices so leading orphan
 * assistant entries are not duplicated into the local prefix on every poll.
 */
export const findTailAlignment = (
  localEntries: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>,
  authEntries: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>,
): { localIdx: number; authIdx: number } | null => {
  if (authEntries.length === 0) return null;
  if (localEntries.length === 0) return { localIdx: 0, authIdx: 0 };

  const maxEntryOverlap = Math.min(localEntries.length, authEntries.length);
  for (let overlap = maxEntryOverlap; overlap >= 1; overlap -= 1) {
    const localStart = localEntries.length - overlap;
    let match = true;
    for (let idx = 0; idx < overlap; idx += 1) {
      if (!isSameHistoryEntry(localEntries[localStart + idx], authEntries[idx])) {
        match = false;
        break;
      }
    }
    if (match) {
      return { localIdx: localStart, authIdx: 0 };
    }
  }

  const localUsers: Array<{ idx: number; text: string }> = [];
  for (let i = 0; i < localEntries.length; i++) {
    if (localEntries[i].role === 'user') {
      localUsers.push({ idx: i, text: localEntries[i].text });
    }
  }

  const authUsers: Array<{ idx: number; text: string }> = [];
  for (let i = 0; i < authEntries.length; i++) {
    const entry = authEntries[i];
    if (entry.role === 'user') {
      authUsers.push({ idx: i, text: entry.text });
    }
  }

  // A non-empty assistant-only gateway window can be a byte/count-bounded
  // middle of a turn. If its text does not overlap the local suffix, there is
  // no evidence that it is a complete replacement for the local conversation.
  // Keep this distinct from the valid 0/0 alignment returned for an empty
  // local conversation so the caller can safely skip a destructive replace.
  if (authUsers.length === 0 || localUsers.length === 0) return null;

  const maxK = Math.min(localUsers.length, authUsers.length);
  for (let k = maxK; k >= 1; k--) {
    const localStart = localUsers.length - k;
    let match = true;
    for (let j = 0; j < k; j++) {
      if (localUsers[localStart + j].text !== authUsers[j].text) {
        match = false;
        break;
      }
    }
    if (match) {
      const localIdx = localUsers[localStart].idx;
      const authIdx = authUsers[0].idx;
      if (authIdx > 0) {
        const leadingLocalIdx = localIdx - authIdx;
        const leadingAuthAlreadyPresent = leadingLocalIdx >= 0
          && authEntries.slice(0, authIdx).every((entry, idx) =>
            isSameHistoryEntry(localEntries[leadingLocalIdx + idx], entry),
          );
        if (!leadingAuthAlreadyPresent) {
          return {
            localIdx: Math.max(0, leadingLocalIdx),
            authIdx: 0,
          };
        }
      }
      return {
        localIdx,
        authIdx,
      };
    }
  }

  return null;
};
