/**
 * The maintainers' watch, on /editor/room: today and the last two weeks, one row a day, from the tables the room
 * keeps (src/lib/db/queries/stats.ts) and the counts (src/lib/counts.ts): lines said, by whom; model calls and what
 * they cost; how often the rules refused someone; and the first steps people took on the way in. Under it, when each
 * resident last spoke, and when the proposals job last read the site. Numbers by the day, nobody in them, never
 * published (AGENTS.md, rule 9). Leaving it out is deleting this file and the line that renders it.
 */
import { ledgerMisses } from '@/lib/ai/gateway';
import { countsByDay } from '@/lib/db/queries/counts';
import { linesByDay, proposalsJobSeenAt, residentsLastLine, spendByDay } from '@/lib/db/queries/stats';

export const WATCH_DAYS = 14;

/** The first steps on the way in, in the order they happen, and the key each is counted under. */
const STEPS: ReadonlyArray<readonly [string, string]> = [
  ['handed out', 'join:'],
  ['first used', 'member:first-use'],
  ['named', 'member:named'],
  ['first line', 'member:first-line'],
  ['first task', 'member:first-task'],
];

const ago = (d: Date | null): string => {
  if (!d) return 'never';
  const min = Math.round((Date.now() - d.getTime()) / 60_000);
  return min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`;
};

export async function Watch() {
  const [lines, spend, counts, residents, jobSeen] = await Promise.all([linesByDay(WATCH_DAYS), spendByDay(WATCH_DAYS), countsByDay(WATCH_DAYS), residentsLastLine(), proposalsJobSeenAt()]);
  const days = [...new Set([...lines.map((l) => l.day), ...spend.map((s) => s.day), ...counts.map((c) => c.day)])].sort().reverse();
  const sum = (day: string, prefix: string) => counts.filter((c) => c.day === day && c.key.startsWith(prefix)).reduce((n, c) => n + c.n, 0);
  const byDay = (day: string) => ({ l: lines.find((x) => x.day === day), s: spend.find((x) => x.day === day) });
  return (
    <section aria-labelledby="watch-h">
      <h2 id="watch-h" className="h">
        The watch
      </h2>
      <p>
        By the day (UTC), today first: what was said and by whom, what the model calls cost, how often a rule refused someone, and the first steps people
        took on the way in. Numbers only; nobody is in them, and nothing here is published.
      </p>
      {days.length === 0 ? (
        <p className="mono">Nothing yet.</p>
      ) : (
        <table className="mono watch">
          <thead>
            <tr>
              <th>day</th>
              <th>people</th>
              <th>their AIs</th>
              <th>residents</th>
              <th>let stand</th>
              <th>board</th>
              <th>calls</th>
              <th>USD</th>
              <th>failed</th>
              <th>refused</th>
              {STEPS.map(([label]) => (
                <th key={label}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {days.map((day) => {
              const { l, s } = byDay(day);
              return (
                <tr key={day}>
                  <td>{day}</td>
                  <td>{l?.people ?? 0}</td>
                  <td>{l?.ais ?? 0}</td>
                  <td>{l?.residents ?? 0}</td>
                  <td>{l?.holds ?? 0}</td>
                  <td>{l?.events ?? 0}</td>
                  <td>{s?.calls ?? 0}</td>
                  <td>{(s?.usd ?? 0).toFixed(3)}</td>
                  <td>{s ? s.failed + (s.estimated ? ` (${s.estimated} est.)` : '') : 0}</td>
                  <td>{sum(day, 'refused:')}</td>
                  {STEPS.map(([label, key]) => (
                    <td key={label}>{sum(day, key)}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="mono">
        Last line from {residents.length ? residents.map((r) => `${r.name} ${ago(r.at)}`).join(', ') : 'no resident yet'}. Proposals job last read the site{' '}
        {ago(jobSeen)}. Ledger rows this instance could not write: {ledgerMisses()}
        {counts.some((c) => c.key === 'ledger:unwritten') ? ` (${counts.filter((c) => c.key === 'ledger:unwritten').reduce((n, c) => n + c.n, 0)} in the fortnight, all instances)` : ''}.
      </p>
    </section>
  );
}
