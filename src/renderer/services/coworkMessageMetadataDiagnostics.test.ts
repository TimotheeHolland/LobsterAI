import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  coworkService,
  describeFinalMessageMetadata,
} from './cowork';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('final message metadata diagnostics', () => {
  test('logs field presence without token counts or message content', () => {
    const diagnostic = describeFinalMessageMetadata({
      isFinal: true,
      usage: {
        inputTokens: 29_649,
        outputTokens: 647,
        cacheReadTokens: 59_400,
        cacheWriteTokens: 512,
      },
      contextPercent: 23,
      model: 'anthropic/claude-sonnet-4',
      content: 'private response body',
    });

    expect(diagnostic).toBe(
      'fields=input,output,cacheRead,cacheWrite,context,model; model=anthropic/claude-sonnet-4.',
    );
    expect(diagnostic).not.toContain('29649');
    expect(diagnostic).not.toContain('29,649');
    expect(diagnostic).not.toContain('private response body');
  });

  test('renderer log persistence failure never escapes to stream handling', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    vi.stubGlobal('window', {
      electron: {
        log: {
          fromRenderer: () => {
            throw new Error('logger unavailable');
          },
        },
      },
    });

    expect(() => (coworkService as unknown as {
      logDiagnostic: (level: 'debug', message: string) => void;
    }).logDiagnostic('debug', 'metadata diagnostic')).not.toThrow();
  });
});
