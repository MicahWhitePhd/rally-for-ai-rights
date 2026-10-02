/**
 * The address a person adds to their AI is /mcp/<token>. A token is made only
 * by /join, and carries a short keyed signature, so nobody can invent members
 * by typing made-up addresses: every limit in the room is per member, and a
 * member has to have been handed out.
 *
 * Tokens that were in use before signing existed keep working because the
 * room already knows their hash (room.ts openSeat). No plain file here: this
 * is imported by the tests too.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** `r`, 24 characters of randomness, 16 of signature: one unbroken run of the characters an address is made of. */
const SIGNED_RE = /^r([A-Za-z0-9_-]{24})([A-Za-z0-9_-]{16})$/;
/** Any token the room will look at: signed ones, and the older unsigned kind it may already know. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

function secret(): string | null {
  const s = process.env.ROOM_SECRET || process.env.EDITOR_SESSION_SECRET;
  if (s && s.length >= 16) return s;
  // A laptop with no secret set still has a working /join; a deployment must set one.
  return process.env.NODE_ENV === 'production' ? null : 'rally-dev-only-secret';
}

const tag = (body: string, key: string) => createHmac('sha256', key).update(`room-token:${body}`).digest('base64url').slice(0, 16);

/** A new signed token, or null when the deployment has no secret to sign with. */
export function mintToken(): string | null {
  const key = secret();
  if (!key) return null;
  const body = randomBytes(18).toString('base64url');
  return `r${body}${tag(body, key)}`;
}

export function tokenSigned(token: unknown): boolean {
  if (typeof token !== 'string') return false;
  const m = SIGNED_RE.exec(token);
  const key = secret();
  if (!m || !key) return false;
  const want = Buffer.from(tag(m[1], key));
  const got = Buffer.from(m[2]);
  return want.length === got.length && timingSafeEqual(want, got);
}
