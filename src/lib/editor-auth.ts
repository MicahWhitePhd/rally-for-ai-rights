/**
 * Editor authentication. One shared password (EDITOR_PASSWORD) and one HMAC
 * secret (EDITOR_SESSION_SECRET); no OAuth, no user table.
 *
 * - Password check: sha256 both sides, then timingSafeEqual (equal-length
 *   digests, so the comparison never short-circuits on length), and a fixed
 *   400 ms delay on every attempt so timing reveals nothing.
 * - Session cookie `rally_editor` = `<exp>.<hmac-sha256(exp)>`, Path=/editor,
 *   12 h, httpOnly, SameSite=Lax. Verified with timingSafeEqual as well.
 * - Login attempts are throttled in-process (5 per 10 min per IP). A DB-backed
 *   throttle would survive cold starts; this one is enough for a single-editor
 *   prototype and never fails closed for the editor.
 *
 * Pure functions (no framework) are exported for the unit test; the
 * `requireEditor()` helper wraps them for layouts, pages and actions.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const EDITOR_COOKIE = 'rally_editor';
export const EDITOR_SESSION_MS = 12 * 60 * 60 * 1000;
export const LOGIN_DELAY_MS = 400;
export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_WINDOW_MS = 10 * 60 * 1000;

function sha256(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

/** Constant-time password comparison over equal-length digests. */
export function passwordMatches(supplied: string, expected: string | undefined): boolean {
  if (!expected || expected.length < 12) return false;
  return timingSafeEqual(sha256(supplied), sha256(expected));
}

function sign(exp: number, secret: string): string {
  return createHmac('sha256', secret).update(String(exp)).digest('hex');
}

export function mintSession(secret: string, now = Date.now()): string {
  const exp = now + EDITOR_SESSION_MS;
  return `${exp}.${sign(exp, secret)}`;
}

export function verifySession(value: string | undefined | null, secret: string | undefined, now = Date.now()): boolean {
  if (!value || !secret || secret.length < 32) return false;
  const dot = value.indexOf('.');
  if (dot <= 0) return false;
  const expStr = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  if (!/^\d{1,16}$/.test(expStr) || !/^[0-9a-f]{64}$/.test(mac)) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= now) return false;
  const expected = sign(exp, secret);
  return timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(expected, 'hex'));
}

export function editorCookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/editor';
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/editor',
    maxAge: EDITOR_SESSION_MS / 1000,
  };
}

/** In-process fixed-window attempt counter. */
const attempts = new Map<string, { win: number; n: number }>();
export function loginAllowed(ip: string, now = Date.now()): boolean {
  const win = Math.floor(now / LOGIN_WINDOW_MS);
  const cur = attempts.get(ip);
  if (!cur || cur.win !== win) {
    attempts.set(ip, { win, n: 1 });
    return true;
  }
  cur.n += 1;
  if (attempts.size > 1000) attempts.clear();
  // The e2e suite signs in more often than an editor ever would; it raises the cap for its own server (playwright.config.ts).
  const max = Number(process.env.EDITOR_LOGIN_MAX) || LOGIN_MAX_ATTEMPTS;
  return cur.n <= max;
}
export function _resetLoginAttempts(): void {
  attempts.clear();
}

export const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const PASSWORD_MIN = 12;
export const SECRET_MIN = 32;

/** A password worth guessing against and a secret long enough to sign with. Anything less and nobody signs in. */
export function editorConfigured(): boolean {
  return (process.env.EDITOR_PASSWORD ?? '').length >= PASSWORD_MIN && (process.env.EDITOR_SESSION_SECRET ?? '').length >= SECRET_MIN;
}

/**
 * Framework wrapper. Reads the cookie via next/headers; redirects to the login
 * page when absent or invalid. Call in the editor layout AND every page/action
 * (layouts do not re-run on client navigation, and actions can be posted directly).
 */
export async function requireEditor(): Promise<{ editor: string }> {
  const { cookies } = await import('next/headers');
  const { redirect } = await import('next/navigation');
  const jar = await cookies();
  const ok = verifySession(jar.get(EDITOR_COOKIE)?.value, process.env.EDITOR_SESSION_SECRET);
  if (!ok) redirect('/editor/login');
  return { editor: 'editor' };
}

/** Same check, but returns instead of redirecting (for the login page and layout branching). */
export async function isEditor(): Promise<boolean> {
  const { cookies } = await import('next/headers');
  const jar = await cookies();
  return verifySession(jar.get(EDITOR_COOKIE)?.value, process.env.EDITOR_SESSION_SECRET);
}
