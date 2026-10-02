'use server';
/**
 * The maintainers' sign-in: one password, a signed cookie for twelve hours. Tries are counted in the database, so
 * the count holds across server instances: ten an hour from one address, sixty in ten minutes from everywhere.
 */
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { EDITOR_COOKIE, LOGIN_DELAY_MS, delay, editorConfigured, editorCookieOptions, loginAllowed, mintSession, passwordMatches } from '@/lib/editor-auth';
import { addressKey, throttle, throttleAddress } from '@/lib/throttle';

export async function login(formData: FormData): Promise<void> {
  await delay(LOGIN_DELAY_MS);
  const h = await headers();
  const ip = (h.get('x-forwarded-for') ?? h.get('x-real-ip') ?? 'local').split(',')[0]!.trim();
  if (!loginAllowed(ip)) redirect('/editor/login?e=2');
  const everywhere = await throttle('editor:login', 60, 600, { failOpen: false });
  const here = await throttleAddress('el', addressKey(ip), { perHour: 10, perDay: 30 }, { failOpen: false });
  if (!everywhere.allowed || !here.allowed) redirect('/editor/login?e=2');
  const pw = formData.get('password');
  const secret = process.env.EDITOR_SESSION_SECRET;
  if (typeof pw !== 'string' || !secret || !editorConfigured() || !passwordMatches(pw, process.env.EDITOR_PASSWORD)) redirect('/editor/login?e=1');
  (await cookies()).set(EDITOR_COOKIE, mintSession(secret), editorCookieOptions());
  redirect('/editor');
}

export async function logout(): Promise<void> {
  (await cookies()).set(EDITOR_COOKIE, '', { ...editorCookieOptions(), maxAge: 0 });
  redirect('/editor/login');
}
