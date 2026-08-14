import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';

import type { CoworkMessage, CoworkMessageMetadata } from '../../types/cowork';
import AssistantMessageItem from './AssistantMessageItem';

const renderAssistantMessage = (
  content: string,
  metadata: CoworkMessageMetadata,
  showCopyButton = true,
): string => {
  const message: CoworkMessage = {
    id: 'assistant-1',
    type: 'assistant',
    content,
    timestamp: Date.UTC(2026, 7, 14, 3, 4, 5),
    metadata,
  };
  return renderToStaticMarkup(React.createElement(AssistantMessageItem, {
    message,
    showCopyButton,
    turnMetadata: metadata,
  }));
};

test('renders the complete usage footer once and in the intended order', () => {
  const html = renderAssistantMessage('Answer', {
    isFinal: true,
    isStreaming: false,
    usage: {
      inputTokens: 29_600,
      outputTokens: 647,
      cacheReadTokens: 59_400,
    },
    contextPercent: 23,
    model: 'moonshot/kimi-k2.5',
    agentName: 'main',
  });

  expect(html.match(/data-cowork-message-footer="true"/g)).toHaveLength(1);
  expect(html).toMatch(/↑29\.6k[\s\S]*↓647[\s\S]*R59\.4k[\s\S]*23% ctx[\s\S]*kimi-k2\.5/);
  expect(html).toContain('title="输入 Token：29,600"');
  expect(html).toContain('输入 Token：29,600');
  expect(html).toContain('opacity-100');
  expect(html).toContain('min-w-0 max-w-full flex-wrap');
  expect(html).toContain('class="min-w-0 max-w-full truncate" title="kimi-k2.5"');
  expect(html).not.toContain('>main<');
});

test('removes only the canonical provider prefix from a nested model id', () => {
  const html = renderAssistantMessage('Answer', {
    isFinal: true,
    model: 'openrouter/google/gemini-2.5-flash',
  });

  expect(html).toContain('title="google/gemini-2.5-flash"');
  expect(html).toContain('>google/gemini-2.5-flash<');
  expect(html).not.toContain('>openrouter/google/gemini-2.5-flash<');
});

test('keeps zero input and output but hides a zero cache read', () => {
  const html = renderAssistantMessage('Answer', {
    isFinal: true,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
  });

  expect(html).toContain('↑0');
  expect(html).toContain('↓0');
  expect(html).not.toContain('R0');
});

test('does not render the footer when the current streaming turn disables actions', () => {
  const html = renderAssistantMessage('Partial answer', {
    isStreaming: true,
    usage: { inputTokens: 12_000, outputTokens: 300 },
  }, false);

  expect(html).not.toContain('data-cowork-message-footer="true"');
  expect(html).not.toContain('↑12k');
});

test('renders one footer for a plan-only assistant message', () => {
  const html = renderAssistantMessage(
    '<proposed_plan>\n## Summary\n\nImplement the change.\n</proposed_plan>',
    {
      isFinal: true,
      usage: { inputTokens: 12_000, outputTokens: 300 },
      contextPercent: 10,
    },
  );

  expect(html.match(/data-cowork-message-footer="true"/g)).toHaveLength(1);
  expect(html.match(/↑12k/g)).toHaveLength(1);
});

test('renders one footer after all content for a mixed text and plan reply', () => {
  const html = renderAssistantMessage(
    'Intro\n\n<proposed_plan>\n## Summary\n\nImplement the change.\n</proposed_plan>',
    {
      isFinal: true,
      usage: { inputTokens: 12_000, outputTokens: 300 },
      contextPercent: 10,
    },
  );

  const planIndex = html.indexOf('Implement the change.');
  const footerIndex = html.indexOf('data-cowork-message-footer="true"');
  expect(html.match(/data-cowork-message-footer="true"/g)).toHaveLength(1);
  expect(planIndex).toBeGreaterThan(-1);
  expect(footerIndex).toBeGreaterThan(planIndex);
});
