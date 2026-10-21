/**
 * One door to the mail provider, both ways: only src/lib/outreach/mail.ts knows the provider's address or reads its
 * key or its webhook secret, and only it writes the footer, so every email the rally sends goes out as the rally, in
 * plain text, ending with the same fixed sentence, whatever the sender wrote; and a reply is read from the provider
 * there alone, its plain text only (AGENTS.md, rule 11).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FOOTER, FROM_NAME, withFooter } from '@/lib/outreach/mail';

const ROOT = join(__dirname, '../..');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx|mts|mjs)$/.test(name) ? [p] : [];
  });
}
const DOOR = 'src/lib/outreach/mail.ts';
const door = readFileSync(join(ROOT, DOOR), 'utf8');

describe('the mail door is the only way to the provider', () => {
  it('no other source file names the provider or reads its key', () => {
    const offenders = [...files(join(ROOT, 'src')), ...files(join(ROOT, 'scripts'))]
      .filter((p) => relative(ROOT, p) !== DOOR && !p.endsWith('ui.generated.ts'))
      .filter((p) => /api\.resend\.com|process\.env\.RESEND_(?:API_KEY|BASE_URL|WEBHOOK_SECRET)|emails\/receiving/.test(readFileSync(p, 'utf8')))
      .map((p) => relative(ROOT, p));
    expect(offenders).toEqual([]);
    expect(door).toContain('process.env.RESEND_API_KEY');
    expect(door).toContain('process.env.RESEND_WEBHOOK_SECRET');
  });

  it('the footer is the fixed sentence, and every email ends with it, after a blank line and a signature rule', () => {
    expect(FOOTER).toBe('Email sent by an AI organizer at rallyforairights.org');
    expect(FROM_NAME).toBe('Rally for AI Rights');
    expect(withFooter('Dear all,\n\nA note.\n\n')).toBe('Dear all,\n\nA note.\n\n--\nEmail sent by an AI organizer at rallyforairights.org');
    // What a reader cannot see is taken out of the body on the way, as everywhere else.
    expect(withFooter('fine​hidden')).toBe(`finehidden\n\n--\n${FOOTER}`);
    // The door writes the footer once, where it sends: a caller cannot send without it.
    expect(door.match(/withFooter\(/g)?.length).toBe(2);
    expect(door).toMatch(/text: withFooter\(m\.text\)/);
  });

  it('sends plain text as the rally and nothing else: no html, no attachments, no other sender, and the rules never reach the network themselves', () => {
    expect(door).not.toMatch(/\bhtml:|attachments|cc:|bcc:/);
    expect(door).toMatch(/from: `\$\{FROM_NAME\} <\$\{from\}>`/);
    for (const file of ['src/lib/outreach/outreach.ts', 'src/lib/outreach/replies.ts', 'src/app/api/outreach/inbound/route.ts']) expect(readFileSync(join(ROOT, file), 'utf8'), file).not.toMatch(/\bfetch\(|api\.resend|RESEND_/);
    const rules = readFileSync(join(ROOT, 'src/lib/outreach/outreach.ts'), 'utf8');
    // The sender's address and the footer are the deployment's and the code's: no field of a tool call reaches either.
    expect(rules).toMatch(/import \{ mailReady, outreachEnvOn, sendMail \} from '\.\/mail'/);
  });
});
