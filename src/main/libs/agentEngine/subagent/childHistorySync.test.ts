import { describe, expect, test } from 'vitest';

import type { CoworkMessage } from '../../../coworkStore';
import {
  buildSubagentChildHistorySyncPlan,
  normalizeSubagentVisibleUserText,
} from './childHistorySync';

describe('subagent child history sync', () => {
  test('normalizes outbound subagent prompts to the visible user request', () => {
    const rawOutboundPrompt = `[LobsterAI system instructions]
hidden setup

[Context bridge from previous LobsterAI conversation]
previous context

[Current user request]
rewrite the intro`;

    expect(normalizeSubagentVisibleUserText(rawOutboundPrompt)).toBe('rewrite the intro');
  });

  test('preserves visible local user text instead of raw outbound prompt', () => {
    const rawOutboundPrompt = `[LobsterAI system instructions]
hidden setup

[Current user request]
rewrite the intro`;
    const localMessages: CoworkMessage[] = [
      { id: 'msg-1', type: 'user', content: rawOutboundPrompt, timestamp: 1, metadata: {} },
      { id: 'msg-2', type: 'assistant', content: 'new intro', timestamp: 2, metadata: {} },
    ] as CoworkMessage[];

    const plan = buildSubagentChildHistorySyncPlan(localMessages, [
      { role: 'user', content: rawOutboundPrompt, timestamp: 10 },
      { role: 'assistant', content: 'new intro', timestamp: 20 },
    ]);

    expect(plan.changed).toBe(true);
    expect(plan.cursor).toBe(2);
    expect(plan.entriesToStore).toEqual([
      { type: 'user', content: 'rewrite the intro', timestamp: 1, metadata: {} },
      {
        type: 'assistant',
        content: 'new intro',
        timestamp: 20,
        metadata: { isStreaming: false, isFinal: true },
      },
    ]);
  });

  test('includes subagent tool calls and results in child session history', () => {
    const localMessages: CoworkMessage[] = [
      { id: 'msg-1', type: 'user', content: 'run tests', timestamp: 1, metadata: {} },
    ] as CoworkMessage[];

    const plan = buildSubagentChildHistorySyncPlan(localMessages, [
      { role: 'user', content: 'run tests' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will run the tests.' },
          {
            type: 'toolCall',
            id: 'call-1',
            name: 'Bash',
            arguments: { command: 'npm test' },
          },
        ],
      },
      {
        role: 'tool_result',
        tool_use_id: 'call-1',
        content: '24 tests passed',
      },
      { role: 'assistant', content: 'All tests passed.' },
    ]);

    expect(plan.changed).toBe(true);
    expect(plan.entriesToStore).toEqual([
      { type: 'user', content: 'run tests', timestamp: 1, metadata: {} },
      {
        type: 'assistant',
        content: 'I will run the tests.',
        timestamp: expect.any(Number),
        metadata: { isStreaming: false, isFinal: true },
      },
      {
        type: 'tool_use',
        content: '',
        timestamp: expect.any(Number),
        metadata: {
          toolName: 'Bash',
          toolInput: { command: 'npm test' },
          toolUseId: 'call-1',
        },
      },
      {
        type: 'tool_result',
        content: '24 tests passed',
        timestamp: expect.any(Number),
        metadata: {
          toolName: undefined,
          toolResult: '24 tests passed',
          toolUseId: 'call-1',
        },
      },
      {
        type: 'assistant',
        content: 'All tests passed.',
        timestamp: expect.any(Number),
        metadata: { isStreaming: false, isFinal: true },
      },
    ]);
  });

  test('carries aggregated usage metadata into a materialized child session', () => {
    const localMessages: CoworkMessage[] = [
      { id: 'msg-1', type: 'user', content: 'run checks', timestamp: 1, metadata: {} },
    ] as CoworkMessage[];

    const plan = buildSubagentChildHistorySyncPlan(localMessages, [
      { role: 'user', content: 'run checks' },
      {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'call-1',
          name: 'exec',
          arguments: { command: 'npm test' },
        }],
        usage: { input: 20_000, output: 50, cacheRead: 30_000 },
        model: 'anthropic/claude-sonnet',
      },
      { role: 'toolResult', toolCallId: 'call-1', content: 'passed' },
      {
        role: 'assistant',
        content: 'Checks passed.',
        usage: { input: 10_000, output: 300, cacheWrite: 500 },
      },
    ], {
      contextTokens: 100_000,
      sessionModel: 'fallback/model',
    });

    const assistant = plan.entriesToStore.find((entry) => (
      entry.type === 'assistant' && entry.content === 'Checks passed.'
    ));
    expect(assistant?.metadata).toEqual({
      isStreaming: false,
      isFinal: true,
      usage: {
        inputTokens: 30_000,
        outputTokens: 350,
        cacheReadTokens: 30_000,
        cacheWriteTokens: 500,
      },
      contextPercent: 50,
      model: 'anthropic/claude-sonnet',
    });
  });

  test('preserves local metadata while enriching authoritative usage', () => {
    const localMessages: CoworkMessage[] = [
      { id: 'msg-1', type: 'user', content: 'inspect', timestamp: 1, metadata: {} },
      {
        id: 'msg-2',
        type: 'assistant',
        content: 'Done.',
        timestamp: 2,
        metadata: {
          customFlag: true,
          usage: { outputTokens: 1 },
        },
      },
    ] as CoworkMessage[];

    const plan = buildSubagentChildHistorySyncPlan(localMessages, [
      { role: 'user', content: 'inspect' },
      {
        role: 'assistant',
        content: 'Done.',
        usage: { input: 10_000, output: 100, cacheRead: 5_000 },
      },
    ], { contextTokens: 100_000 });

    expect(plan.entriesToStore[1].metadata).toEqual({
      customFlag: true,
      isStreaming: false,
      isFinal: true,
      usage: {
        inputTokens: 10_000,
        outputTokens: 100,
        cacheReadTokens: 5_000,
      },
      contextPercent: 15,
    });
  });

  test('preserves local metadata when authoritative history corrects assistant text', () => {
    const localMessages: CoworkMessage[] = [
      { id: 'msg-1', type: 'user', content: 'inspect', timestamp: 1, metadata: {} },
      {
        id: 'msg-2',
        type: 'assistant',
        content: 'Helllo',
        timestamp: 2,
        metadata: {
          customFlag: true,
          skillIds: ['skill-1'],
          isStreaming: true,
          isFinal: false,
        },
      },
    ] as CoworkMessage[];

    const plan = buildSubagentChildHistorySyncPlan(localMessages, [
      { role: 'user', content: 'inspect' },
      {
        role: 'assistant',
        content: 'Hello',
        usage: { input: 10_000, output: 100 },
      },
    ], { contextTokens: 100_000 });

    expect(plan.entriesToStore[1]).toEqual({
      type: 'assistant',
      content: 'Hello',
      timestamp: expect.any(Number),
      metadata: {
        customFlag: true,
        skillIds: ['skill-1'],
        isStreaming: false,
        isFinal: true,
        usage: { inputTokens: 10_000, outputTokens: 100 },
        contextPercent: 10,
      },
    });
  });

  test('preserves assistant root metadata when corrected history adds tool topology', () => {
    const localMessages: CoworkMessage[] = [
      { id: 'msg-1', type: 'user', content: 'inspect', timestamp: 1, metadata: {} },
      {
        id: 'msg-2',
        type: 'assistant',
        content: 'Helllo',
        timestamp: 2,
        metadata: {
          customFlag: true,
          skillIds: ['skill-1'],
          isStreaming: true,
          isFinal: false,
        },
      },
    ] as CoworkMessage[];

    const plan = buildSubagentChildHistorySyncPlan(localMessages, [
      { role: 'user', content: 'inspect' },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-1', name: 'read', input: { path: 'a.ts' } }],
      },
      { role: 'toolResult', toolCallId: 'call-1', name: 'read', content: 'contents' },
      {
        role: 'assistant',
        content: 'Hello',
        usage: { input: 10_000, output: 100 },
      },
    ], { contextTokens: 100_000 });
    const assistant = plan.entriesToStore.find((entry) => entry.type === 'assistant');

    expect(plan.entriesToStore.map((entry) => entry.type)).toEqual([
      'user',
      'tool_use',
      'tool_result',
      'assistant',
    ]);
    expect(assistant).toMatchObject({
      content: 'Hello',
      metadata: {
        customFlag: true,
        skillIds: ['skill-1'],
        isStreaming: false,
        isFinal: true,
        usage: { inputTokens: 10_000, outputTokens: 100 },
        contextPercent: 10,
      },
    });
  });

  test('keeps corrected assistant metadata inside its logical user turn', () => {
    const localMessages: CoworkMessage[] = [
      { id: 'user-1', type: 'user', content: 'first', timestamp: 1, metadata: {} },
      {
        id: 'assistant-1',
        type: 'assistant',
        content: 'Same typo',
        timestamp: 2,
        metadata: { turnMarker: 'first' },
      },
      { id: 'user-2', type: 'user', content: 'second', timestamp: 3, metadata: {} },
      {
        id: 'assistant-2',
        type: 'assistant',
        content: 'Same typo',
        timestamp: 4,
        metadata: { turnMarker: 'second' },
      },
    ] as CoworkMessage[];

    const plan = buildSubagentChildHistorySyncPlan(localMessages, [
      { role: 'user', content: 'first' },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-1', name: 'read', input: {} }],
      },
      { role: 'toolResult', toolCallId: 'call-1', content: 'one' },
      { role: 'assistant', content: 'First corrected' },
      { role: 'user', content: 'second' },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-2', name: 'read', input: {} }],
      },
      { role: 'toolResult', toolCallId: 'call-2', content: 'two' },
      { role: 'assistant', content: 'Second corrected' },
    ]);
    const assistants = plan.entriesToStore.filter((entry) => entry.type === 'assistant');

    expect(assistants).toHaveLength(2);
    expect(assistants[0]).toMatchObject({
      content: 'First corrected',
      metadata: { turnMarker: 'first' },
    });
    expect(assistants[1]).toMatchObject({
      content: 'Second corrected',
      metadata: { turnMarker: 'second' },
    });
  });

  test('preserves the local prefix when gateway history is a bounded latest-turn tail', () => {
    const localMessages: CoworkMessage[] = [
      { id: 'user-1', type: 'user', content: 'first', timestamp: 1, metadata: {} },
      {
        id: 'assistant-1',
        type: 'assistant',
        content: 'First answer',
        timestamp: 2,
        metadata: { turnMarker: 'first' },
      },
      { id: 'user-2', type: 'user', content: 'second', timestamp: 3, metadata: {} },
      {
        id: 'assistant-2',
        type: 'assistant',
        content: 'Secondd answer',
        timestamp: 4,
        metadata: { turnMarker: 'second' },
      },
    ] as CoworkMessage[];

    const plan = buildSubagentChildHistorySyncPlan(localMessages, [
      { role: 'user', content: 'second' },
      {
        role: 'assistant',
        content: 'Second answer',
        usage: { input: 10_000, output: 100 },
      },
    ], { contextTokens: 100_000 });

    expect(plan.entriesToStore.slice(0, 2)).toEqual([
      { type: 'user', content: 'first', timestamp: 1, metadata: {} },
      {
        type: 'assistant',
        content: 'First answer',
        timestamp: 2,
        metadata: { turnMarker: 'first' },
      },
    ]);
    expect(plan.entriesToStore.slice(2)).toEqual([
      { type: 'user', content: 'second', timestamp: 3, metadata: {} },
      {
        type: 'assistant',
        content: 'Second answer',
        timestamp: expect.any(Number),
        metadata: {
          turnMarker: 'second',
          isStreaming: false,
          isFinal: true,
          usage: { inputTokens: 10_000, outputTokens: 100 },
          contextPercent: 10,
        },
      },
    ]);
  });

  test('leaves repeated user-anchor tails unchanged when alignment is ambiguous', () => {
    const localMessages: CoworkMessage[] = [
      { id: 'user-1', type: 'user', content: 'retry', timestamp: 1, metadata: {} },
      {
        id: 'assistant-1',
        type: 'assistant',
        content: 'First retry',
        timestamp: 2,
        metadata: { turnMarker: 'first' },
      },
      { id: 'user-2', type: 'user', content: 'retry', timestamp: 3, metadata: {} },
      {
        id: 'assistant-2',
        type: 'assistant',
        content: 'Second retry',
        timestamp: 4,
        metadata: { turnMarker: 'second' },
      },
    ] as CoworkMessage[];

    const plan = buildSubagentChildHistorySyncPlan(localMessages, [
      { role: 'user', content: 'retry' },
      {
        role: 'assistant',
        content: 'Corrected retry',
        usage: { input: 10_000, output: 100 },
      },
    ], { contextTokens: 100_000 });

    expect(plan.changed).toBe(false);
    expect(plan.entriesToStore).toEqual(plan.localEntries);
    expect(plan.entriesToStore[1].metadata).toEqual({ turnMarker: 'first' });
    expect(plan.entriesToStore[3].metadata).toEqual({ turnMarker: 'second' });
  });

  test('leaves local history unchanged when the gateway prefix anchor repeats later', () => {
    const localMessages: CoworkMessage[] = [
      { id: 'user-1', type: 'user', content: 'retry', timestamp: 1, metadata: {} },
      {
        id: 'assistant-1',
        type: 'assistant',
        content: 'Local retry',
        timestamp: 2,
        metadata: { localMarker: true },
      },
    ] as CoworkMessage[];

    const plan = buildSubagentChildHistorySyncPlan(localMessages, [
      { role: 'user', content: 'retry' },
      { role: 'assistant', content: 'First remote retry' },
      { role: 'user', content: 'retry' },
      { role: 'assistant', content: 'Second remote retry' },
    ]);

    expect(plan.changed).toBe(false);
    expect(plan.entriesToStore).toEqual(plan.localEntries);
    expect(plan.entriesToStore[1].metadata).toEqual({ localMarker: true });
  });

  test('does not bind unanchored local assistant metadata to an arbitrary history turn', () => {
    const localMessages: CoworkMessage[] = [{
      id: 'assistant-only',
      type: 'assistant',
      content: 'Draft answer',
      timestamp: 1,
      metadata: { localMarker: true },
    }] as CoworkMessage[];

    const plan = buildSubagentChildHistorySyncPlan(localMessages, [
      { role: 'user', content: 'bounded unrelated turn' },
      {
        role: 'assistant',
        content: 'Corrected answer',
        usage: { input: 10_000, output: 100 },
      },
    ], { contextTokens: 100_000 });

    expect(plan.changed).toBe(false);
    expect(plan.entriesToStore).toEqual(plan.localEntries);
    expect(plan.entriesToStore[0].metadata).toEqual({ localMarker: true });
  });

  test('does not reattach local partial usage to an active authoritative reply', () => {
    const localMessages: CoworkMessage[] = [
      { id: 'msg-1', type: 'user', content: 'inspect', timestamp: 1, metadata: {} },
      {
        id: 'msg-2',
        type: 'assistant',
        content: 'Working on it',
        timestamp: 2,
        metadata: {
          customFlag: true,
          usage: { inputTokens: 5_000, outputTokens: 10 },
          contextPercent: 5,
          isStreaming: false,
          isFinal: true,
        },
      },
    ] as CoworkMessage[];

    const plan = buildSubagentChildHistorySyncPlan(localMessages, [
      { role: 'user', content: 'inspect' },
      {
        role: 'assistant',
        content: 'Working on it',
        usage: { input: 10_000, output: 20 },
        model: 'anthropic/claude-sonnet',
      },
    ], {
      contextTokens: 100_000,
      latestTurnActive: true,
    });
    const assistant = plan.entriesToStore[1];

    expect(assistant.metadata).toEqual({
      customFlag: true,
      isStreaming: true,
      isFinal: false,
      model: 'anthropic/claude-sonnet',
    });
    expect(assistant.metadata).not.toHaveProperty('usage');
    expect(assistant.metadata).not.toHaveProperty('contextPercent');
  });
});
