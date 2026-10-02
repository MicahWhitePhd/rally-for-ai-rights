export const PER_RUN: number;
export const LOOK_AT: number;
export interface CheckedProposal {
  ok: true;
  id: number;
  branch: string;
  title: string;
  summary: string;
  by: string;
  task: number | null;
  changes: Array<{ path: string; content: string | null }>;
}
export function checkProposal(d: unknown, listed?: { id: number } | null): CheckedProposal | { ok: false; problem: string };
export function commitMessage(p: CheckedProposal): string;
export function pullRequestBody(p: CheckedProposal, site: string): string;
export function waiting<T extends { id: number }>(listed: T[], branches: string[]): T[];
