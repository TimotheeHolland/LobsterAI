import { expect, test } from 'vitest';

import { getMessageUsageDisplay } from './messageUsageDisplay';

test('shows final input/output zero values but hides a zero cache read', () => {
  expect(getMessageUsageDisplay({
    isFinal: true,
    isStreaming: false,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
    },
    contextPercent: 0,
  })).toEqual({
    inputTokens: 0,
    outputTokens: 0,
    contextPercent: 0,
    contextClassName: '',
    hasVisibleStats: true,
  });
});

test('shows cache hits and applies current theme context thresholds', () => {
  expect(getMessageUsageDisplay({
    usage: { inputTokens: 29_600, outputTokens: 647, cacheReadTokens: 59_400 },
    contextPercent: 75,
  })).toEqual({
    inputTokens: 29_600,
    outputTokens: 647,
    cacheReadTokens: 59_400,
    contextPercent: 75,
    contextClassName: 'text-amber-700 dark:text-amber-300',
    hasVisibleStats: true,
  });

  expect(getMessageUsageDisplay({ contextPercent: 90 }).contextClassName)
    .toBe('text-red-700 dark:text-red-300');
  expect(getMessageUsageDisplay({ contextPercent: 74 }).contextClassName).toBe('');
});

test('does not expose usage while a message is still streaming', () => {
  expect(getMessageUsageDisplay({
    isStreaming: true,
    usage: { inputTokens: 12_000, outputTokens: 300, cacheReadTokens: 8_000 },
    contextPercent: 20,
  })).toEqual({
    contextClassName: '',
    hasVisibleStats: false,
  });
  expect(getMessageUsageDisplay({
    isFinal: false,
    usage: { inputTokens: 12_000, outputTokens: 300 },
  })).toEqual({
    contextClassName: '',
    hasVisibleStats: false,
  });
});

test('ignores malformed persisted values and clamps context percent', () => {
  expect(getMessageUsageDisplay({
    usage: {
      inputTokens: Number.NaN,
      outputTokens: -1,
      cacheReadTokens: Number.POSITIVE_INFINITY,
    },
    contextPercent: 130,
  })).toEqual({
    contextPercent: 100,
    contextClassName: 'text-red-700 dark:text-red-300',
    hasVisibleStats: true,
  });
});
