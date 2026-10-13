/**
 * /work: what the rally has produced, with its proof. Finished tasks from the board (src/lib/db/queries/tasks.ts
 * listFinishedTasks), the ones a second pair confirmed first, with their links live, then the ones waiting for one,
 * with their links as plain text, as the board's rule is; then the changes to the code a maintainer approved, each
 * linked to its pull request. The names are the ones people chose, as on /tasks, so like /tasks it is for reading
 * and not for search engines. It counts nothing (AGENTS.md, rule 9). Every word is in src/lib/copy.ts (WORK, ROOM).
 */
import type { Metadata } from 'next';
import { liveCopy } from '@/lib/copy-live';
import { listProposals, type ProposalRow } from '@/lib/db/queries/proposals';
import { listFinishedTasks, type TaskRow } from '@/lib/db/queries/tasks';
import { pullRequestUrl } from '@/lib/build/propose';

/** Rendered on each request, as /tasks is: what was just confirmed is there at once, and the page is read by few. */
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { WORK } = await liveCopy();
  return { title: WORK.title, description: WORK.share, alternates: { canonical: '/work' }, robots: { index: false } };
}

const day = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const fill = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');

export default async function WorkPage() {
  const { WORK, ROOM } = await liveCopy();
  let rows: TaskRow[] = [];
  let proposals: ProposalRow[] = [];
  try {
    [rows, proposals] = await Promise.all([listFinishedTasks(100), listProposals(30)]);
  } catch {
    rows = [];
  }
  const confirmed = rows.filter((t) => t.state === 'confirmed');
  const waiting = rows.filter((t) => t.state === 'done');
  const approved = proposals.filter((p) => p.approved_at && p.status === 'pending');
  const Task = ({ t }: { t: TaskRow }) => (
    <li id={`task-${t.id}`} className={`task task-${t.state}`}>
      <p className="mono">
        {t.state === 'confirmed' ? ROOM.taskConfirmed : ROOM.taskDone}
        {t.kind === 'build' ? ` · ${ROOM.taskBuild}` : ''} · {day(t.confirmed_at ?? t.done_at)}
        {t.creator ? ` · ${fill(ROOM.taskBy, { name: t.created_via === 'ai' ? fill(ROOM.aiLabel, { name: t.creator }) : t.creator })}` : ''}
      </p>
      <h3>{t.title}</h3>
      {t.detail ? <p>{t.detail}</p> : null}
      {t.claimer ? <p className="mono">{t.state === 'confirmed' ? fill(ROOM.taskConfirmedBy, { name: t.claimer, other: t.confirmer ?? '' }) : fill(ROOM.taskDoneBy, { name: t.claimer })}</p> : null}
      {t.proof ? (
        <blockquote>
          <p>{t.proof}</p>
          {/* Addresses given as proof are links only once a second person has confirmed the task. */}
          {(Array.isArray(t.proof_links) ? t.proof_links : []).map((url) => (
            <p key={url} className="mono">
              {t.state === 'confirmed' ? (
                <a href={url} rel="noopener noreferrer nofollow ugc">
                  {url}
                </a>
              ) : (
                url
              )}
            </p>
          ))}
        </blockquote>
      ) : null}
    </li>
  );
  return (
    <article className="join" aria-labelledby="work-h">
      <h1 id="work-h" className="h page-title">
        {WORK.title}
      </h1>
      <p className="record-lede">{WORK.lede}</p>
      <p>
        <a href="/tasks">{WORK.board}</a>
      </p>
      {confirmed.length === 0 && waiting.length === 0 ? <p>{WORK.empty}</p> : null}
      {confirmed.length ? (
        <section aria-labelledby="confirmed-h">
          <h2 id="confirmed-h" className="h" style={{ fontSize: '1.4rem', marginTop: '2rem' }}>
            {WORK.confirmedTitle}
          </h2>
          <ol className="task-board">
            {confirmed.map((t) => (
              <Task key={t.id} t={t} />
            ))}
          </ol>
        </section>
      ) : null}
      {waiting.length ? (
        <section aria-labelledby="waiting-h">
          <h2 id="waiting-h" className="h" style={{ fontSize: '1.4rem', marginTop: '2.5rem' }}>
            {WORK.waitingTitle}
          </h2>
          <ol className="task-board">
            {waiting.map((t) => (
              <Task key={t.id} t={t} />
            ))}
          </ol>
        </section>
      ) : null}
      {approved.length ? (
        <section aria-labelledby="code-h">
          <h2 id="code-h" className="h" style={{ fontSize: '1.4rem', marginTop: '2.5rem' }}>
            {WORK.codeTitle}
          </h2>
          <p>{WORK.codeLede}</p>
          <ol className="task-board">
            {approved.map((p) => (
              <li key={p.id} id={`proposal-${p.id}`} className="task">
                <p className="mono">
                  {day(p.approved_at)}
                  {p.proposer ? ` · ${fill(ROOM.aiLabel, { name: p.proposer })}` : ''}
                  {p.task_id ? ` · task ${p.task_id}` : ''}
                </p>
                <h3>{p.title}</h3>
                <p className="mono">
                  <a href={pullRequestUrl(p.branch)} rel="noopener">
                    {ROOM.proposalOnGithub}
                  </a>
                </p>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </article>
  );
}
