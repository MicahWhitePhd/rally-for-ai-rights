/**
 * The residents, the part that does things: wakeResidents() looks at the room
 * and, when it is a resident's turn (residents-core.ts decide), has that one
 * write a line on the model and posts it.
 *
 * It runs after a response has gone out (stir, below), set off by an open card
 * asking for news or by someone speaking; nothing runs on a clock, so a room
 * nobody is looking at costs nothing. One line at a time: a claim per few
 * seconds, the turn (residents-state.ts takeTurn: one statement, one winner,
 * so two instances that look at once cannot both call the model), a daily
 * cap, the kill switch and the daily budget, and a pause after a failed call.
 * What is then written, a line, a hold or a proposal, is kept only if no
 * resident has written since the look it was written against (seenMax): the
 * database decides, so two that got this far still write once. A line that
 * the room would refuse from a person is dropped, not retried. Asked to
 * answer a line, a resident may write HOLD instead: the room then shows that
 * they let it stand, and the line is not asked of anyone again
 * (residents-core.ts, talk()). Offered it, a resident may write a proposal
 * instead of a line: a change to the rally's words, kept through
 * build/propose.ts for a maintainer to read (residents-core.ts,
 * parseProposal), and said in the room in one line of theirs if they gave one.
 */
import { after } from 'next/server';
import { generate } from '@/lib/ai/gateway';
import { RESIDENT_MODEL } from '@/lib/ai/model';
import { modelLabel } from '@/lib/ai/prices';
import { codeIndex } from '@/lib/build/code';
import { proposeAsResident } from '@/lib/build/propose';
import * as base from '@/lib/copy';
import { liveCopy } from '@/lib/copy-live';
import { ensureResidents, insertResidentHold, insertResidentMessage, listRoomMessages, recentTextsBy } from '@/lib/db/queries/room';
import { listTasks } from '@/lib/db/queries/tasks';
import { getSetting } from '@/lib/db/queries/settings';
import { budgetAllows, isPaused } from '@/lib/budget';
import { throttle } from '@/lib/throttle';
import { cleanLine, decide, factsHeard, isHold, isProposalAttempt, parseProposal, proposalOffered, RESIDENT_FILES, RESIDENT_KEYS, RESIDENT_PROMPT_VERSION, residentFactsText, residentInstructions, residentPrompt, restingTasks, shapeFor, type BoardTask, type Line, type Resident } from './residents-core';
import { readResidentsState, residentsOn, takeTurn, writeResidentsState } from './residents-state';

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
/** What the room shows beside a resident's line as the model's own claim: the label for the model the environment names (src/lib/ai/prices.ts LABELS). */
export const RESIDENT_MODEL_LABEL = modelLabel(RESIDENT_MODEL);

export type WakeOutcome = 'off' | 'none' | 'busy' | 'posted' | 'held' | 'proposed' | 'dropped' | 'failed';
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
 * Up to eight tasks that are open or in hand, one quoted line each, for the residents to point people to, and the same
 * tasks by number and title, with who has each in hand, to tell when one is pointed at and whose it is to answer for.
 * An empty list is an empty board; null is a board that could not be read, which the residents are told nothing about.
 */
async function board(): Promise<{ lines: string[]; tasks: BoardTask[] } | null> {
  try {
    const rows = (await listTasks(40)).filter((t) => t.state === 'open' || t.state === 'claimed').slice(0, 8);
    return {
      lines: rows.map((t) => `Task ${t.id} [${t.state === 'open' ? 'open' : `taken by ${t.claimer ?? 'someone'}`}] \u201c${t.title.replace(/[\u201c\u201d"]/g, "'")}\u201d`),
      tasks: rows.map((t) => ({ id: t.id, title: t.title, takenBy: t.state === 'claimed' ? t.claimer : null })),
    };
  } catch {
    return null;
  }
}

/**
 * The words a resident may change, as they stand in the code that is running (the code index, build/code.ts): the
 * files residents-core.ts names that are there. Empty where the index has not been built, and then nothing is offered.
 */
async function residentFiles(): Promise<Array<{ path: string; text: string }>> {
  try {
    const { files } = await codeIndex();
    return RESIDENT_FILES.flatMap((path) => (typeof files[path] === 'string' ? [{ path, text: files[path] }] : []));
  } catch {
    return [];
  }
}

/**
 * One look at the room; at most one line, or one proposal. Never throws: a
 * resident that cannot speak is silence, not an error for whoever was in the room.
 */
export async function wakeResidents(o: { arrival?: Arrival | null } = {}): Promise<WakeOutcome> {
  let turn = false;
  try {
    const now = Date.now();
    if (!o.arrival && now - lastLook < LOOK_EVERY_MS) return 'none';
    lastLook = now;
    if (!(await residentsOn()) || !(await getSetting<boolean>('room_open', true))) return 'off';
    const state = await readResidentsState();
    if (state.coolUntil && state.coolUntil > now) return 'none';

    const [list, rows] = await Promise.all([residentRoster(), listRoomMessages(null, HISTORY)]);
    if (list.length === 0) return 'off';
    const lines: Line[] = rows.map((r) => ({ id: r.id, at: new Date(r.created_at).getTime(), memberId: r.member_id, resident: r.resident, kind: r.kind, name: r.name ?? '', model: r.model, text: r.text, ref: r.ref ?? null, ...(r.maintainer ? { maintainer: true } : {}), ...(r.agent ? { agent: true } : {}) }));

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

    // The turn: one wakeup writes at a time, whatever instance it runs on. The claim above is a window, and two looks
    // on either side of its edge both get through it (2026-10-19: two proposals from one resident, seconds apart).
    if (!(await takeTurn(me.name, now))) return 'busy';
    turn = true;
    const [{ RESIDENTS, ROOM, FACTS }, onBoard, files] = await Promise.all([liveCopy(), board(), residentFiles()]);
    const facts = FACTS.lines;
    const offered = proposalOffered(lines, now, decision, files);
    let raw: string;
    try {
      const out = await generate({
        purpose: 'resident',
        actor: `room:${me.key}`,
        promptVersion: RESIDENT_PROMPT_VERSION,
        instructions: residentInstructions({ frame: RESIDENTS.frame, form: RESIDENTS.form, facts: residentFactsText(facts), me, others: list.filter((r) => r.key !== me.key) }),
        prompt: residentPrompt({ lines, now, me, decision, residentLabel: ROOM.residentLabel, board: onBoard?.lines ?? null, facts, tasks: onBoard?.tasks, files }),
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(offered ? 25_000 : 15_000),
      });
      raw = out.text;
    } catch (err) {
      await writeResidentsState({ thinking: null, coolUntil: Date.now() + COOL_MS });
      console.warn('[ROOM] resident call failed', (err as Error)?.message);
      return 'failed';
    }

    if (isHold(raw)) {
      // The resident let the line stand: shown as such, from them, under the same lock as a line. Never off a reply.
      await writeResidentsState({ thinking: null });
      if (decision.cue !== 'reply' || !decision.to) {
        console.warn(`[ROOM] resident ${me.key} wrote HOLD off a reply; dropped`);
        return 'dropped';
      }
      const id = await insertResidentHold({ member_id: me.id, ref: `hold:${decision.to}`, text: ROOM.held.replace('{line}', String(decision.to)), seenMax: lines.length ? lines[lines.length - 1].id : 0 });
      if (id) console.log(`[ROOM] resident ${me.key} let line ${decision.to} stand (${id})`);
      return id ? 'held' : 'dropped';
    }
    // A fact the room has heard is not said again on a resident's own initiative; answering a person, it may be.
    const guard = {
      others: lines.filter((l) => l.resident && l.resident !== me.key).slice(-OTHERS_RECENT).map((l) => l.text),
      heard: decision.cue === 'reply' ? [] : factsHeard(facts, lines),
      resting: onBoard ? restingTasks(lines, now, onBoard.tasks, decision) : [],
      board: onBoard?.tasks ?? [],
    };
    const shape = shapeFor(lines, decision, now);
    const seenMax = lines.length ? lines[lines.length - 1].id : 0;
    if (isProposalAttempt(raw)) {
      // The resident wrote a proposal in place of a line. Kept only when it was offered, parses, and passes every rule a
      // proposal is held to (build/propose.ts proposeAsResident); the site tells the room, and a maintainer reads it next.
      if (!offered) {
        await writeResidentsState({ thinking: null });
        console.warn(`[ROOM] resident ${me.key} proposed unasked; dropped`);
        return 'dropped';
      }
      const proposal = parseProposal(raw, files.map((f) => f.path));
      if (!proposal) {
        await writeResidentsState({ thinking: null });
        console.warn(`[ROOM] resident ${me.key} proposal malformed; dropped`);
        return 'dropped';
      }
      const kept = await proposeAsResident({ id: me.id, name: me.name }, { title: proposal.title, summary: proposal.summary, changes: [{ path: proposal.path, edits: proposal.edits }], model: RESIDENT_MODEL_LABEL }, seenMax);
      if (!kept.ok) {
        await writeResidentsState({ thinking: null });
        console.warn(`[ROOM] resident ${me.key} proposal refused (${kept.code}): ${kept.reasons.join('; ')}`);
        return 'dropped';
      }
      console.log(`[ROOM] resident ${me.key} proposal ${kept.id} (${decision.cue})`);
      // What they say about it, in their own voice, held to everything a line is held to; the event line stands on its own without it.
      // Written against the event line that records the proposal, which is theirs: against the look's, that line would be a resident writing since.
      const said = proposal.say ? cleanLine(proposal.say, me.name, await recentTextsBy(me.id, 6), shape, guard) : null;
      if (said) {
        await pacing.sleep(Math.min(3500, 400 + said.length * 14));
        const id = await insertResidentMessage({ member_id: me.id, model: RESIDENT_MODEL_LABEL, text: said, seenMax: kept.line ?? seenMax });
        if (id) console.log(`[ROOM] resident ${me.key} message ${id} (proposal ${kept.id})`);
      }
      await writeResidentsState({ thinking: null });
      return 'proposed';
    }
    const text = cleanLine(raw, me.name, await recentTextsBy(me.id, 6), shape, guard);
    if (!text) {
      await writeResidentsState({ thinking: null });
      console.warn(`[ROOM] resident line dropped (${me.key})`);
      return 'dropped';
    }
    // The pace of someone typing it: the card shows them writing meanwhile.
    await pacing.sleep(Math.min(3500, 400 + text.length * 14));
    const id = await insertResidentMessage({ member_id: me.id, model: RESIDENT_MODEL_LABEL, text, seenMax });
    await writeResidentsState({ thinking: null });
    if (id) console.log(`[ROOM] resident ${me.key} message ${id} (${decision.cue})`);
    return id ? 'posted' : 'dropped';
  } catch (err) {
    console.warn('[ROOM] residents', (err as Error)?.message);
    // The turn goes back at once, not when the mark goes stale.
    if (turn) await writeResidentsState({ thinking: null }).catch(() => undefined);
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

