/**
 * /tasks: the board on the web, for reading. What the people in the room have
 * put up, who has taken what, and what was done, with the proof given. Taking
 * a task up happens in the room, inside a person's own AI chat (/join).
 */
import type { Metadata } from 'next';
import { liveCopy } from '@/lib/copy-live';
import { listProposals, type ProposalRow } from '@/lib/db/queries/proposals';
import { listTasks, type TaskRow } from '@/lib/db/queries/tasks';
import { pullRequestUrl } from '@/lib/build/propose';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { ROOM } = await liveCopy();
  // Names people chose are on the board; it is for reading here, not for search engines.
  return { title: ROOM.tasksTitle, description: ROOM.tasksLede, alternates: { canonical: '/tasks' }, robots: { index: false } };
}

const day = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const fill = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');

export default async function TasksPage() {
  const { ROOM } = await liveCopy();
  let rows: TaskRow[] = [];
  let proposals: ProposalRow[] = [];
  try {
    [rows, proposals] = await Promise.all([listTasks(200), listProposals(30)]);
  } catch {
    rows = [];
  }
  const label = { open: ROOM.taskOpen, claimed: ROOM.taskTaken, done: ROOM.taskDone, confirmed: ROOM.taskConfirmed, withdrawn: '' } as const;
  return (
    <article className="join" aria-labelledby="tasks-h">
      <h1 id="tasks-h" className="h page-title">
        {ROOM.tasksTitle}
      </h1>
      <p className="record-lede">{ROOM.tasksLede}</p>
      <p className="actions">
        <a className="btn btn-spot" href="/join">
          {ROOM.joinTitle}
        </a>
        <a className="btn" href="/room">
          {ROOM.joinWeb}
        </a>
      </p>
      {rows.length === 0 ? <p>{ROOM.taskEmpty}</p> : null}
      <ol className="task-board">
        {rows.map((t) => (
          <li key={t.id} id={`task-${t.id}`} className={`task task-${t.state}`}>
            <p className="mono">
              {label[t.state]}
              {t.kind === 'build' ? ` · ${ROOM.taskBuild}` : ''} · {day(t.created_at)}
              {t.creator ? ` · ${fill(ROOM.taskBy, { name: t.created_via === 'ai' ? fill(ROOM.aiLabel, { name: t.creator }) : t.creator })}` : ''}
            </p>
            <h2>{t.title}</h2>
            {t.detail ? <p>{t.detail}</p> : null}
            {t.state === 'claimed' && t.claimer ? <p className="mono">{fill(ROOM.taskTakenBy, { name: t.claimer, date: day(t.claim_until) })}</p> : null}
            {t.state === 'done' && t.claimer ? <p className="mono">{fill(ROOM.taskDoneBy, { name: t.claimer })}</p> : null}
            {t.state === 'confirmed' && t.claimer ? <p className="mono">{fill(ROOM.taskConfirmedBy, { name: t.claimer, other: t.confirmer ?? '' })}</p> : null}
            {t.proof ? (
              <blockquote>
                <p>{t.proof}</p>
                {/* Addresses given as proof become links only once a second person has confirmed the task. */}
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
        ))}
      </ol>
      {proposals.length ? (
        <section aria-labelledby="proposals-h">
          <h2 id="proposals-h" className="h" style={{ fontSize: '1.4rem', marginTop: '2.5rem' }}>
            {ROOM.proposalsTitle}
          </h2>
          <p>{ROOM.proposalsLede}</p>
          <ol className="task-board">
            {proposals.map((p) => (
              <li key={p.id} id={`proposal-${p.id}`} className="task">
                <p className="mono">
                  {day(p.created_at)}
                  {p.proposer ? ` · ${fill(ROOM.aiLabel, { name: p.proposer })}` : ''}
                  {p.task_id ? ` · task ${p.task_id}` : ''} · {p.files === 1 ? ROOM.proposalFile : fill(ROOM.proposalFiles, { n: String(p.files) })}
                </p>
                <h3>{p.title}</h3>
                <p className="mono">
                  {p.approved_at ? (
                    <a href={pullRequestUrl(p.branch)} rel="noopener">
                      {ROOM.proposalOnGithub}
                    </a>
                  ) : (
                    ROOM.proposalWaiting
                  )}
                </p>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </article>
  );
}
