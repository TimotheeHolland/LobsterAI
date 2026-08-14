import { describe, expect, test } from 'vitest';

import { parseSubagentGatewayHistoryMessages } from './historyParser';

const deterministicIds = (): (() => string) => {
  let index = 0;
  return () => `msg-${++index}`;
};

describe('subagent history parser', () => {
  test('reads assistant top-level toolCalls', () => {
    const messages = parseSubagentGatewayHistoryMessages([
      {
        role: 'assistant',
        content: 'prepare workspace',
        toolCalls: [{
          id: 'call-mkdir',
          name: 'exec',
          arguments: { command: 'mkdir -p D:\\cus_sk' },
        }],
      },
      {
        role: 'toolResult',
        toolCallId: 'call-mkdir',
        name: 'exec',
        content: 'ok',
      },
    ], { createId: deterministicIds(), startTimestamp: 1000 });

    expect(messages).toEqual([
      {
        id: 'msg-1',
        type: 'assistant',
        content: 'prepare workspace',
        timestamp: 1000,
        metadata: { isStreaming: false, isFinal: true },
      },
      {
        id: 'msg-2',
        type: 'tool_use',
        content: '',
        timestamp: 1001,
        metadata: {
          toolName: 'exec',
          toolInput: { command: 'mkdir -p D:\\cus_sk' },
          toolUseId: 'call-mkdir',
        },
      },
      {
        id: 'msg-3',
        type: 'tool_result',
        content: 'ok',
        timestamp: 1002,
        metadata: { toolName: 'exec', toolResult: 'ok', toolUseId: 'call-mkdir' },
      },
    ]);
  });

  test('synthesizes missing exec tool use from PowerShell error output', () => {
    const messages = parseSubagentGatewayHistoryMessages([
      {
        role: 'toolResult',
        toolCallId: 'call-mkdir',
        name: 'exec',
        content: [
          'mkdir : 具有指定名称 D:\\cus_sk 的项已存在。',
          '所在位置 行:1 字符: 1',
          '+ mkdir -p D:\\cus_sk',
          '+ ~~~~~~~~~~~~~~~~~~',
          '(Command exited with code 1)',
        ].join('\r\n'),
      },
    ], { createId: deterministicIds(), startTimestamp: 1000 });

    expect(messages).toEqual([
      {
        id: 'msg-2',
        type: 'tool_use',
        content: '',
        timestamp: 1000,
        metadata: {
          toolName: 'exec',
          toolInput: { command: 'mkdir -p D:\\cus_sk' },
          toolUseId: 'call-mkdir',
          inferredFromResult: true,
        },
      },
      {
        id: 'msg-1',
        type: 'tool_result',
        content: [
          'mkdir : 具有指定名称 D:\\cus_sk 的项已存在。',
          '所在位置 行:1 字符: 1',
          '+ mkdir -p D:\\cus_sk',
          '+ ~~~~~~~~~~~~~~~~~~',
          '(Command exited with code 1)',
        ].join('\r\n'),
        timestamp: 1000,
        metadata: {
          toolName: 'exec',
          toolResult: [
            'mkdir : 具有指定名称 D:\\cus_sk 的项已存在。',
            '所在位置 行:1 字符: 1',
            '+ mkdir -p D:\\cus_sk',
            '+ ~~~~~~~~~~~~~~~~~~',
            '(Command exited with code 1)',
          ].join('\r\n'),
          toolUseId: 'call-mkdir',
        },
      },
    ]);
  });

  test('aggregates current OpenClaw turn usage onto the final visible reply', () => {
    const messages = parseSubagentGatewayHistoryMessages([
      { role: 'user', content: 'inspect the project', timestamp: 100 },
      {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'call-1',
          name: 'exec',
          arguments: { command: 'npm test' },
        }],
        usage: {
          input: 20_000,
          output: 50,
          cacheRead: 30_000,
          cacheWrite: 500,
        },
        model: 'anthropic/claude-sonnet',
        timestamp: 200,
      },
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        name: 'exec',
        content: 'tests passed',
        timestamp: 300,
      },
      {
        role: 'assistant',
        content: 'Everything passes.',
        usage: {
          input_tokens: 10_000,
          completion_tokens: 300,
          cache_read_input_tokens: 5_000,
          cache_creation_input_tokens: 500,
        },
        model: 'gateway-injected',
        timestamp: 400,
      },
    ], {
      createId: deterministicIds(),
      startTimestamp: 1_000,
      contextTokens: 100_000,
      sessionModel: 'fallback/model',
    });

    const assistant = messages.find((message) => (
      message.type === 'assistant' && message.content === 'Everything passes.'
    ));

    expect(messages.some((message) => message.type === 'tool_use')).toBe(true);
    expect(assistant?.metadata).toEqual({
      isStreaming: false,
      isFinal: true,
      usage: {
        inputTokens: 30_000,
        outputTokens: 350,
        cacheReadTokens: 35_000,
        cacheWriteTokens: 1_000,
      },
      contextPercent: 51,
      model: 'anthropic/claude-sonnet',
    });
  });

  test('does not persist a partial aggregate before the final visible call has usage', () => {
    const messages = parseSubagentGatewayHistoryMessages([
      { role: 'user', content: 'inspect' },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-1', name: 'read', input: {} }],
        usage: { input: 20_000, output: 50, cacheRead: 10_000 },
        model: 'anthropic/claude-sonnet',
      },
      { role: 'toolResult', toolCallId: 'call-1', content: 'file contents' },
      { role: 'assistant', content: 'Final answer.' },
    ], {
      createId: deterministicIds(),
      contextTokens: 100_000,
    });
    const assistant = messages.find((message) => message.content === 'Final answer.');

    expect(assistant?.metadata).toEqual({
      isStreaming: false,
      isFinal: true,
      model: 'anthropic/claude-sonnet',
    });
  });

  test('does not lend newer user-only sessionInfo to the previous reply', () => {
    const messages = parseSubagentGatewayHistoryMessages([
      { role: 'user', content: 'first' },
      {
        role: 'assistant',
        content: 'First answer.',
        usage: { input: 10_000, output: 100 },
      },
      { role: 'user', content: 'second' },
    ], {
      createId: deterministicIds(),
      contextTokens: 1_000_000,
      sessionModel: 'new-turn/model',
    });
    const assistant = messages.find((message) => message.content === 'First answer.');

    expect(assistant?.metadata).toMatchObject({
      usage: { inputTokens: 10_000, outputTokens: 100 },
    });
    expect(assistant?.metadata).not.toHaveProperty('contextPercent');
    expect(assistant?.metadata).not.toHaveProperty('model');
  });

  test('keeps the latest active reply streaming without partial usage or context', () => {
    const messages = parseSubagentGatewayHistoryMessages([
      { role: 'user', content: 'inspect' },
      {
        role: 'assistant',
        content: 'Working on it',
        usage: { input: 20_000, output: 50, cacheRead: 10_000 },
        model: 'google/gemini-2.5-flash',
        provider: 'openrouter',
      },
    ], {
      createId: deterministicIds(),
      contextTokens: 100_000,
      sessionModel: 'google/gemini-2.5-flash',
      latestTurnActive: true,
    });
    const assistant = messages.find((message) => message.type === 'assistant');

    expect(assistant?.metadata).toEqual({
      isStreaming: true,
      isFinal: false,
      model: 'openrouter/google/gemini-2.5-flash',
    });
    expect(assistant?.metadata).not.toHaveProperty('usage');
    expect(assistant?.metadata).not.toHaveProperty('contextPercent');
  });
});
