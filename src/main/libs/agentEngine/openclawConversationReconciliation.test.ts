import { describe, expect, test } from 'vitest';

import {
  applyLocalTimestampsToEntries,
  findTailAlignment,
  mergeLocalMetadataIntoEntries,
} from './openclawConversationReconciliation';

describe('findTailAlignment', () => {
  test('does not treat an unmatched assistant-only bounded window as a full transcript', () => {
    expect(findTailAlignment(
      [
        { role: 'user', text: 'First question' },
        { role: 'assistant', text: 'First answer' },
        { role: 'user', text: 'Second question' },
        { role: 'assistant', text: 'Streaming partial' },
      ],
      [{ role: 'assistant', text: 'Final corrected answer' }],
    )).toBeNull();
  });

  test('keeps an exact assistant-only suffix as a valid bounded-tail alignment', () => {
    expect(findTailAlignment(
      [
        { role: 'user', text: 'First question' },
        { role: 'assistant', text: 'First answer' },
      ],
      [{ role: 'assistant', text: 'First answer' }],
    )).toEqual({ localIdx: 1, authIdx: 0 });
  });
});

describe('mergeLocalMetadataIntoEntries', () => {
  test('does not move repeated assistant metadata across user turns', () => {
    const result = mergeLocalMetadataIntoEntries(
      [
        { role: 'user', text: 'Go' },
        { role: 'assistant', text: 'OK' },
        { role: 'user', text: 'Go' },
        {
          role: 'assistant',
          text: 'OK',
          metadata: { isStreaming: true, isFinal: false },
        },
      ],
      [
        { role: 'user', text: 'Go' },
        {
          role: 'assistant',
          text: 'OK',
          metadata: {
            customFlag: true,
            usage: { inputTokens: 123 },
            contextPercent: 12,
          },
        },
        { role: 'user', text: 'Go' },
      ],
    );

    expect(result[1].metadata).toMatchObject({
      customFlag: true,
      usage: { inputTokens: 123 },
      contextPercent: 12,
      isStreaming: false,
      isFinal: true,
    });
    expect(result[3].metadata).toEqual({ isStreaming: true, isFinal: false });
  });

  test('does not guess when one repeated local turn matches both history ends', () => {
    const result = mergeLocalMetadataIntoEntries(
      [
        { role: 'user', text: 'Go' },
        { role: 'assistant', text: 'OK' },
        { role: 'user', text: 'Go' },
        { role: 'assistant', text: 'OK' },
      ],
      [
        { role: 'user', text: 'Go' },
        {
          role: 'assistant',
          text: 'OK',
          metadata: { customFlag: true, usage: { inputTokens: 222 } },
        },
      ],
    );

    expect(result[1].metadata).toBeUndefined();
    expect(result[3].metadata).toBeUndefined();
  });

  test('preserves local-only metadata through an authoritative text correction', () => {
    const result = mergeLocalMetadataIntoEntries(
      [
        { role: 'user', text: 'Hello' },
        {
          role: 'assistant',
          text: 'Correct answer',
          metadata: {
            usage: { inputTokens: 20, outputTokens: 5 },
            isStreaming: false,
            isFinal: true,
          },
        },
      ],
      [
        { role: 'user', text: 'Hello' },
        {
          role: 'assistant',
          text: 'Corect answer',
          metadata: {
            customFlag: true,
            usage: { outputTokens: 1 },
            isStreaming: true,
            isFinal: false,
          },
        },
      ],
    );

    expect(result[1].metadata).toMatchObject({
      customFlag: true,
      usage: { inputTokens: 20, outputTokens: 5 },
      isStreaming: false,
      isFinal: true,
    });
  });

  test('removes stale partial usage while the authoritative turn is active', () => {
    const result = mergeLocalMetadataIntoEntries(
      [
        { role: 'user', text: 'Hello' },
        {
          role: 'assistant',
          text: 'Working',
          metadata: { isStreaming: true, isFinal: false },
        },
      ],
      [
        { role: 'user', text: 'Hello' },
        {
          role: 'assistant',
          text: 'Working',
          metadata: {
            usage: { inputTokens: 99 },
            contextPercent: 90,
          },
        },
      ],
    );

    expect(result[1].metadata).toEqual({ isStreaming: true, isFinal: false });
  });
});

describe('applyLocalTimestampsToEntries', () => {
  test('does not reuse old timestamps for repeated text in a newer turn', () => {
    const result = applyLocalTimestampsToEntries(
      [
        { role: 'user', text: 'Go', timestamp: 1 },
        { role: 'assistant', text: 'OK', timestamp: 2 },
        { role: 'user', text: 'Go' },
        { role: 'assistant', text: 'OK' },
      ],
      [
        { role: 'user', text: 'Go', timestamp: 1 },
        { role: 'assistant', text: 'OK', timestamp: 2 },
        { role: 'user', text: 'Go', timestamp: 3 },
      ],
    );

    expect(result.map(entry => entry.timestamp)).toEqual([1, 2, 3, undefined]);
  });
});
