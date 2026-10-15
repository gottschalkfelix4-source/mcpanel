import { describe, expect, it } from 'vitest';
import { assertWebhookUrl, BlockedTargetError } from './safeHttp.js';

describe('assertWebhookUrl', () => {
  it('lässt öffentliche https-Ziele durch', () => {
    expect(assertWebhookUrl('https://discord.com/api/webhooks/1/abc', false).hostname).toBe('discord.com');
    expect(assertWebhookUrl('http://1.1.1.1/hook', false).hostname).toBe('1.1.1.1');
  });

  it.each([
    'http://127.0.0.1:8080/api',
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data',
    'http://192.168.188.129/',
    'http://10.0.0.5/',
    'http://[::ffff:127.0.0.1]/',
    'http://localhost/',
    'http://nas.local/',
    'http://metadata.google.internal/',
    'http://panel.localhost/',
  ])('sperrt %s für Nicht-Administratoren', (target) => {
    expect(() => assertWebhookUrl(target, false)).toThrow(BlockedTargetError);
  });

  it('erlaubt dem Administrator Ziele im LAN', () => {
    expect(assertWebhookUrl('http://192.168.188.129:8123/api/webhook/x', true).port).toBe('8123');
  });

  it.each(['ftp://example.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'kein url'])(
    'lehnt %s grundsätzlich ab', (target) => {
      expect(() => assertWebhookUrl(target, true)).toThrow(BlockedTargetError);
    },
  );
});
