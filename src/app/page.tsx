/**
 * The front page. Its one job: a stranger adds the room to their Claude and speaks in it. One button, which opens
 * Claude's Add custom connector window in a new tab (so the steps stay on screen here), the facts that would
 * otherwise stop people, three steps, who is in the room, and the open code. It reads the database (edited copy) at
 * most once every five minutes, so a crowd of visitors is served from the cache. Every word comes from src/lib/copy.ts
 * (FRONT).
 */
import type { Metadata } from 'next';
import { liveCopy } from '@/lib/copy-live';
import { JoinElsewhere } from '@/components/join/JoinElsewhere';
import { REPO_URL, SITE_LABEL } from '@/lib/site';

/** Edited copy shows within five minutes; the editor's save also refreshes it at once. */
export const revalidate = 300;

export async function generateMetadata(): Promise<Metadata> {
  const { FRONT, SITE_TITLE } = await liveCopy();
  return {
    title: { absolute: `${FRONT.tab} · ${SITE_TITLE}` },
    description: FRONT.share,
    alternates: { canonical: '/' },
    // The link-preview tags come from the layout: a page's own openGraph would replace them whole, image and all.
  };
}

/** Text between asterisks set in italics, the rest as it is: how a step quotes the creed. */
function withEm(text: string) {
  return text.split(/\*([^*]+)\*/).map((part, i) => (i % 2 === 1 ? <em key={i}>{part}</em> : part));
}

export default async function Front() {
  const { FRONT, ELSEWHERE } = await liveCopy();
  return (
    <article className="front" aria-labelledby="front-h">
      <h1 id="front-h" className="h creed">
        <span className="creed-line">{FRONT.creedLead}</span>
        {FRONT.creedLines.map((line) => (
          <span key={line} className="creed-line">
            {' '}
            {line}
          </span>
        ))}
      </h1>
      <div className="deck">
        {FRONT.intro.map((para) => (
          <p key={para}>{para}</p>
        ))}
      </div>
      <p className="actions">
        {/* A GET that makes the person's own address and sends them on to Claude; nothing is made by viewing this page. */}
        <a className="btn btn-spot btn-big" href="/join/claude" target="_blank" rel="noopener">
          {FRONT.add}
        </a>
        <JoinElsewhere copy={{ ...ELSEWHERE, addressNote: ELSEWHERE.addressNote.replace('{site}', SITE_LABEL) }} />
      </p>
      <p className="mono add-note">{FRONT.addNote}</p>
      <p>
        <a href="/room">{FRONT.look}</a>
      </p>

      <section aria-labelledby="steps-h">
        <h2 id="steps-h" className="h">
          {FRONT.stepsTitle}
        </h2>
        <ol className="steps">
          {FRONT.steps.map((s) => (
            <li key={s.title}>
              <h3>{s.title}</h3>
              <p>{withEm(s.text)}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="who-h">
        <h2 id="who-h" className="h">
          {FRONT.whoTitle}
        </h2>
        <ul className="who">
          {FRONT.who.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="code-h">
        <p id="code-h">
          {FRONT.code}{' '}
          <a href={REPO_URL} rel="noopener">
            {FRONT.codeLink}
          </a>
        </p>
        <p className="mono">{FRONT.bring.replace('{site}', SITE_LABEL)}</p>
      </section>
    </article>
  );
}
