import { describe, expect, test } from 'vitest';

import { OpenClawCronRunMetadataKey } from '../../../shared/cowork/openclawCronSessionKey';
import {
  buildCronRunHistoryEntries,
  buildCronRunLocalHistoryEntries,
  findCronRunHistoryLocalMatch,
  shouldReplaceLocalConversationWithCronHistory,
} from './openclawCronRunHistorySync';

describe('buildCronRunHistoryEntries', () => {
  test('preserves current usage aliases, context percentage, model, and timestamp', () => {
    const sessionKey = 'agent:main:cron:run:example';
    const entries = buildCronRunHistoryEntries([
      {
        role: 'assistant',
        content: 'Scheduled result',
        timestamp: 1_786_665_432_100,
        model: 'anthropic/claude-sonnet-4',
        usage: {
          input_tokens: 10_000,
          completion_tokens: 300,
          cache_read_input_tokens: 5_000,
          cache_creation_input_tokens: 500,
        },
      },
    ], sessionKey, 100_000);

    expect(entries).toEqual([{
      role: 'assistant',
      text: 'Scheduled result',
      timestamp: 1_786_665_432_100,
      metadata: {
        usage: {
          inputTokens: 10_000,
          outputTokens: 300,
          cacheReadTokens: 5_000,
          cacheWriteTokens: 500,
        },
        contextPercent: 16,
        model: 'anthropic/claude-sonnet-4',
        [OpenClawCronRunMetadataKey.SessionKey]: sessionKey,
        [OpenClawCronRunMetadataKey.EntryIndex]: 0,
      },
    }]);
  });

  test('aggregates tool-loop usage onto the final visible scheduled result', () => {
    const sessionKey = 'agent:main:cron:run:tool-loop';
    const entries = buildCronRunHistoryEntries([
      { role: 'user', content: 'Run the report' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'read', input: {} }],
        model: 'anthropic/claude-sonnet-4',
        usage: { input: 20_000, output: 50, cacheRead: 30_000, cacheWrite: 500 },
      },
      { role: 'tool', content: 'report data' },
      {
        role: 'assistant',
        content: 'Scheduled result',
        usage: { input: 25_000, output: 75, cacheRead: 5_000, cacheWrite: 100 },
      },
    ], sessionKey, 100_000);

    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      role: 'assistant',
      text: 'Scheduled result',
      metadata: {
        usage: {
          inputTokens: 45_000,
          outputTokens: 125,
          cacheReadTokens: 35_000,
          cacheWriteTokens: 600,
        },
        contextPercent: 51,
        model: 'anthropic/claude-sonnet-4',
      },
    });
  });

  test('withholds partial usage from the latest active scheduled turn', () => {
    const sessionKey = 'agent:main:cron:run:active';
    const entries = buildCronRunHistoryEntries([
      { role: 'user', content: 'Run the report' },
      {
        role: 'assistant',
        content: 'Working on it',
        model: 'anthropic/claude-sonnet-4',
        usage: { input: 20_000, output: 50 },
      },
    ], sessionKey, 100_000, { latestTurnActive: true });

    expect(entries[1]).toMatchObject({
      role: 'assistant',
      text: 'Working on it',
      metadata: {
        isStreaming: true,
        isFinal: false,
        model: 'anthropic/claude-sonnet-4',
      },
    });
    expect(entries[1].metadata).not.toHaveProperty('usage');
    expect(entries[1].metadata).not.toHaveProperty('contextPercent');
  });
});

describe('buildCronRunLocalHistoryEntries', () => {
  test('uses normalized text for matching while preserving renderer content', () => {
    const entries = buildCronRunLocalHistoryEntries([{
      id: 'message-1',
      type: 'assistant',
      content: '  Scheduled result\n',
      timestamp: 1_786_665_432_100,
      metadata: { isFinal: true },
    }]);

    expect(entries).toEqual([{
      id: 'message-1',
      role: 'assistant',
      text: 'Scheduled result',
      originalText: '  Scheduled result\n',
      timestamp: 1_786_665_432_100,
      metadata: { isFinal: true },
    }]);
  });

  test('prefers the stable run entry index when authoritative text changes', () => {
    const sessionKey = 'agent:main:cron:job:run:run-1';
    const localEntries = buildCronRunLocalHistoryEntries([
      {
        id: 'imported',
        type: 'assistant',
        content: 'Partial result',
        timestamp: 1,
        metadata: {
          [OpenClawCronRunMetadataKey.SessionKey]: sessionKey,
          [OpenClawCronRunMetadataKey.EntryIndex]: 1,
        },
      },
      {
        id: 'follow-up',
        type: 'assistant',
        content: 'Final result',
        timestamp: 2,
        metadata: {},
      },
    ]);
    const authoritative = {
      role: 'assistant' as const,
      text: 'Final result',
      metadata: {
        [OpenClawCronRunMetadataKey.SessionKey]: sessionKey,
        [OpenClawCronRunMetadataKey.EntryIndex]: 1,
      },
    };

    expect(findCronRunHistoryLocalMatch(
      authoritative,
      localEntries,
      new Set(),
      sessionKey,
    )?.id).toBe('imported');
  });

  test('allows the first authoritative run to replace a partial assistant row', () => {
    const sessionKey = 'agent:main:cron:job:run:run-first';
    const localEntries = buildCronRunLocalHistoryEntries([
      {
        id: 'user-1',
        type: 'user',
        content: 'Generate report',
        timestamp: 1,
        metadata: {},
      },
      {
        id: 'assistant-1',
        type: 'assistant',
        content: 'Generating…',
        timestamp: 2,
        metadata: { customFlag: true },
      },
    ]);

    expect(shouldReplaceLocalConversationWithCronHistory(
      localEntries,
      [
        { role: 'user', text: 'Generate report' },
        { role: 'assistant', text: 'Report complete' },
      ],
      sessionKey,
    )).toBe(true);
  });

  test('does not attach a new run marker to ambiguous repeated untagged text', () => {
    const sessionKey = 'agent:main:cron:job:run:run-new';
    const localEntries = buildCronRunLocalHistoryEntries([
      { id: 'old-1', type: 'assistant', content: 'OK', timestamp: 1, metadata: {} },
      { id: 'old-2', type: 'assistant', content: 'OK', timestamp: 2, metadata: {} },
    ]);

    expect(findCronRunHistoryLocalMatch(
      {
        role: 'assistant',
        text: 'OK',
        metadata: {
          [OpenClawCronRunMetadataKey.SessionKey]: sessionKey,
          [OpenClawCronRunMetadataKey.EntryIndex]: 1,
        },
      },
      localEntries,
      new Set(),
      sessionKey,
    )).toBeUndefined();
  });

  test('does not consume an identical untagged follow-up when an older run is present', () => {
    const oldSessionKey = 'agent:main:cron:job:run:run-old';
    const newSessionKey = 'agent:main:cron:job:run:run-new';
    const localEntries = buildCronRunLocalHistoryEntries([
      {
        id: 'old-result',
        type: 'assistant',
        content: 'Old result',
        timestamp: 1,
        metadata: {
          [OpenClawCronRunMetadataKey.SessionKey]: oldSessionKey,
          [OpenClawCronRunMetadataKey.EntryIndex]: 1,
        },
      },
      { id: 'follow-up-user', type: 'user', content: 'Report', timestamp: 2, metadata: {} },
      { id: 'follow-up-answer', type: 'assistant', content: 'OK', timestamp: 3, metadata: {} },
    ]);

    expect(findCronRunHistoryLocalMatch(
      {
        role: 'assistant',
        text: 'OK',
        metadata: {
          [OpenClawCronRunMetadataKey.SessionKey]: newSessionKey,
          [OpenClawCronRunMetadataKey.EntryIndex]: 1,
        },
      },
      localEntries,
      new Set(),
      newSessionKey,
    )).toBeUndefined();
  });

  test('uses the active run binding to repair an untagged partial after an older run', () => {
    const oldSessionKey = 'agent:main:cron:job:run:run-old';
    const newSessionKey = 'agent:main:cron:job:run:run-new';
    const localEntries = buildCronRunLocalHistoryEntries([
      {
        id: 'old-result',
        type: 'assistant',
        content: 'Old result',
        timestamp: 1,
        metadata: {
          [OpenClawCronRunMetadataKey.SessionKey]: oldSessionKey,
          [OpenClawCronRunMetadataKey.EntryIndex]: 1,
        },
      },
      { id: 'current-user', type: 'user', content: 'Report', timestamp: 2, metadata: {} },
      { id: 'current-assistant', type: 'assistant', content: 'Working…', timestamp: 3, metadata: {} },
    ]);

    expect(findCronRunHistoryLocalMatch(
      {
        role: 'assistant',
        text: 'Final report',
        metadata: {
          [OpenClawCronRunMetadataKey.SessionKey]: newSessionKey,
          [OpenClawCronRunMetadataKey.EntryIndex]: 1,
        },
      },
      localEntries,
      new Set(['current-user']),
      newSessionKey,
      new Set(['current-user', 'current-assistant']),
    )?.id).toBe('current-assistant');
  });
});
