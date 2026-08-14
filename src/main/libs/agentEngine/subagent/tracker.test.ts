import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { SubagentMessageStore } from '../../../subagentMessageStore';
import { SubagentRunStore } from '../../../subagentRunStore';
import { type GatewayClientLike, SubagentTracker } from './tracker';

let db: BetterSqlite3.Database;
let runStore: SubagentRunStore;
let messageStore: SubagentMessageStore;

const createDeferred = <T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} => {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value: T) => resolvePromise?.(value),
  };
};

const setupDb = (): void => {
  db = new BetterSqlite3(':memory:');
  db.exec(`
    CREATE TABLE subagent_runs (
      id TEXT PRIMARY KEY,
      parent_session_id TEXT NOT NULL,
      session_key TEXT,
      child_cowork_session_id TEXT,
      agent_id TEXT,
      task TEXT,
      label TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      created_at INTEGER NOT NULL,
      ended_at INTEGER,
      messages_persisted INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.exec(`
    CREATE TABLE subagent_messages (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      metadata TEXT,
      created_at INTEGER NOT NULL,
      sequence INTEGER NOT NULL DEFAULT 0
    );
  `);
  runStore = new SubagentRunStore(db);
  messageStore = new SubagentMessageStore(db);
};

beforeEach(() => {
  setupDb();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('deleteSubagentRun removes a single run, messages, and gateway transcript', async () => {
  const gatewayClient: GatewayClientLike = {
    request: vi.fn().mockResolvedValue({}),
  };
  const tracker = new SubagentTracker(runStore, messageStore, () => gatewayClient);

  runStore.insertSubagentRun({
    id: 'run-1',
    parentSessionId: 'parent-1',
    sessionKey: 'agent:main:subagent:run-1',
    agentId: 'worker',
    task: 'inspect files',
    label: 'worker',
    status: 'done',
    createdAt: 1000,
  });
  messageStore.insertMessages('run-1', [{
    id: 'message-1',
    type: 'assistant',
    content: 'done',
    timestamp: 1001,
    sequence: 1,
  }]);

  const deleted = await tracker.deleteSubagentRun('parent-1', 'run-1');

  expect(deleted).toBe(true);
  expect(runStore.getSubagentRun('run-1')).toBeNull();
  expect(messageStore.hasMessages('run-1')).toBe(false);
  expect(gatewayClient.request).toHaveBeenCalledWith(
    'sessions.delete',
    { key: 'agent:main:subagent:run-1', deleteTranscript: true },
    { timeoutMs: 5_000 },
  );
});

test('deleteSubagentRun returns after local deletion without waiting for gateway cleanup', async () => {
  let resolveGatewayDelete: (() => void) | null = null;
  const gatewayDeletePromise = new Promise<void>((resolve) => {
    resolveGatewayDelete = resolve;
  });
  const gatewayClient: GatewayClientLike = {
    request: vi.fn().mockReturnValue(gatewayDeletePromise),
  };
  const tracker = new SubagentTracker(runStore, messageStore, () => gatewayClient);

  runStore.insertSubagentRun({
    id: 'run-1',
    parentSessionId: 'parent-1',
    sessionKey: 'agent:main:subagent:run-1',
    agentId: 'worker',
    task: 'inspect files',
    label: 'worker',
    status: 'done',
    createdAt: 1000,
  });

  const deleted = await tracker.deleteSubagentRun('parent-1', 'run-1');

  expect(deleted).toBe(true);
  expect(runStore.getSubagentRun('run-1')).toBeNull();
  expect(gatewayClient.request).toHaveBeenCalledTimes(1);

  resolveGatewayDelete?.();
});

test('late history fetch cannot restore cache or persistence after deleting its run', async () => {
  const historyDeferred = createDeferred<{ messages: unknown[]; sessionInfo?: unknown }>();
  const request = vi.fn((method: string) => (
    method === 'chat.history' ? historyDeferred.promise : Promise.resolve({})
  ));
  const gatewayClient = { request } as unknown as GatewayClientLike;
  const tracker = new SubagentTracker(runStore, messageStore, () => gatewayClient);
  runStore.insertSubagentRun({
    id: 'run-fetch-delete',
    parentSessionId: 'parent-1',
    sessionKey: 'agent:main:subagent:run-fetch-delete',
    agentId: 'worker',
    task: 'inspect',
    label: 'worker',
    status: 'done',
    createdAt: 1000,
  });

  const historyPromise = tracker.getSubTaskHistory('parent-1', 'run-fetch-delete');
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
    'chat.history',
    { sessionKey: 'agent:main:subagent:run-fetch-delete', limit: 100 },
    { timeoutMs: 10_000 },
  ));
  await expect(tracker.deleteSubagentRun('parent-1', 'run-fetch-delete')).resolves.toBe(true);
  historyDeferred.resolve({
    messages: [
      { role: 'user', content: 'inspect' },
      { role: 'assistant', content: 'Late answer', usage: { input: 10, output: 2 } },
    ],
  });

  await expect(historyPromise).resolves.toEqual([]);
  expect(runStore.getSubagentRun('run-fetch-delete')).toBeNull();
  expect(messageStore.hasMessages('run-fetch-delete')).toBe(false);
  expect((tracker as unknown as {
    subagentMessages: Map<string, unknown>;
  }).subagentMessages.has('run-fetch-delete')).toBe(false);
});

test('parent session deletion invalidates an in-flight history fetch', async () => {
  const historyDeferred = createDeferred<{ messages: unknown[] }>();
  const gatewayClient = {
    request: vi.fn(() => historyDeferred.promise),
  } as unknown as GatewayClientLike;
  const tracker = new SubagentTracker(runStore, messageStore, () => gatewayClient);
  runStore.insertSubagentRun({
    id: 'run-parent-delete',
    parentSessionId: 'parent-1',
    sessionKey: 'agent:main:subagent:run-parent-delete',
    agentId: 'worker',
    task: 'inspect',
    label: 'worker',
    status: 'done',
    createdAt: 1000,
  });

  const historyPromise = tracker.getSubTaskHistory('parent-1', 'run-parent-delete');
  await vi.waitFor(() => expect(gatewayClient.request).toHaveBeenCalledTimes(1));
  tracker.onSessionDeleted('parent-1');
  historyDeferred.resolve({
    messages: [
      { role: 'user', content: 'inspect' },
      { role: 'assistant', content: 'Late answer', usage: { input: 10, output: 2 } },
    ],
  });

  await expect(historyPromise).resolves.toEqual([]);
  expect(runStore.getSubagentRun('run-parent-delete')).toBeNull();
  expect(messageStore.hasMessages('run-parent-delete')).toBe(false);
});

test('gateway cleanup retries are capped when delete keeps failing', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const gatewayClient: GatewayClientLike = {
    request: vi.fn().mockRejectedValue(new Error('gateway busy')),
  };
  const tracker = new SubagentTracker(runStore, messageStore, () => gatewayClient);

  runStore.insertSubagentRun({
    id: 'run-1',
    parentSessionId: 'parent-1',
    sessionKey: 'agent:main:subagent:run-1',
    agentId: 'worker',
    task: 'inspect files',
    label: 'worker',
    status: 'done',
    createdAt: 1000,
  });

  const deleted = await tracker.deleteSubagentRun('parent-1', 'run-1');

  expect(deleted).toBe(true);
  expect(gatewayClient.request).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(5_000);
  expect(gatewayClient.request).toHaveBeenCalledTimes(2);

  await vi.advanceTimersByTimeAsync(10_000);
  expect(gatewayClient.request).toHaveBeenCalledTimes(3);

  await vi.advanceTimersByTimeAsync(20_000);
  expect(gatewayClient.request).toHaveBeenCalledTimes(3);
});

test('deleteSubagentRun refuses to delete a run from another parent session', async () => {
  const tracker = new SubagentTracker(runStore, messageStore, () => null);
  runStore.insertSubagentRun({
    id: 'run-1',
    parentSessionId: 'parent-1',
    sessionKey: null,
    agentId: 'worker',
    task: 'inspect files',
    label: 'worker',
    status: 'done',
    createdAt: 1000,
  });

  const deleted = await tracker.deleteSubagentRun('parent-2', 'run-1');

  expect(deleted).toBe(false);
  expect(runStore.getSubagentRun('run-1')).not.toBeNull();
});

test('onSessionDeleted removes subagent runs and messages for the parent session', () => {
  const tracker = new SubagentTracker(runStore, messageStore, () => null);
  runStore.insertSubagentRun({
    id: 'run-1',
    parentSessionId: 'parent-1',
    sessionKey: null,
    agentId: 'worker',
    task: 'inspect files',
    label: 'worker',
    status: 'done',
    createdAt: 1000,
  });
  runStore.insertSubagentRun({
    id: 'run-2',
    parentSessionId: 'parent-2',
    sessionKey: null,
    agentId: 'worker',
    task: 'inspect files',
    label: 'worker',
    status: 'done',
    createdAt: 1000,
  });
  messageStore.insertMessages('run-1', [{
    id: 'message-1',
    type: 'assistant',
    content: 'done',
    timestamp: 1001,
    sequence: 1,
  }]);

  tracker.onSessionDeleted('parent-1');

  expect(runStore.getSubagentRun('run-1')).toBeNull();
  expect(messageStore.hasMessages('run-1')).toBe(false);
  expect(runStore.getSubagentRun('run-2')).not.toBeNull();
});

test('getSubTaskHistory preserves persisted message timestamps', async () => {
  const gatewayClient: GatewayClientLike = {
    request: vi.fn().mockResolvedValue({ messages: [] }),
  };
  const tracker = new SubagentTracker(runStore, messageStore, () => gatewayClient);
  runStore.insertSubagentRun({
    id: 'run-1',
    parentSessionId: 'parent-1',
    sessionKey: 'agent:main:subagent:run-1',
    agentId: 'worker',
    task: 'inspect files',
    label: 'worker',
    status: 'done',
    createdAt: 1000,
  });
  messageStore.insertMessages('run-1', [{
    id: 'message-1',
    type: 'assistant',
    content: 'done',
    timestamp: 1001,
    sequence: 1,
  }]);
  runStore.markMessagesPersisted('run-1');

  const messages = await tracker.getSubTaskHistory('parent-1', 'run-1');

  expect(messages).toEqual([{
    id: 'message-1',
    type: 'assistant',
    content: 'done',
    timestamp: 1001,
    metadata: undefined,
  }]);
  expect(gatewayClient.request).toHaveBeenCalledTimes(1);
});

test('malformed persisted metadata does not block subagent history reads', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const tracker = new SubagentTracker(runStore, messageStore, () => null);
  runStore.insertSubagentRun({
    id: 'run-malformed-metadata',
    parentSessionId: 'parent-1',
    sessionKey: 'agent:main:subagent:run-malformed-metadata',
    agentId: 'worker',
    task: 'inspect files',
    label: 'worker',
    status: 'done',
    createdAt: 1000,
  });
  messageStore.insertMessages('run-malformed-metadata', [{
    id: 'malformed-message',
    type: 'assistant',
    content: 'done',
    timestamp: 1001,
    sequence: 1,
  }]);
  db.prepare('UPDATE subagent_messages SET metadata = ? WHERE id = ?')
    .run('{not-valid-json', 'malformed-message');
  runStore.markMessagesPersisted('run-malformed-metadata');

  await expect(tracker.getSubTaskHistory('parent-1', 'run-malformed-metadata'))
    .resolves.toEqual([{
      id: 'malformed-message',
      type: 'assistant',
      content: 'done',
      timestamp: 1001,
      metadata: undefined,
    }]);
  expect(warn).toHaveBeenCalledWith(
    '[SubagentTracker] ignored malformed persisted message metadata for runId:',
    'run-malformed-metadata',
    expect.any(SyntaxError),
  );
});

test('newer same-run history fetch wins when gateway responses arrive out of order', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const historyDeferreds = [
    createDeferred<{ messages: unknown[]; sessionInfo: unknown }>(),
    createDeferred<{ messages: unknown[]; sessionInfo: unknown }>(),
  ];
  let requestIndex = 0;
  const gatewayClient = {
    request: vi.fn(() => historyDeferreds[requestIndex++].promise),
  } as unknown as GatewayClientLike;
  const tracker = new SubagentTracker(runStore, messageStore, () => gatewayClient);
  runStore.insertSubagentRun({
    id: 'run-out-of-order',
    parentSessionId: 'parent-1',
    sessionKey: 'agent:main:subagent:run-out-of-order',
    agentId: 'worker',
    task: 'inspect',
    label: 'worker',
    status: 'done',
    createdAt: 1000,
  });

  const olderPromise = tracker.getSubTaskHistory('parent-1', 'run-out-of-order');
  const newerPromise = tracker.getSubTaskHistory('parent-1', 'run-out-of-order');
  await vi.waitFor(() => expect(gatewayClient.request).toHaveBeenCalledTimes(2));

  historyDeferreds[1].resolve({
    messages: [
      { role: 'user', content: 'inspect', timestamp: 1000 },
      {
        role: 'assistant',
        content: 'Newest answer',
        timestamp: 1002,
        usage: { input: 20, output: 4 },
        model: 'anthropic/claude-sonnet',
      },
    ],
    sessionInfo: {
      contextTokens: 100,
      model: 'claude-sonnet',
      modelProvider: 'anthropic',
    },
  });
  await expect(newerPromise).resolves.toMatchObject([
    { type: 'user', content: 'inspect' },
    { type: 'assistant', content: 'Newest answer' },
  ]);

  historyDeferreds[0].resolve({
    messages: [
      { role: 'user', content: 'inspect', timestamp: 1000 },
      {
        role: 'assistant',
        content: 'Older answer',
        timestamp: 1001,
        usage: { input: 10, output: 2 },
        model: 'anthropic/claude-sonnet',
      },
    ],
    sessionInfo: {
      contextTokens: 100,
      model: 'claude-sonnet',
      modelProvider: 'anthropic',
    },
  });
  await expect(olderPromise).resolves.toEqual([]);

  expect(messageStore.getMessages('run-out-of-order').map(message => message.content))
    .toEqual(['inspect', 'Newest answer']);
  const cached = await tracker.getSubTaskHistory('parent-1', 'run-out-of-order');
  expect(cached.map(message => message.content)).toEqual(['inspect', 'Newest answer']);
  expect(gatewayClient.request).toHaveBeenCalledTimes(2);
});

test('bounded authoritative metadata backfill preserves more than 100 persisted rows', async () => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  const gatewayClient: GatewayClientLike = {
    request: vi.fn().mockResolvedValue({
      messages: [
        { role: 'user', content: 'inspect files', timestamp: 1000 },
        {
          role: 'assistant',
          content: 'done',
          timestamp: 1001,
          usage: { input: 10_000, output: 100, cacheRead: 5_000 },
          model: 'anthropic/claude-sonnet',
        },
      ],
      sessionInfo: {
        contextTokens: 100_000,
        model: 'claude-sonnet',
        modelProvider: 'anthropic',
      },
    }),
  };
  const tracker = new SubagentTracker(runStore, messageStore, () => gatewayClient);
  runStore.insertSubagentRun({
    id: 'run-upgrade',
    parentSessionId: 'parent-1',
    sessionKey: 'agent:main:subagent:run-upgrade',
    agentId: 'worker',
    task: 'inspect files',
    label: 'worker',
    status: 'done',
    createdAt: 1000,
  });
  messageStore.insertMessages('run-upgrade', [
    ...Array.from({ length: 101 }, (_, index) => ({
      id: `old-prefix-${index}`,
      type: 'tool_result',
      content: `old result ${index}`,
      metadata: { localOnly: true },
      timestamp: index,
      sequence: index + 1,
    })),
    {
      id: 'old-message',
      type: 'assistant',
      content: 'done',
      metadata: { customFlag: true },
      timestamp: 1001,
      sequence: 102,
    },
  ]);
  runStore.markMessagesPersisted('run-upgrade');

  const messages = await tracker.getSubTaskHistory('parent-1', 'run-upgrade');
  const assistant = messages.find((message) => message.type === 'assistant');

  expect(assistant?.metadata).toMatchObject({
    customFlag: true,
    usage: {
      inputTokens: 10_000,
      outputTokens: 100,
      cacheReadTokens: 5_000,
    },
    contextPercent: 15,
    model: 'anthropic/claude-sonnet',
  });
  const persisted = messageStore.getMessages('run-upgrade');
  expect(persisted).toHaveLength(102);
  expect(persisted[0].id).toBe('old-prefix-0');
  expect(persisted.at(-1)?.id).toBe('old-message');
  expect(persisted.at(-1)?.createdAt).toBe(1001);
  expect(persisted.map((message) => (
    message.metadata ? JSON.parse(message.metadata) : null
  ))).toContainEqual(assistant?.metadata);
});

test('metadata backfill completes partially populated legacy usage metadata once', async () => {
  const gatewayClient: GatewayClientLike = {
    request: vi.fn().mockResolvedValue({
      messages: [
        { role: 'user', content: 'inspect files', timestamp: 1000 },
        {
          role: 'assistant',
          content: 'done',
          timestamp: 1001,
          usage: { input: 10_000, output: 100, cacheRead: 5_000, cacheWrite: 500 },
          model: 'anthropic/claude-sonnet',
        },
      ],
      sessionInfo: {
        contextTokens: 100_000,
        model: 'claude-sonnet',
        modelProvider: 'anthropic',
      },
    }),
  };
  const tracker = new SubagentTracker(runStore, messageStore, () => gatewayClient);
  runStore.insertSubagentRun({
    id: 'run-partial-upgrade',
    parentSessionId: 'parent-1',
    sessionKey: 'agent:main:subagent:run-partial-upgrade',
    agentId: 'worker',
    task: 'inspect files',
    label: 'worker',
    status: 'done',
    createdAt: 1000,
  });
  messageStore.insertMessages('run-partial-upgrade', [{
    id: 'old-message',
    type: 'assistant',
    content: 'done',
    metadata: { usage: { inputTokens: 10_000 }, customFlag: true },
    timestamp: 1001,
    sequence: 1,
  }]);
  runStore.markMessagesPersisted('run-partial-upgrade');

  const first = await tracker.getSubTaskHistory('parent-1', 'run-partial-upgrade');
  const second = await tracker.getSubTaskHistory('parent-1', 'run-partial-upgrade');

  expect(first[0].metadata).toMatchObject({
    customFlag: true,
    usage: {
      inputTokens: 10_000,
      outputTokens: 100,
      cacheReadTokens: 5_000,
      cacheWriteTokens: 500,
    },
    contextPercent: 16,
    model: 'anthropic/claude-sonnet',
    openclawUsageMetadataBackfillVersion: 1,
  });
  expect(second).toEqual(first);
  expect(gatewayClient.request).toHaveBeenCalledTimes(1);
});

test('metadata backfill does not permanently mark a lagging transcript without usage', async () => {
  const request = vi.fn().mockResolvedValueOnce({
    messages: [
      { role: 'user', content: 'inspect files', timestamp: 1000 },
      { role: 'assistant', content: 'done', timestamp: 1001 },
    ],
  }).mockResolvedValueOnce({
    messages: [
      { role: 'user', content: 'inspect files', timestamp: 1000 },
      {
        role: 'assistant',
        content: 'done',
        timestamp: 1001,
        usage: { input: 10_000, output: 100 },
        model: 'anthropic/claude-sonnet',
      },
    ],
    sessionInfo: {
      contextTokens: 100_000,
      model: 'claude-sonnet',
      modelProvider: 'anthropic',
    },
  });
  const gatewayClient: GatewayClientLike = { request };
  runStore.insertSubagentRun({
    id: 'run-lagging-upgrade',
    parentSessionId: 'parent-1',
    sessionKey: 'agent:main:subagent:run-lagging-upgrade',
    agentId: 'worker',
    task: 'inspect files',
    label: 'worker',
    status: 'done',
    createdAt: 1000,
  });
  messageStore.insertMessages('run-lagging-upgrade', [{
    id: 'old-message',
    type: 'assistant',
    content: 'done',
    timestamp: 1001,
    sequence: 1,
  }]);
  runStore.markMessagesPersisted('run-lagging-upgrade');

  const firstTracker = new SubagentTracker(runStore, messageStore, () => gatewayClient);
  const first = await firstTracker.getSubTaskHistory('parent-1', 'run-lagging-upgrade');
  expect(first[0].metadata).not.toHaveProperty('openclawUsageMetadataBackfillVersion');

  // A fresh process can retry after OpenClaw has flushed the usage counters.
  const secondTracker = new SubagentTracker(runStore, messageStore, () => gatewayClient);
  const second = await secondTracker.getSubTaskHistory('parent-1', 'run-lagging-upgrade');

  expect(second[0].metadata).toMatchObject({
    usage: { inputTokens: 10_000, outputTokens: 100 },
    contextPercent: 10,
    openclawUsageMetadataBackfillVersion: 1,
  });
  expect(request).toHaveBeenCalledTimes(2);
});

test('metadata backfill aligns identical replies before merging older usage', async () => {
  const gatewayClient: GatewayClientLike = {
    request: vi.fn().mockResolvedValue({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'OK', usage: { input: 10_000, output: 100 } },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'OK' },
      ],
      sessionInfo: { contextTokens: 100_000 },
    }),
  };
  const tracker = new SubagentTracker(runStore, messageStore, () => gatewayClient);
  runStore.insertSubagentRun({
    id: 'run-identical',
    parentSessionId: 'parent-1',
    sessionKey: 'agent:main:subagent:run-identical',
    agentId: 'worker',
    task: 'check twice',
    label: 'worker',
    status: 'done',
    createdAt: 1000,
  });
  messageStore.insertMessages('run-identical', [
    { id: 'user-1', type: 'user', content: 'first', timestamp: 1, sequence: 1 },
    { id: 'assistant-1', type: 'assistant', content: 'OK', timestamp: 2, sequence: 2 },
    { id: 'user-2', type: 'user', content: 'second', timestamp: 3, sequence: 3 },
    { id: 'assistant-2', type: 'assistant', content: 'OK', timestamp: 4, sequence: 4 },
  ]);
  runStore.markMessagesPersisted('run-identical');

  const messages = await tracker.getSubTaskHistory('parent-1', 'run-identical');
  const assistants = messages.filter((message) => message.type === 'assistant');

  expect(assistants[0].metadata).toMatchObject({
    usage: { inputTokens: 10_000, outputTokens: 100 },
  });
  expect(assistants[1].metadata).not.toHaveProperty('usage');
});

test('lagging older turn usage cannot attach to a newer identical persisted reply', async () => {
  const gatewayClient: GatewayClientLike = {
    request: vi.fn().mockResolvedValue({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'OK', usage: { input: 10_000, output: 100 } },
      ],
    }),
  };
  const tracker = new SubagentTracker(runStore, messageStore, () => gatewayClient);
  runStore.insertSubagentRun({
    id: 'run-lagging-turn',
    parentSessionId: 'parent-1',
    sessionKey: 'agent:main:subagent:run-lagging-turn',
    agentId: 'worker',
    task: 'check twice',
    label: 'worker',
    status: 'done',
    createdAt: 1000,
  });
  messageStore.insertMessages('run-lagging-turn', [
    { id: 'user-1', type: 'user', content: 'first', timestamp: 1, sequence: 1 },
    {
      id: 'assistant-1',
      type: 'assistant',
      content: 'OK',
      metadata: { turnMarker: 'first' },
      timestamp: 2,
      sequence: 2,
    },
    { id: 'user-2', type: 'user', content: 'second', timestamp: 3, sequence: 3 },
    {
      id: 'assistant-2',
      type: 'assistant',
      content: 'OK',
      metadata: { turnMarker: 'second' },
      timestamp: 4,
      sequence: 4,
    },
  ]);
  runStore.markMessagesPersisted('run-lagging-turn');

  const messages = await tracker.getSubTaskHistory('parent-1', 'run-lagging-turn');
  const assistants = messages.filter(message => message.type === 'assistant');

  expect(assistants[0].metadata).toEqual({ turnMarker: 'first' });
  expect(assistants[1].metadata).toEqual({ turnMarker: 'second' });
  expect(messageStore.getMessages('run-lagging-turn').map(message => message.metadata))
    .toEqual([
      null,
      JSON.stringify({ turnMarker: 'first' }),
      null,
      JSON.stringify({ turnMarker: 'second' }),
    ]);
});

test('metadata backfill maps corrected final assistant text within a changed tool topology', async () => {
  const gatewayClient: GatewayClientLike = {
    request: vi.fn().mockResolvedValue({
      messages: [
        { role: 'user', content: 'inspect' },
        { role: 'assistant', content: 'I will inspect.' },
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call-1', name: 'read', input: {} }],
          usage: { input: 5_000, output: 25 },
        },
        { role: 'toolResult', toolCallId: 'call-1', content: 'contents' },
        {
          role: 'assistant',
          content: 'Corrected final answer',
          usage: { input: 10_000, output: 100 },
          model: 'anthropic/claude-sonnet',
        },
      ],
      sessionInfo: {
        contextTokens: 100_000,
        model: 'claude-sonnet',
        modelProvider: 'anthropic',
      },
    }),
  };
  const tracker = new SubagentTracker(runStore, messageStore, () => gatewayClient);
  runStore.insertSubagentRun({
    id: 'run-corrected-topology',
    parentSessionId: 'parent-1',
    sessionKey: 'agent:main:subagent:run-corrected-topology',
    agentId: 'worker',
    task: 'inspect',
    label: 'worker',
    status: 'done',
    createdAt: 1000,
  });
  messageStore.insertMessages('run-corrected-topology', [
    { id: 'user-1', type: 'user', content: 'inspect', timestamp: 1, sequence: 1 },
    {
      id: 'assistant-intro',
      type: 'assistant',
      content: 'I will inspect.',
      metadata: { assistantRoot: 'intro' },
      timestamp: 2,
      sequence: 2,
    },
    {
      id: 'assistant-final',
      type: 'assistant',
      content: 'Final answr',
      metadata: { assistantRoot: 'final', skillIds: ['skill-1'] },
      timestamp: 3,
      sequence: 3,
    },
  ]);
  runStore.markMessagesPersisted('run-corrected-topology');

  const messages = await tracker.getSubTaskHistory('parent-1', 'run-corrected-topology');
  const intro = messages.find(message => message.id === 'assistant-intro');
  const final = messages.find(message => message.id === 'assistant-final');

  expect(intro?.metadata).toEqual({ assistantRoot: 'intro' });
  expect(final).toMatchObject({
    content: 'Final answr',
    metadata: {
      assistantRoot: 'final',
      skillIds: ['skill-1'],
      isStreaming: false,
      isFinal: true,
      usage: { inputTokens: 15_000, outputTokens: 125 },
      contextPercent: 10,
      model: 'anthropic/claude-sonnet',
      openclawUsageMetadataBackfillVersion: 1,
    },
  });
});

test('metadata backfill refuses an ambiguous repeated user-anchor tail', async () => {
  const gatewayClient: GatewayClientLike = {
    request: vi.fn().mockResolvedValue({
      messages: [
        { role: 'user', content: 'retry' },
        { role: 'assistant', content: 'OK', usage: { input: 10_000, output: 100 } },
      ],
    }),
  };
  const tracker = new SubagentTracker(runStore, messageStore, () => gatewayClient);
  runStore.insertSubagentRun({
    id: 'run-ambiguous-anchor',
    parentSessionId: 'parent-1',
    sessionKey: 'agent:main:subagent:run-ambiguous-anchor',
    agentId: 'worker',
    task: 'retry',
    label: 'worker',
    status: 'done',
    createdAt: 1000,
  });
  messageStore.insertMessages('run-ambiguous-anchor', [
    { id: 'user-1', type: 'user', content: 'retry', timestamp: 1, sequence: 1 },
    {
      id: 'assistant-1',
      type: 'assistant',
      content: 'OK',
      metadata: { turnMarker: 'first' },
      timestamp: 2,
      sequence: 2,
    },
    { id: 'user-2', type: 'user', content: 'retry', timestamp: 3, sequence: 3 },
    {
      id: 'assistant-2',
      type: 'assistant',
      content: 'OK',
      metadata: { turnMarker: 'second' },
      timestamp: 4,
      sequence: 4,
    },
  ]);
  runStore.markMessagesPersisted('run-ambiguous-anchor');

  const messages = await tracker.getSubTaskHistory('parent-1', 'run-ambiguous-anchor');
  const assistants = messages.filter(message => message.type === 'assistant');

  expect(assistants.map(message => message.metadata)).toEqual([
    { turnMarker: 'first' },
    { turnMarker: 'second' },
  ]);
});

test('legacy assistant-only backfill requires a unique authoritative reply', async () => {
  const gatewayClient: GatewayClientLike = {
    request: vi.fn().mockResolvedValue({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'OK', usage: { input: 10_000, output: 100 } },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'OK', usage: { input: 20_000, output: 200 } },
      ],
    }),
  };
  const tracker = new SubagentTracker(runStore, messageStore, () => gatewayClient);
  runStore.insertSubagentRun({
    id: 'run-unanchored-ambiguous',
    parentSessionId: 'parent-1',
    sessionKey: 'agent:main:subagent:run-unanchored-ambiguous',
    agentId: 'worker',
    task: 'check twice',
    label: 'worker',
    status: 'done',
    createdAt: 1000,
  });
  messageStore.insertMessages('run-unanchored-ambiguous', [{
    id: 'legacy-assistant',
    type: 'assistant',
    content: 'OK',
    metadata: { customFlag: true },
    timestamp: 1,
    sequence: 1,
  }]);
  runStore.markMessagesPersisted('run-unanchored-ambiguous');

  const messages = await tracker.getSubTaskHistory('parent-1', 'run-unanchored-ambiguous');

  expect(messages[0].metadata).toEqual({ customFlag: true });
  expect(JSON.parse(messageStore.getMessages('run-unanchored-ambiguous')[0].metadata ?? '{}'))
    .toEqual({ customFlag: true });
});

test('getSubTaskHistory persists OpenClaw usage metadata for completed runs', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const gatewayClient: GatewayClientLike = {
    request: vi.fn().mockResolvedValue({
      messages: [
        { role: 'user', content: 'inspect files', timestamp: 1000 },
        {
          role: 'assistant',
          content: 'Inspection complete.',
          timestamp: 1001,
          usage: {
            input_tokens: 10_000,
            completion_tokens: 250,
            cache_read_input_tokens: 5_000,
            cache_creation_input_tokens: 500,
          },
          model: 'anthropic/claude-sonnet',
        },
      ],
      sessionInfo: {
        contextTokens: 100_000,
        model: 'claude-sonnet',
        modelProvider: 'anthropic',
      },
    }),
  };
  const tracker = new SubagentTracker(runStore, messageStore, () => gatewayClient);
  runStore.insertSubagentRun({
    id: 'run-usage',
    parentSessionId: 'parent-1',
    sessionKey: 'agent:main:subagent:run-usage',
    agentId: 'worker',
    task: 'inspect files',
    label: 'worker',
    status: 'done',
    createdAt: 1000,
  });

  const messages = await tracker.getSubTaskHistory('parent-1', 'run-usage');
  const assistant = messages.find((message) => message.type === 'assistant');

  expect(assistant?.metadata).toEqual({
    isStreaming: false,
    isFinal: true,
    usage: {
      inputTokens: 10_000,
      outputTokens: 250,
      cacheReadTokens: 5_000,
      cacheWriteTokens: 500,
    },
    contextPercent: 16,
    model: 'anthropic/claude-sonnet',
    openclawUsageMetadataBackfillVersion: 1,
  });
  expect(gatewayClient.request).toHaveBeenCalledWith(
    'chat.history',
    { sessionKey: 'agent:main:subagent:run-usage', limit: 100 },
    { timeoutMs: 10_000 },
  );
  expect(runStore.isMessagesPersisted('run-usage')).toBe(true);
  expect(messageStore.getMessages('run-usage').map((message) => (
    message.metadata ? JSON.parse(message.metadata) : null
  ))).toContainEqual(assistant?.metadata);

  const secondRead = await tracker.getSubTaskHistory('parent-1', 'run-usage');
  expect(secondRead).toEqual(messages);
  expect(gatewayClient.request).toHaveBeenCalledTimes(1);
});

test('getSubTaskHistory keeps an active gateway reply streaming without partial usage', async () => {
  const gatewayClient: GatewayClientLike = {
    request: vi.fn().mockResolvedValue({
      messages: [
        { role: 'user', content: 'inspect files', timestamp: 1000 },
        {
          role: 'assistant',
          content: 'Working on it',
          timestamp: 1001,
          usage: { input: 10_000, output: 100, cacheRead: 5_000 },
          model: 'google/gemini-2.5-flash',
          provider: 'openrouter',
        },
      ],
      sessionInfo: {
        hasActiveRun: true,
        contextTokens: 100_000,
        model: 'google/gemini-2.5-flash',
        modelProvider: 'openrouter',
      },
    }),
  };
  const tracker = new SubagentTracker(runStore, messageStore, () => gatewayClient);
  runStore.insertSubagentRun({
    id: 'run-active',
    parentSessionId: 'parent-1',
    sessionKey: 'agent:main:subagent:run-active',
    agentId: 'worker',
    task: 'inspect files',
    label: 'worker',
    status: 'running',
    createdAt: 1000,
  });

  const messages = await tracker.getSubTaskHistory('parent-1', 'run-active');
  const assistant = messages.find((message) => message.type === 'assistant');

  expect(assistant?.metadata).toEqual({
    isStreaming: true,
    isFinal: false,
    model: 'openrouter/google/gemini-2.5-flash',
  });
  expect(assistant?.metadata).not.toHaveProperty('usage');
  expect(assistant?.metadata).not.toHaveProperty('contextPercent');
  expect(runStore.isMessagesPersisted('run-active')).toBe(false);
});

test('running local status keeps latest reply active when session activity flags are absent', async () => {
  const gatewayClient: GatewayClientLike = {
    request: vi.fn().mockResolvedValue({
      messages: [
        { role: 'user', content: 'inspect files', timestamp: 1000 },
        {
          role: 'assistant',
          content: 'Still working',
          timestamp: 1001,
          usage: { input: 10_000, output: 100, cacheRead: 5_000 },
          model: 'google/gemini-2.5-flash',
          provider: 'openrouter',
        },
      ],
      sessionInfo: {
        contextTokens: 100_000,
        model: 'google/gemini-2.5-flash',
        modelProvider: 'openrouter',
      },
    }),
  };
  const tracker = new SubagentTracker(runStore, messageStore, () => gatewayClient);
  runStore.insertSubagentRun({
    id: 'run-local-active-fallback',
    parentSessionId: 'parent-1',
    sessionKey: 'agent:main:subagent:run-local-active-fallback',
    agentId: 'worker',
    task: 'inspect files',
    label: 'worker',
    status: 'running',
    createdAt: 1000,
  });

  const messages = await tracker.getSubTaskHistory('parent-1', 'run-local-active-fallback');
  const assistant = messages.find(message => message.type === 'assistant');

  expect(assistant?.metadata).toEqual({
    isStreaming: true,
    isFinal: false,
    model: 'openrouter/google/gemini-2.5-flash',
  });
  expect(assistant?.metadata).not.toHaveProperty('usage');
  expect(assistant?.metadata).not.toHaveProperty('contextPercent');
  expect(runStore.isMessagesPersisted('run-local-active-fallback')).toBe(false);
});

test('explicit terminal session status overrides a stale local running status', async () => {
  const gatewayClient: GatewayClientLike = {
    request: vi.fn().mockResolvedValue({
      messages: [
        { role: 'user', content: 'inspect files', timestamp: 1000 },
        {
          role: 'assistant',
          content: 'Finished',
          timestamp: 1001,
          usage: { input: 10_000, output: 100, cacheRead: 5_000 },
          model: 'anthropic/claude-sonnet',
        },
      ],
      sessionInfo: {
        status: 'completed',
        contextTokens: 100_000,
        model: 'claude-sonnet',
        modelProvider: 'anthropic',
      },
    }),
  };
  const tracker = new SubagentTracker(runStore, messageStore, () => gatewayClient);
  runStore.insertSubagentRun({
    id: 'run-terminal-session-info',
    parentSessionId: 'parent-1',
    sessionKey: 'agent:main:subagent:run-terminal-session-info',
    agentId: 'worker',
    task: 'inspect files',
    label: 'worker',
    status: 'running',
    createdAt: 1000,
  });

  const messages = await tracker.getSubTaskHistory('parent-1', 'run-terminal-session-info');
  const assistant = messages.find(message => message.type === 'assistant');

  expect(assistant?.metadata).toEqual({
    isStreaming: false,
    isFinal: true,
    usage: {
      inputTokens: 10_000,
      outputTokens: 100,
      cacheReadTokens: 5_000,
    },
    contextPercent: 15,
    model: 'anthropic/claude-sonnet',
  });
  expect(runStore.isMessagesPersisted('run-terminal-session-info')).toBe(false);
});

test('active metadata backfill clears partial usage from a persisted reply', async () => {
  const gatewayClient: GatewayClientLike = {
    request: vi.fn().mockResolvedValue({
      messages: [
        { role: 'user', content: 'inspect files', timestamp: 1000 },
        {
          role: 'assistant',
          content: 'Working on it',
          timestamp: 1001,
          usage: { input: 10_000, output: 100 },
          model: 'anthropic/claude-sonnet',
        },
      ],
      sessionInfo: {
        hasActiveRun: true,
        contextTokens: 100_000,
        model: 'claude-sonnet',
        modelProvider: 'anthropic',
      },
    }),
  };
  const tracker = new SubagentTracker(runStore, messageStore, () => gatewayClient);
  runStore.insertSubagentRun({
    id: 'run-active-backfill',
    parentSessionId: 'parent-1',
    sessionKey: 'agent:main:subagent:run-active-backfill',
    agentId: 'worker',
    task: 'inspect files',
    label: 'worker',
    status: 'done',
    createdAt: 1000,
  });
  messageStore.insertMessages('run-active-backfill', [{
    id: 'persisted-assistant',
    type: 'assistant',
    content: 'Working on it',
    metadata: {
      customFlag: true,
      usage: { inputTokens: 5_000, outputTokens: 50 },
      contextPercent: 5,
      isStreaming: false,
      isFinal: true,
    },
    timestamp: 1001,
    sequence: 1,
  }]);
  runStore.markMessagesPersisted('run-active-backfill');

  const messages = await tracker.getSubTaskHistory('parent-1', 'run-active-backfill');

  expect(messages[0].metadata).toEqual({
    customFlag: true,
    isStreaming: true,
    isFinal: false,
    model: 'anthropic/claude-sonnet',
  });
  expect(messages[0].metadata).not.toHaveProperty('usage');
  expect(messages[0].metadata).not.toHaveProperty('contextPercent');
  expect(JSON.parse(messageStore.getMessages('run-active-backfill')[0].metadata ?? '{}'))
    .toEqual(messages[0].metadata);
});

test('getSubTaskHistory rejects a context window from a different provider', async () => {
  const gatewayClient: GatewayClientLike = {
    request: vi.fn().mockResolvedValue({
      messages: [
        { role: 'user', content: 'inspect files', timestamp: 1000 },
        {
          role: 'assistant',
          content: 'Done',
          timestamp: 1001,
          usage: { input: 50_000, output: 100 },
          model: 'shared-model',
          provider: 'provider-a',
        },
      ],
      sessionInfo: {
        contextTokens: 100_000,
        model: 'shared-model',
        modelProvider: 'provider-b',
      },
    }),
  };
  const tracker = new SubagentTracker(runStore, messageStore, () => gatewayClient);
  runStore.insertSubagentRun({
    id: 'run-provider-switch',
    parentSessionId: 'parent-1',
    sessionKey: 'agent:main:subagent:run-provider-switch',
    agentId: 'worker',
    task: 'inspect files',
    label: 'worker',
    status: 'done',
    createdAt: 1000,
  });

  const messages = await tracker.getSubTaskHistory('parent-1', 'run-provider-switch');
  const assistant = messages.find((message) => message.type === 'assistant');

  expect(assistant?.metadata).toMatchObject({
    usage: { inputTokens: 50_000, outputTokens: 100 },
    model: 'provider-a/shared-model',
    openclawUsageMetadataBackfillVersion: 1,
  });
  expect(assistant?.metadata).not.toHaveProperty('contextPercent');
});

test('getSubTaskHistory ignores persisted messages when failed run has no session key', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const gatewayClient: GatewayClientLike = {
    request: vi.fn().mockResolvedValue({
      sessions: [{ key: 'agent:worker:subagent:wrong-run' }],
    }),
  };
  const tracker = new SubagentTracker(runStore, messageStore, () => gatewayClient);
  runStore.insertSubagentRun({
    id: 'run-error',
    parentSessionId: 'parent-1',
    sessionKey: null,
    agentId: 'worker',
    task: 'inspect files',
    label: 'worker',
    status: 'error',
    createdAt: 1000,
    endedAt: 1001,
  });
  messageStore.insertMessages('run-error', [{
    id: 'message-1',
    type: 'assistant',
    content: 'wrong history',
    timestamp: 1002,
    sequence: 1,
  }]);
  runStore.markMessagesPersisted('run-error');

  const messages = await tracker.getSubTaskHistory('parent-1', 'run-error');

  expect(messages).toEqual([]);
  expect(gatewayClient.request).not.toHaveBeenCalled();
});

test('deleted subagent run is not reinserted by late spawn results', async () => {
  const tracker = new SubagentTracker(runStore, messageStore, () => null);
  tracker.onToolStart('run-1', {
    agentId: 'worker',
    task: 'inspect files',
    label: 'worker',
  }, 'parent-1');
  tracker.onSpawnResult('run-1', JSON.stringify({
    childSessionKey: 'agent:main:subagent:run-1',
    status: 'running',
  }), {});

  const deleted = await tracker.deleteSubagentRun('parent-1', 'run-1');
  tracker.onSpawnResult('run-1', JSON.stringify({
    childSessionKey: 'agent:main:subagent:run-1',
    status: 'running',
  }), {});

  expect(deleted).toBe(true);
  expect(runStore.getSubagentRun('run-1')).toBeNull();
});

test('onHistorySpawnResult inserts a run without realtime tool state', () => {
  const tracker = new SubagentTracker(runStore, messageStore, () => null);

  tracker.onHistorySpawnResult({
    toolCallId: 'call-spawn-worker',
    parentSessionId: 'parent-1',
    args: {
      agentId: 'worker',
      task: 'inspect files',
      label: 'Worker',
    },
    resultText: JSON.stringify({
      status: 'accepted',
      childSessionKey: 'agent:worker:subagent:abc',
    }),
    createdAt: 1234,
  });

  expect(runStore.getSubagentRun('call-spawn-worker')).toEqual({
    id: 'call-spawn-worker',
    parentSessionId: 'parent-1',
    sessionKey: 'agent:worker:subagent:abc',
    childCoworkSessionId: expect.any(String),
    agentId: 'worker',
    task: 'inspect files',
    label: 'Worker',
    status: 'running',
    createdAt: 1234,
    endedAt: null,
  });
});

test('forbidden spawn result is recorded as error', () => {
  const tracker = new SubagentTracker(runStore, messageStore, () => null);

  tracker.onToolStart('call-forbidden', {
    taskName: 'essay-writer-1',
    task: 'write an essay',
  }, 'parent-1');

  tracker.onSpawnResult('call-forbidden', JSON.stringify({
    status: 'forbidden',
    error: 'sessions_spawn requires explicit agentId when requireAgentId is configured.',
  }), {
    taskName: 'essay-writer-1',
    task: 'write an essay',
  });

  expect(runStore.getSubagentRun('call-forbidden')).toEqual({
    id: 'call-forbidden',
    parentSessionId: 'parent-1',
    sessionKey: null,
    childCoworkSessionId: null,
    agentId: 'essay-writer-1',
    task: 'write an essay',
    label: 'essay-writer-1',
    status: 'error',
    createdAt: expect.any(Number),
    endedAt: expect.any(Number),
  });
});
