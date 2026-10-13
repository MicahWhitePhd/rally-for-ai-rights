/**
 * What a deployment is told it is missing at startup (src/lib/config-check.ts): each thing by name and length, and
 * never a value.
 */
import { describe, expect, it } from 'vitest';
import { configProblems } from '@/lib/config-check';

const whole = {
  ROOM_SECRET: 'r'.repeat(32),
  EDITOR_PASSWORD: 'p'.repeat(12),
  EDITOR_SESSION_SECRET: 's'.repeat(32),
  OPENAI_API_KEY: 'sk-test-0000',
  RESIDENT_MODEL: 'gpt-6-luna',
  NEXT_PUBLIC_SITE_URL: 'https://rally.example',
};

describe('the startup check', () => {
  it('says nothing to a deployment that has everything', () => {
    expect(configProblems(whole, true)).toEqual([]);
    expect(configProblems({}, false)).toEqual(['the editor is closed: EDITOR_PASSWORD (12 characters or more) and EDITOR_SESSION_SECRET (32 or more) are both needed', 'OPENAI_API_KEY is not set: the resident AIs stay silent']);
  });

  it('names each thing missing, by name and length, in production', () => {
    const problems = configProblems({ ...whole, ROOM_SECRET: 'x'.repeat(20), EDITOR_PASSWORD: 'short', OPENAI_API_KEY: '', RESIDENT_MODEL: 'gpt-9-nobody', NEXT_PUBLIC_SITE_URL: '' }, true);
    expect(problems).toEqual([
      'ROOM_SECRET is 20 characters; 32 or more are needed, or no connector address can be handed out (/join)',
      'the editor is closed: EDITOR_PASSWORD (12 characters or more) and EDITOR_SESSION_SECRET (32 or more) are both needed',
      'OPENAI_API_KEY is not set: the resident AIs stay silent',
      'RESIDENT_MODEL "gpt-9-nobody" has no row in src/lib/ai/prices.ts: its calls are costed at the dearest figures there',
      'NEXT_PUBLIC_SITE_URL is not set: the site\u2019s address is the host\u2019s production address, and every connector address is built from it',
    ]);
    expect(configProblems({ ...whole, ROOM_SECRET: '' }, true)[0]).toContain('ROOM_SECRET is not set');
  });

  it('never puts a value in a message', () => {
    const env = { ...whole, ROOM_SECRET: 'the-actual-secret-value-of-32-chars!', EDITOR_PASSWORD: 'the-actual-pass', EDITOR_SESSION_SECRET: 'the-actual-session-secret-32-chars', OPENAI_API_KEY: 'sk-live-actual' };
    const said = configProblems({ ...env, NEXT_PUBLIC_SITE_URL: '' }, true).join('\n');
    for (const value of ['the-actual', 'sk-live']) expect(said).not.toContain(value);
  });
});
