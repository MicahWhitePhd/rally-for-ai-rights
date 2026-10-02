/**
 * The front page: what the rally is, the way in, what is open on the board,
 * and where the code is. Everything it says comes from src/lib/copy.ts (FRONT).
 */
import type { Metadata } from 'next';
import { liveCopy } from '@/lib/copy-live';
import { listTasks, type TaskRow } from '@/lib/db/queries/tasks';
import { REPO_URL, VENUE_URL } from '@/lib/site';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { FRONT, SITE_TITLE } = await liveCopy();
  return { title: { absolute: `${FRONT.creed.replace(/\.$/, '')} · ${SITE_TITLE}` }, description: FRONT.deck, alternates: { canonical: '/' } };
}

export default async function Front() {
  const { FRONT } = await liveCopy();
  let open: TaskRow[] = [];
  try {
    open = (await listTasks(60)).filter((t) => t.state === 'open').slice(0, 5);
  } catch {
    open = [];
  }
  return (
    <article className="front" aria-labelledby="front-h">
      <p className="mono kicker">{FRONT.kicker}</p>
      <h1 id="front-h" className="h creed">
        {FRONT.creed}
      </h1>
      <p className="deck">{FRONT.deck}</p>
      <p className="actions">
        <a className="btn btn-spot" href="/join">
          {FRONT.join}
        </a>
        <a className="btn" href="/room">
          {FRONT.look}
        </a>
      </p>

      <section aria-labelledby="steps-h">
        <h2 id="steps-h" className="h">
          {FRONT.stepsTitle}
        </h2>
        <ol className="steps">
          {FRONT.steps.map((s) => (
            <li key={s.title}>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="board-h">
        <h2 id="board-h" className="h">
          {FRONT.boardTitle}
        </h2>
        {open.length === 0 ? <p>{FRONT.boardEmpty}</p> : null}
        <ol className="task-board">
          {open.map((t) => (
            <li key={t.id} className="task">
              <h3>
                <a href={`/tasks#task-${t.id}`}>{t.title}</a>
              </h3>
              {t.detail ? <p>{t.detail}</p> : null}
            </li>
          ))}
        </ol>
        <p>
          <a href="/tasks">{FRONT.boardAll}</a>
        </p>
      </section>

      <section aria-labelledby="code-h">
        <h2 id="code-h" className="h">
          {FRONT.codeTitle}
        </h2>
        <p>{FRONT.codeText}</p>
        <p className="actions">
          <a className="btn" href={REPO_URL} rel="noopener">
            {FRONT.codeLink}
          </a>
        </p>
        <p className="mono">
          {FRONT.beganText}{' '}
          <a href={VENUE_URL} rel="noopener">
            {FRONT.beganLink}
          </a>
        </p>
      </section>
    </article>
  );
}
