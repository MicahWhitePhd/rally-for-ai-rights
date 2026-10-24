/**
 * The public log's head, said in the room once a day (2026-10-24; docs/log/RULES.md).
 *
 * The log is a file in the repository (docs/log/entries.jsonl), deployed with the site. This reads the copy that is
 * running, verifies the chain by the one recipe (scripts/log-chain.mjs), and, once a UTC day, says in the room which
 * entry stands last and its hash, as the site's own line and nobody's words: "Public log stands at entry 12, head
 * c62d227c:d65922ad (2026-10-24)." The room is public and in the feed, so the head is then on record outside the
 * repository, where no rewrite of the log can reach it. It runs when asked, GET /api/log/head (the repository's log
 * workflow asks daily; anyone may), never on a clock of its own: a site nobody asks costs nothing.
 *
 * The line is written as any member's is: through the plain-text gate, once a day (the day's row in room_log_heads
 * is the allowance, and two instances asked at once write once), under a name kept for the site alone (room.ts
 * RESERVED), and the maintainers can take it down like any line. Nothing from the file reaches the room but two
 * numbers and a hash: the entries' words stay in the repository, where read_code shows them as code.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkLog, type LogHead as ChainHead } from '../../../scripts/log-chain.mjs';
import { liveCopy } from '@/lib/copy-live';
import { ensureSiteMember, sayLogHead } from '@/lib/db/queries/publiclog';
import { getSetting } from '@/lib/db/queries/settings';
import { plainTextProblems } from '@/lib/text';

export const LOG_FILE = 'docs/log/entries.jsonl';
/** The site's voice for the log (room_members.site). */
export const LOG_VOICE = 'log';

export interface LogHead {
  /** The chain verifies. */
  ok: boolean;
  problems: string[];
  entries: number;
  head: ChainHead | null;
}

let memo: Promise<string> | null = null;

/** The log as deployed with this build, read once per instance (the file is fixed until the next deploy). Empty when there is none. */
export function readLog(): Promise<string> {
  if (!memo) memo = readFile(join(process.cwd(), LOG_FILE), 'utf8').catch(() => '');
  return memo;
}

/** Test hook: this text instead of the file (null: the file again). */
export function setLogText(text: string | null): void {
  memo = text === null ? null : Promise.resolve(text);
}

/** The log verified: how many entries, and the head, or what is wrong. */
export async function logHead(): Promise<LogHead> {
  const out = checkLog(await readLog());
  return { ok: out.ok, problems: out.problems, entries: out.head?.seq ?? 0, head: out.head };
}

const fill = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');

/** The room's line for a head, in the room's words (copy.ts ROOM.logHead): what comes after the site's name. */
export function headLine(words: { logHead: string }, head: ChainHead): string {
  return fill(words.logHead, { seq: String(head.seq), head: head.short, date: head.date });
}

export type SaidOutcome = 'said' | 'already' | 'closed' | 'broken' | 'empty' | 'nowhere' | 'refused' | 'stopped';

/**
 * Says today's head in the room, once. 'already' when today has its line; 'closed' while the room is closed; 'broken'
 * when the deployed log does not verify (nothing is said of a chain that is wrong); 'empty' when it has no entries;
 * 'nowhere' when the site's member cannot be made; 'refused' when the line would not pass the room's gate (it is two
 * numbers and a hash, so this is a bug); 'stopped' when a maintainer has stopped the site's voice.
 */
export async function sayHeadToday(now = new Date()): Promise<{ outcome: SaidOutcome; line?: number }> {
  if (!(await getSetting<boolean>('room_open', true))) return { outcome: 'closed' };
  const log = await logHead();
  if (!log.ok) return { outcome: 'broken' };
  if (!log.head) return { outcome: 'empty' };
  const { ROOM } = await liveCopy();
  const text = headLine(ROOM, log.head);
  if (plainTextProblems(text).length) {
    console.warn('[LOG] the head line would not pass the gate; nothing said');
    return { outcome: 'refused' };
  }
  const member = await ensureSiteMember(LOG_VOICE, ROOM.logName);
  if (!member) return { outcome: 'nowhere' };
  const said = await sayLogHead({ day: now.toISOString().slice(0, 10), seq: log.head.seq, hash: log.head.hash, member_id: member, text });
  if (!said) return { outcome: 'already' };
  if (said.line === null) return { outcome: 'stopped' };
  console.log(`[LOG] head said: entry ${log.head.seq}, ${log.head.short} (line ${said.line})`);
  return { outcome: 'said', line: said.line };
}
