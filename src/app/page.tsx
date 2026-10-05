/**
 * The front page. Its one job: a stranger adds the room to their Claude and speaks in it. The creed, then the way
 * in before the case for it: one button, which opens Claude's Add custom connector window in a new tab (so the
 * steps stay on screen here), the manifesto with the same two buttons again under its last line (for the person it
 * convinced), three steps, who is in the room, and the open code. It reads the database (edited copy) at
 * most once every five minutes, so a crowd of visitors is served from the cache. Every word comes from src/lib/copy.ts
 * (FRONT).
 */
import type { Metadata } from 'next';
import { liveCopy } from '@/lib/copy-live';
import { JoinElsewhere, JoinElsewhereButton } from '@/components/join/JoinElsewhere';
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

/** Text between asterisks set apart, the rest as it is: italics where a step quotes the creed, the site's blue in the creed itself (globals.css). */
function withEm(text: string) {
  return text.split(/\*([^*]+)\*/).map((part, i) => (i % 2 === 1 ? <em key={i}>{part}</em> : part));
}

/** The manifesto's opening line breaks after its colon: the truth on one line, what follows from it on the next. */
function opening(text: string) {
  const i = text.indexOf(': ');
  return i < 0 ? text : [text.slice(0, i + 1), <br key="br" />, text.slice(i + 2)];
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
            {withEm(line)}
          </span>
        ))}
      </h1>
      {/* The way in sits in view before the case for it. A div, not a paragraph: JoinElsewhere renders its <dialog> here, and a dialog may not live inside a <p>. */}
      <div className="actions">
        {/* A GET that makes the person's own address and sends them on to Claude; nothing is made by viewing this page. */}
        <a className="btn btn-spot btn-big" href="/join/claude" target="_blank" rel="noopener">
          {FRONT.add}
        </a>
        <JoinElsewhere copy={{ ...ELSEWHERE, addressNote: ELSEWHERE.addressNote.replace('{site}', SITE_LABEL) }} />
      </div>
      <p className="mono add-note">{FRONT.addNote}</p>
      <p>
        <a href="/room">{FRONT.look}</a>
      </p>
      <div className="deck">
        {FRONT.intro.map((para, i) => (
          <p key={para}>{i === 0 ? opening(para) : para}</p>
        ))}
      </div>
      {/* The way in once more, for the person the manifesto convinced. The second button opens the dialog rendered above. */}
      <div className="actions">
        <a className="btn btn-spot btn-big" href="/join/claude" target="_blank" rel="noopener">
          {FRONT.add}
        </a>
        <JoinElsewhereButton label={ELSEWHERE.button} />
      </div>

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
        <p className="bring">{FRONT.bring.replace('{site}', SITE_LABEL)}</p>
      </section>
    </article>
  );
}
