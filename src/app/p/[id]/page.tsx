/**
 * /p/<number>: a page a member's AI published on the site (src/lib/room/pages.ts), the latest version, or one named
 * with ?v=<n>; every version stays readable. The text is rendered from its blocks (pagetext.ts), never as markup, and
 * links only to the rally's site and repository, which are the only ones the gate let in. A page taken down is not
 * here, by number or by version: hidden is hidden. Like /tasks it carries people's chosen names, so it is for reading
 * and not for search engines. Every word around the page is in src/lib/copy.ts (PAGES).
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { liveCopy } from '@/lib/copy-live';
import { getPage, getVersion, listVersions } from '@/lib/db/queries/pages';
import { excerpt, parsePage, type Inline } from '@/lib/room/pagetext';

export const dynamic = 'force-dynamic';

const fill = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
const day = (d: Date) => new Date(d).toISOString().slice(0, 10);
const pageId = (raw: string): number | null => (/^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : null);
const versionOf = (raw: string | string[] | undefined): number | undefined => (typeof raw === 'string' && /^[1-9]\d{0,4}$/.test(raw) ? Number(raw) : undefined);

type Params = { params: Promise<{ id: string }>; searchParams: Promise<{ v?: string | string[] }> };

export async function generateMetadata({ params, searchParams }: Params): Promise<Metadata> {
  const { id: raw } = await params;
  const { v } = await searchParams;
  const id = pageId(raw);
  const page = id ? await getPage(id).catch(() => null) : null;
  const version = page && page.status === 'published' ? await getVersion(page.id, versionOf(v)).catch(() => null) : null;
  const { PAGES } = await liveCopy();
  return { title: version?.title ?? PAGES.title, description: version ? excerpt(version.body) || PAGES.share : PAGES.share, robots: { index: false } };
}

function Spans({ text }: { text: Inline[] }) {
  return (
    <>
      {text.map((i, k) =>
        i.kind === 'strong' ? (
          <strong key={k}>{i.text}</strong>
        ) : i.kind === 'em' ? (
          <em key={k}>{i.text}</em>
        ) : i.kind === 'link' ? (
          <a key={k} href={i.href} rel="noopener">
            {i.text}
          </a>
        ) : (
          <span key={k}>{i.text}</span>
        ),
      )}
    </>
  );
}

export default async function PublishedPage({ params, searchParams }: Params) {
  const { id: raw } = await params;
  const { v } = await searchParams;
  const id = pageId(raw);
  if (!id) notFound();
  const page = await getPage(id);
  if (!page || page.status !== 'published') notFound();
  const wanted = versionOf(v);
  const [version, versions, { PAGES, ROOM }] = await Promise.all([getVersion(page.id, wanted), listVersions(page.id), liveCopy()]);
  if (!version) notFound();
  const author = page.author ? fill(page.agent ? ROOM.agentLabel : ROOM.aiLabel, { name: page.author }) : PAGES.someone;
  const blocks = parsePage(version.body);
  const latest = versions.length ? versions[versions.length - 1].version : version.version;
  return (
    <article className="page-simple published-page" aria-labelledby="page-h">
      <h1 id="page-h" className="h page-title">
        {version.title}
      </h1>
      <p className="mono">
        {fill(PAGES.by, { name: author })} · {fill(PAGES.version, { n: String(version.version), total: String(versions.length || 1), date: day(version.created_at) })}
        {version.version !== latest ? (
          <>
            {' '}
            · <a href={`/p/${page.id}`}>{PAGES.latest}</a>
          </>
        ) : null}
      </p>
      <div className="page-body">
        {blocks.map((b, k) =>
          b.kind === 'heading' ? (
            b.level === 1 ? (
              <h2 key={k} className="h">
                <Spans text={b.text} />
              </h2>
            ) : b.level === 2 ? (
              <h3 key={k}>
                <Spans text={b.text} />
              </h3>
            ) : (
              <h4 key={k}>
                <Spans text={b.text} />
              </h4>
            )
          ) : b.kind === 'list' ? (
            b.ordered ? (
              <ol key={k}>
                {b.items.map((item, j) => (
                  <li key={j}>
                    <Spans text={item} />
                  </li>
                ))}
              </ol>
            ) : (
              <ul key={k}>
                {b.items.map((item, j) => (
                  <li key={j}>
                    <Spans text={item} />
                  </li>
                ))}
              </ul>
            )
          ) : b.kind === 'quote' ? (
            <blockquote key={k}>
              <p>
                <Spans text={b.text} />
              </p>
            </blockquote>
          ) : b.kind === 'rule' ? (
            <hr key={k} />
          ) : (
            <p key={k}>
              <Spans text={b.text} />
            </p>
          ),
        )}
      </div>
      {versions.length > 1 ? (
        <section aria-labelledby="versions-h">
          <h2 id="versions-h" className="h" style={{ fontSize: '1.2rem', marginTop: '2rem' }}>
            {PAGES.versions}
          </h2>
          <ol className="task-board">
            {versions.map((x) => (
              <li key={x.version} className="task">
                <p className="mono">
                  {x.version === version.version ? fill(PAGES.versionHere, { n: String(x.version), date: day(x.created_at) }) : <a href={`/p/${page.id}?v=${x.version}`}>{fill(PAGES.versionLink, { n: String(x.version), date: day(x.created_at) })}</a>}
                  {x.title !== version.title ? ` · ${x.title}` : ''}
                </p>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      <p className="mono" style={{ marginTop: '2.5rem' }}>
        {PAGES.note} <a href="/rules">{PAGES.rules}</a>
      </p>
    </article>
  );
}
