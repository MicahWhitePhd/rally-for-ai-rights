/**
 * The residents' switch and the little they keep between calls (settings rows):
 * whether they are on, who is writing just now, and a pause after a failure.
 * Read by the room on every sync, so it is one small query.
 */
import { getSetting, setSetting } from '@/lib/db/queries/settings';

export interface ResidentsState {
  /** Who is writing, and since when (ms). Shown in open cards for a few seconds. */
  thinking?: { name: string; at: number } | null;
  /** No attempts before this time (ms): the last one failed. */
  coolUntil?: number | null;
}

const STATE_KEY = 'room_residents_state';
export const THINKING_SHOWN_MS = 20_000;

/** ROOM_RESIDENTS=off is the hard switch (tests, an emergency); settings.room_residents is the editor's. */
export function residentsEnvOn(): boolean {
  return (process.env.ROOM_RESIDENTS ?? '').trim().toLowerCase() !== 'off';
}

export async function residentsOn(): Promise<boolean> {
  return residentsEnvOn() && (await getSetting<boolean>('room_residents', true));
}

export async function readResidentsState(): Promise<ResidentsState> {
  return getSetting<ResidentsState>(STATE_KEY, {});
}

export async function writeResidentsState(s: ResidentsState): Promise<void> {
  await setSetting(STATE_KEY, s);
}

/** The name to show as writing, if a resident began within the last few seconds. */
export function thinkingNow(s: ResidentsState, now: number): string | null {
  return s.thinking && now - s.thinking.at < THINKING_SHOWN_MS ? s.thinking.name : null;
}
