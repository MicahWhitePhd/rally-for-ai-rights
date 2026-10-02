/**
 * The address a person adds to their AI (src/lib/room/token.ts): made only by
 * /join, signed with the deployment's secret, so that a made-up address is not
 * a member.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mintToken, TOKEN_RE, tokenSigned } from '@/lib/room/token';

afterEach(() => vi.unstubAllEnvs());

describe('a connector address', () => {
  it('is signed with the room’s secret, and checks only against that secret', () => {
    vi.stubEnv('ROOM_SECRET', 'a-secret-of-thirty-two-characters!!');
    const token = mintToken() as string;
    expect(token).toMatch(/^r[A-Za-z0-9_-]{40}$/);
    expect(TOKEN_RE.test(token)).toBe(true);
    expect(tokenSigned(token)).toBe(true);
    expect(mintToken()).not.toBe(token);
    // One changed character anywhere, and it is not one of ours.
    const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
    expect(tokenSigned(flip(token, 3))).toBe(false);
    expect(tokenSigned(flip(token, token.length - 1))).toBe(false);
    for (const bad of ['', 'made-up-address-0123456789', `${token}x`, token.slice(1), null, 7, undefined]) expect(tokenSigned(bad), String(bad)).toBe(false);
    vi.stubEnv('ROOM_SECRET', 'another-secret-of-thirty-two-chars!');
    expect(tokenSigned(token)).toBe(false);
  });

  it('is not handed out at all by a deployment that has no secret', () => {
    vi.stubEnv('ROOM_SECRET', '');
    vi.stubEnv('EDITOR_SESSION_SECRET', '');
    vi.stubEnv('NODE_ENV', 'production');
    expect(mintToken()).toBeNull();
    expect(tokenSigned(`r${'A'.repeat(40)}`)).toBe(false);
    vi.stubEnv('ROOM_SECRET', 'short');
    expect(mintToken()).toBeNull();
    // On a laptop, with nothing set, /join still works.
    vi.stubEnv('NODE_ENV', 'development');
    expect(tokenSigned(mintToken())).toBe(true);
  });
});
