import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const { patchWeixin } = require('../scripts/openclaw-plugin-patches/weixin.cjs');
const packageJson = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'),
) as {
  openclaw?: {
    plugins?: Array<{ id?: string; registry?: string; version?: string }>;
  };
};

describe('OpenClaw Weixin plugin patches', () => {
  test('pins a plugin version that validates business-level send failures', () => {
    const plugin = packageJson.openclaw?.plugins?.find(({ id }) => id === 'openclaw-weixin');

    expect(plugin?.version).toBe('2.4.6');
    expect(plugin?.registry).toBe('https://registry.npmjs.org');
  });

  test('classifies source and dist outbound targets as direct messages', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-plugin-patch-'));
    const sourceChannel = path.join(tempDir, 'openclaw-weixin', 'src', 'channel.ts');
    const distChannel = path.join(tempDir, 'openclaw-weixin', 'dist', 'src', 'channel.js');
    fs.mkdirSync(path.dirname(sourceChannel), { recursive: true });
    fs.mkdirSync(path.dirname(distChannel), { recursive: true });
    fs.writeFileSync(
      sourceChannel,
      [
        'export const plugin = {',
        '  messaging: {',
        '    targetResolver: {',
        '      looksLikeId: (raw) => raw.endsWith("@im.wechat"),',
        '    },',
        '  },',
        '};',
      ].join('\n'),
    );
    fs.writeFileSync(
      distChannel,
      [
        'export const plugin = {',
        '    messaging: {',
        '        targetResolver: {',
        '            looksLikeId: (raw) => raw.endsWith("@im.wechat"),',
        '        },',
        '    },',
        '};',
      ].join('\n'),
    );

    try {
      patchWeixin({ runtimeExtensionsDir: tempDir, log: () => {} });
      patchWeixin({ runtimeExtensionsDir: tempDir, log: () => {} });

      for (const channelPath of [sourceChannel, distChannel]) {
        const patched = fs.readFileSync(channelPath, 'utf8');
        expect(patched).toContain('inferTargetChatType: () => "direct"');
        expect(patched.match(/weixin_direct_target_type_patch/g)).toHaveLength(1);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('preserves target inference supplied by a future plugin version', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-plugin-patch-'));
    const sourceChannel = path.join(tempDir, 'openclaw-weixin', 'src', 'channel.ts');
    fs.mkdirSync(path.dirname(sourceChannel), { recursive: true });
    fs.writeFileSync(
      sourceChannel,
      [
        'export const plugin = {',
        '  messaging: {',
        '    inferTargetChatType: ({ to }) => to.startsWith("room:") ? "group" : "direct",',
        '    targetResolver: {',
        '      looksLikeId: (raw) => raw.endsWith("@im.wechat"),',
        '    },',
        '  },',
        '};',
      ].join('\n'),
    );

    try {
      patchWeixin({ runtimeExtensionsDir: tempDir, log: () => {} });

      const patched = fs.readFileSync(sourceChannel, 'utf8');
      expect(patched.match(/inferTargetChatType/g)).toHaveLength(1);
      expect(patched).toContain('to.startsWith("room:") ? "group" : "direct"');
      expect(patched).not.toContain('weixin_direct_target_type_patch');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
