import type { CoworkMessageMetadata } from '../../types/cowork';

export interface MessageUsageDisplay {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  contextPercent?: number;
  contextClassName: string;
  hasVisibleStats: boolean;
}

const normalizeDisplayTokenCount = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.min(Math.trunc(value), Number.MAX_SAFE_INTEGER);
};

const normalizeContextPercent = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.min(Math.round(value), 100);
};

export const getMessageUsageDisplay = (
  metadata?: CoworkMessageMetadata | null,
): MessageUsageDisplay => {
  if (metadata?.isStreaming === true || metadata?.isFinal === false) {
    return {
      contextClassName: '',
      hasVisibleStats: false,
    };
  }

  const inputTokens = normalizeDisplayTokenCount(metadata?.usage?.inputTokens);
  const outputTokens = normalizeDisplayTokenCount(metadata?.usage?.outputTokens);
  const rawCacheReadTokens = normalizeDisplayTokenCount(metadata?.usage?.cacheReadTokens);
  const cacheReadTokens = rawCacheReadTokens != null && rawCacheReadTokens > 0
    ? rawCacheReadTokens
    : undefined;
  const contextPercent = normalizeContextPercent(metadata?.contextPercent);
  const contextClassName = contextPercent != null && contextPercent >= 90
    ? 'text-red-700 dark:text-red-300'
    : contextPercent != null && contextPercent >= 75
      ? 'text-amber-700 dark:text-amber-300'
      : '';

  return {
    ...(inputTokens != null && { inputTokens }),
    ...(outputTokens != null && { outputTokens }),
    ...(cacheReadTokens != null && { cacheReadTokens }),
    ...(contextPercent != null && { contextPercent }),
    contextClassName,
    hasVisibleStats: inputTokens != null
      || outputTokens != null
      || cacheReadTokens != null
      || contextPercent != null,
  };
};
