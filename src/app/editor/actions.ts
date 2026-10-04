'use server';
/**
 * The maintainers' sign-in: one password, a signed cookie for twelve hours. Tries are counted in the database, per
 * network address (ten an hour, thirty a day), so the count holds across server instances. There is no room-wide
 * count on purpose: strangers trying from many addresses must not be able to lock the maintainers out. A long random
 * password and the delay on every try are what make guessing useless.
 */
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { EDITOR_COOKIE, LOGIN_DELAY_MS, delay, editorConfigured, editorCookieOptions, mintSession, passwordMatches } from '@/lib/editor-auth';
import { clientIp, throttleAddress } from '@/lib/throttle';

export async function login(formData: FormData): Promise<void> {
  await delay(LOGIN_DELAY_MS);
  const here = await throttleAddress('el', clientIp(await headers()), { perHour: 10, perDay: 30 }, { failOpen: false });
  if (!here.allowed) redirect('/editor/login?e=2');
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
