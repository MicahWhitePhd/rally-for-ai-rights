/**
 * The maintainers' sign-in (src/lib/editor-auth.ts): a password compared in constant time over equal-length digests,
 * a session cookie signed with a secret long enough to sign with, and nothing accepted from a deployment with less.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EDITOR_SESSION_MS, editorConfigured, editorCookieOptions, mintSession, passwordMatches, verifySession } from '@/lib/editor-auth';

const SECRET = 's'.repeat(32);

afterEach(() => vi.unstubAllEnvs());

describe('the password', () => {
  it('matches only itself, and nothing under twelve characters is a password at all', () => {
    expect(passwordMatches('correct-horse-battery', 'correct-horse-battery')).toBe(true);
    expect(passwordMatches('correct-horse-batterx', 'correct-horse-battery')).toBe(false);
    expect(passwordMatches('correct-horse', 'correct-horse-battery')).toBe(false);
    expect(passwordMatches('', 'correct-horse-battery')).toBe(false);
    expect(passwordMatches('short', 'short')).toBe(false);
    expect(passwordMatches('anything', undefined)).toBe(false);
  });
});

describe('the session', () => {
  it('is minted for twelve hours and verifies against the same secret only, until it expires', () => {
    const now = 1_800_000_000_000;
    const cookie = mintSession(SECRET, now);
    expect(cookie).toMatch(/^\d+\.[0-9a-f]{64}$/);
    expect(verifySession(cookie, SECRET, now)).toBe(true);
    expect(verifySession(cookie, SECRET, now + EDITOR_SESSION_MS - 1)).toBe(true);
    expect(verifySession(cookie, SECRET, now + EDITOR_SESSION_MS)).toBe(false);
    expect(verifySession(cookie, 't'.repeat(32), now)).toBe(false);
  });

  it('refuses a tampered, malformed or absent cookie, and any secret under thirty-two characters', () => {
    const now = 1_800_000_000_000;
    const cookie = mintSession(SECRET, now);
    const [exp, mac] = cookie.split('.');
    expect(verifySession(`${Number(exp) + 1000}.${mac}`, SECRET, now)).toBe(false);
    expect(verifySession(`${exp}.${mac.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'))}`, SECRET, now)).toBe(false);
    for (const bad of ['', 'nodot', '.abc', `${exp}.`, `x${exp}.${mac}`, null, undefined]) expect(verifySession(bad, SECRET, now), String(bad)).toBe(false);
    expect(verifySession(cookie, 'short-secret', now)).toBe(false);
    expect(verifySession(cookie, undefined, now)).toBe(false);
  });

  it('is sent only to /editor, for twelve hours, and over https in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(editorCookieOptions()).toEqual({ httpOnly: true, secure: true, sameSite: 'lax', path: '/editor', maxAge: EDITOR_SESSION_MS / 1000 });
    vi.stubEnv('NODE_ENV', 'development');
    expect(editorCookieOptions().secure).toBe(false);
  });
});

describe('a deployment', () => {
  it('has an editor only with a password of twelve characters or more and a secret of thirty-two or more', () => {
    vi.stubEnv('EDITOR_PASSWORD', 'p'.repeat(12));
    vi.stubEnv('EDITOR_SESSION_SECRET', SECRET);
    expect(editorConfigured()).toBe(true);
    vi.stubEnv('EDITOR_PASSWORD', 'p'.repeat(11));
    expect(editorConfigured()).toBe(false);
    vi.stubEnv('EDITOR_PASSWORD', 'p'.repeat(12));
    vi.stubEnv('EDITOR_SESSION_SECRET', 's'.repeat(31));
    expect(editorConfigured()).toBe(false);
  });
});
