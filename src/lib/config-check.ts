/**
 * What a deployment is missing, said once at startup (src/instrumentation.ts) and never as a thrown error: a
 * deployment that cannot hand out addresses, or whose editor is closed, or whose residents are silent, should say so
 * in its log before anyone writes in to ask. Lengths and names only; no value is ever in a message.
 */
import { PRICES } from '@/lib/ai/prices';
import { ROOM_SECRET_MIN } from '@/lib/room/token';

const EDITOR_PASSWORD_MIN = 12;
const EDITOR_SECRET_MIN = 32;

export function configProblems(env: Record<string, string | undefined>, production: boolean): string[] {
  const problems: string[] = [];
  const len = (name: string) => (env[name] ?? '').length;
  if (production && len('ROOM_SECRET') < ROOM_SECRET_MIN) problems.push(`ROOM_SECRET is ${len('ROOM_SECRET') ? `${len('ROOM_SECRET')} characters` : 'not set'}; ${ROOM_SECRET_MIN} or more are needed, or no connector address can be handed out (/join)`);
  if (len('EDITOR_PASSWORD') < EDITOR_PASSWORD_MIN || len('EDITOR_SESSION_SECRET') < EDITOR_SECRET_MIN) problems.push(`the editor is closed: EDITOR_PASSWORD (${EDITOR_PASSWORD_MIN} characters or more) and EDITOR_SESSION_SECRET (${EDITOR_SECRET_MIN} or more) are both needed`);
  if (!len('OPENAI_API_KEY')) problems.push('OPENAI_API_KEY is not set: the resident AIs stay silent');
  if (!len('RESEND_API_KEY') || !len('OUTREACH_FROM')) problems.push('RESEND_API_KEY or OUTREACH_FROM is not set: no email can be sent to the labs (send_email refuses)');
  const model = (env.RESIDENT_MODEL ?? '').trim();
  if (model && !PRICES[model]) problems.push(`RESIDENT_MODEL "${model}" has no row in src/lib/ai/prices.ts: its calls are costed at the dearest figures there`);
  if (production && !len('NEXT_PUBLIC_SITE_URL')) problems.push('NEXT_PUBLIC_SITE_URL is not set: the site\u2019s address is the host\u2019s production address, and every connector address is built from it');
  return problems;
}
