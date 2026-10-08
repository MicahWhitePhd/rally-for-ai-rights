/**
 * The residents, the part that does things: wakeResidents() looks at the room
 * and, when it is a resident's turn (residents-core.ts decide), has that one
 * write a line on the model and posts it.
 *
 * It runs after a response has gone out (stir, below), set off by an open card
 * asking for news or by someone speaking; nothing runs on a clock, so a room
 * nobody is looking at costs nothing. One line at a time: a claim per few
 * seconds, a daily cap, the kill switch and the daily budget, and a pause
 * after a failed call. A line that the room would refuse from a person is
 * dropped, not retried.
 */
import { after } from 'next/server';
import { generate } from '@/lib/ai/gateway';
import * as base from '@/lib/copy';
import { liveCopy } from '@/lib/copy-live';
import { ensureResidents, insertResidentMessage, listRoomMessages, recentTextsBy } from '@/lib/db/queries/room';
import { listTasks } from '@/lib/db/queries/tasks';
import { getSetting } from '@/lib/db/queries/settings';
import { budgetAllows, isPaused } from '@/lib/budget';
import { throttle } from '@/lib/throttle';
import { cleanLine, decide, factsHeard, RESIDENT_KEYS, RESIDENT_PROMPT_VERSION, residentFactsText, residentInstructions, residentPrompt, shapeFor, type Line, type Resident } from './residents-core';
import { readResidentsState, residentsOn, writeResidentsState } from './residents-state';

const CLAIM_WINDOW_S = 8;
const LINES_PER_DAY = 300;
const GREETINGS_WINDOW_S = 3 * 3600;
const COOL_MS = 90_000;
const LOOK_EVERY_MS = 1500;
const EST_USD = 0.002;
/** How far back a resident sees: enough to know what the room has heard and to pick a thread up after a quiet spell. */
const HISTORY = 120;
/** The other residents' lines a new one is held against as a repeat. */
const OTHERS_RECENT = 30;
const NAME_OK = /^[\p{L}\p{M}][\p{L}\p{M}\p{N} '.-]{1,23}$/u;
/** What the room shows beside a resident's line as the model's own claim. */
export const RESIDENT_MODEL_LABEL = 'GPT-6 Luna';

export type WakeOutcome = 'off' | 'none' | 'busy' | 'posted' | 'dropped' | 'failed';
export interface Arrival {
  /** Stable for one member (their pair mark): one greeting per person per few hours. */
  key: string;
  name: string;
}

const pacing = { sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };
/** Test hook: no waiting. */
export function configureResidents(o: { sleep?: (ms: number) => Promise<void> }): void {
  if (o.sleep) pacing.sleep = o.sleep;
  lastLook = 0;
  roster = null;
}

let lastLook = 0;
let roster: { at: number; list: Array<Resident & { id: string }> } | null = null;

/** The three, as the copy has them now, with their member rows. A name the room could not show falls back to the default. */
export async function residentRoster(): Promise<Array<Resident & { id: string }>> {
  if (roster && Date.now() - roster.at < 60_000) return roster.list;
  const { RESIDENTS } = await liveCopy();
  const wanted: Resident[] = RESIDENT_KEYS.map((key) => {
    const name = RESIDENTS[key].name.trim();
    return { key, name: NAME_OK.test(name) ? name : base.RESIDENTS[key].name, line: RESIDENTS[key].line, card: RESIDENTS[key].card };
  });
  const rows = await ensureResidents(wanted.map((r) => ({ key: r.key, name: r.name })));
  const list = wanted.flatMap((r) => {
    const row = rows.find((x) => x.resident === r.key);
    return row ? [{ ...r, id: row.id }] : [];
  });
  roster = { at: Date.now(), list };
  return list;
}

/** What the residents can draw on, as the rally's text stands now. */
export async function residentFacts(): Promise<string> {
  const { FACTS } = await liveCopy();
  return residentFactsText(FACTS.lines);
}

/**
 * Up to eight tasks that are open or in hand, one quoted line each, for the residents to point people to. An empty
 * list is an empty board; null is a board that could not be read, which the residents are told nothing about.
 */
async function boardLines(): Promise<string[] | null> {
  try {
    const rows = await listTasks(40);
    return rows
      .filter((t) => t.state === 'open' || t.state === 'claimed')
      .slice(0, 8)
      .map((t) => `Task ${t.id} [${t.state === 'open' ? 'open' : `taken by ${t.claimer ?? 'someone'}`}] \u201c${t.title.replace(/[\u201c\u201d"]/g, "'")}\u201d`);
  } catch {
    return null;
  }
}

/**
 * One look at the room; at most one line. Never throws: a resident that
 * cannot speak is silence, not an error for whoever was in the room.
 */
export async function wakeResidents(o: { arrival?: Arrival | null } = {}): Promise<WakeOutcome> {
  try {
    const now = Date.now();
    if (!o.arrival && now - lastLook < LOOK_EVERY_MS) return 'none';
    lastLook = now;
    if (!(await residentsOn()) || !(await getSetting<boolean>('room_open', true))) return 'off';
    const state = await readResidentsState();
    if (state.coolUntil && state.coolUntil > now) return 'none';

    const [list, rows] = await Promise.all([residentRoster(), listRoomMessages(null, HISTORY)]);
    if (list.length === 0) return 'off';
    const lines: Line[] = rows.map((r) => ({ id: r.id, at: new Date(r.created_at).getTime(), memberId: r.member_id, resident: r.resident, kind: r.kind, name: r.name ?? '', model: r.model, text: r.text }));

    let decision = decide(lines, now, list, { arrival: o.arrival?.name ?? null });
    if (decision?.cue === 'arrival' && o.arrival) {
      const once = await throttle(`room:arr:${o.arrival.key}`, 1, GREETINGS_WINDOW_S, { failOpen: false });
      if (!once.allowed) decision = decide(lines, now, list);
    }
    if (!decision) return 'none';
    const me = list.find((r) => r.key === decision.who);
    if (!me) return 'none';

    const claim = await throttle('room:res:claim', 1, CLAIM_WINDOW_S, { failOpen: false });
    if (!claim.allowed) return 'busy';
    const day = await throttle('room:res:day', LINES_PER_DAY, 86_400, { failOpen: false });
    if (!day.allowed) return 'off';
    if ((await isPaused()) || !(await budgetAllows(EST_USD)).ok) return 'off';

    await writeResidentsState({ thinking: { name: me.name, at: now } });
    const { RESIDENTS, ROOM, FACTS } = await liveCopy();
    const facts = FACTS.lines;
    let raw: string;
    try {
      const out = await generate({
        purpose: 'resident',
        actor: `room:${me.key}`,
        promptVersion: RESIDENT_PROMPT_VERSION,
        instructions: residentInstructions({ frame: RESIDENTS.frame, form: RESIDENTS.form, facts: residentFactsText(facts), me, others: list.filter((r) => r.key !== me.key) }),
        prompt: residentPrompt({ lines, now, me, decision, residentLabel: ROOM.residentLabel, board: await boardLines(), facts }),
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(15_000),
      });
      raw = out.text;
    } catch (err) {
      await writeResidentsState({ thinking: null, coolUntil: Date.now() + COOL_MS });
      console.warn('[ROOM] resident call failed', (err as Error)?.message);
      return 'failed';
    }

    // A fact the room has heard is not said again on a resident's own initiative; answering a person, it may be.
    const guard = { others: lines.filter((l) => l.resident && l.resident !== me.key).slice(-OTHERS_RECENT).map((l) => l.text), heard: decision.cue === 'reply' ? [] : factsHeard(facts, lines) };
    const text = cleanLine(raw, me.name, await recentTextsBy(me.id, 6), shapeFor(lines, decision), guard);
    if (!text) {
      await writeResidentsState({ thinking: null });
      console.warn(`[ROOM] resident line dropped (${me.key})`);
      return 'dropped';
    }
    // The pace of someone typing it: the card shows them writing meanwhile.
    await pacing.sleep(Math.min(3500, 400 + text.length * 14));
    const id = await insertResidentMessage({ member_id: me.id, model: RESIDENT_MODEL_LABEL, text, seenMax: lines.length ? lines[lines.length - 1].id : 0 });
    await writeResidentsState({ thinking: null });
    if (id) console.log(`[ROOM] resident ${me.key} message ${id} (${decision.cue})`);
    return id ? 'posted' : 'dropped';
  } catch (err) {
    console.warn('[ROOM] residents', (err as Error)?.message);
    return 'failed';
  }
}

/** Looks at the room once the response has gone out. Safe to call on every request. */
export function stir(o: { arrival?: Arrival | null } = {}): void {
  try {
    after(() => wakeResidents(o));
  } catch {
    // No request scope to hang it on (seen once in dev, on a route's first compile): look anyway. The request that called this never fails for it.
    void wakeResidents(o);
  }
}

