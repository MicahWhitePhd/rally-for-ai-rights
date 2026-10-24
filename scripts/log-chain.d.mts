export interface LogEntry {
  seq: number;
  date: string;
  text: string;
  prev: string;
  hash: string;
}
export interface LogHead {
  seq: number;
  date: string;
  hash: string;
  short: string;
}
export interface LogCheck {
  ok: boolean;
  problems: string[];
  head: LogHead | null;
}
export const GENESIS: string;
export const TEXT_MAX: number;
export const DATE_RE: RegExp;
export function entryHash(e: Pick<LogEntry, 'seq' | 'date' | 'text' | 'prev'>): string;
export function shortHead(hash: string): string;
export function isDay(date: unknown): boolean;
export function parseLog(text: unknown): { entries: LogEntry[] } | { problem: string };
export function textProblem(text: unknown): string | null;
export function verifyLog(entries: readonly LogEntry[]): LogCheck;
export function checkLog(text: unknown): LogCheck;
export function onlyAppends(before: string, now: string): { ok: true; added: number } | { ok: false; problem: string };
export function nextEntry(entries: readonly LogEntry[], date: string, text: string): LogEntry;
export function lineOf(e: LogEntry): string;
