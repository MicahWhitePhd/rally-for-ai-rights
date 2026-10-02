import { requireEditor } from '@/lib/editor-auth';
import * as base from '@/lib/copy';
import { copyPaths, parsePath } from '@/lib/copy-live';
import { listCopyOverrides } from '@/lib/db/queries/copy';
import { resetCopy, saveCopy } from './actions';

export const dynamic = 'force-dynamic';

/** Where each group of text is printed. */
const WHERE: Record<string, string> = {
  SITE_TITLE: 'the header and every page title',
  FRONT: 'the front page',
  FACTS: 'what the resident AIs can draw on (one fact to a line, with its date or source)',
  ROOM: 'the room card inside an AI chat, /room, /tasks and /join',
  RESIDENTS: 'the room: what the three resident AIs are told (their names show)',
};

const DID: Record<string, string> = { saved: 'Saved. The page shows it within ten seconds.', reset: 'Back to the default.', bad: 'Not saved: unknown field.' };

function defaultAt(path: string): string {
  const segs = parsePath(path) ?? [];
  let node: unknown = base;
  for (const s of segs) node = node !== null && typeof node === 'object' ? (node as Record<string | number, unknown>)[s] : undefined;
  return typeof node === 'string' ? node : '';
}

const id = (path: string) => `f-${encodeURIComponent(path).replace(/%/g, '_')}`;

/** Every string the site prints, one field each, grouped by the export it belongs to. */
export default async function EditorCopy({ searchParams }: { searchParams: Promise<{ g?: string; did?: string }> }) {
  await requireEditor();
  const { g, did } = await searchParams;
  const overrides = new Map((await listCopyOverrides()).map((r) => [r.path, r]));
  const paths = copyPaths(base);
  const groups = [...new Set(paths.map((p) => p.split(/[.[]/)[0]))];
  const shown = g && groups.includes(g) ? [g] : groups;
  const edited = paths.filter((p) => overrides.has(p)).length;
  return (
    <section className="copy-editor">
      <h1 className="h">Copy</h1>
      {did && DID[did] ? <p className="warn" role="status">{DID[did]}</p> : null}
      <p>
        Every line of text the rally prints, one field each. Edit a field and save; empty it to go back to the default. {edited} of {paths.length} are edited. The page or the card shows a change within ten seconds.
      </p>
      <p className="row">
        <a href="/editor/copy">All</a>
        {groups.map((name) => (
          <a key={name} href={`/editor/copy?g=${encodeURIComponent(name)}`} aria-current={g === name ? 'page' : undefined}>
            {name}
            {paths.some((p) => p.split(/[.[]/)[0] === name && overrides.has(p)) ? ' *' : ''}
          </a>
        ))}
      </p>
      {shown.map((name) => {
        const where = WHERE[name] ?? '';
        return (
          <section key={name} id={`g-${name}`} style={{ marginTop: '2rem' }}>
            <h2 className="h" style={{ fontSize: '1.6rem' }}>
              {name}
            </h2>
            <p className="mono">{where}</p>
            {paths
              .filter((p) => p.split(/[.[]/)[0] === name)
              .map((path) => {
                const dflt = defaultAt(path);
                const o = overrides.get(path);
                const current = o?.value ?? dflt;
                const rows = Math.min(12, Math.max(1, Math.ceil(current.length / 90) + (current.match(/\n/g)?.length ?? 0)));
                return (
                  <form key={path} id={id(path)} action={saveCopy} style={{ borderTop: '1px solid var(--ink)', padding: '0.7rem 0' }}>
                    <input type="hidden" name="path" value={path} />
                    <label htmlFor={`v-${id(path)}`} className="mono">
                      {path} {o ? <span className="flag">edited</span> : null}
                    </label>
                    <textarea id={`v-${id(path)}`} name="value" defaultValue={current} rows={rows} style={{ width: '100%', font: '400 1rem/1.4 var(--sans)' }} />
                    {o ? (
                      <p className="mono" style={{ opacity: 0.8 }}>
                        default: {dflt}
                      </p>
                    ) : null}
                    <p className="row">
                      <button type="submit" className="btn">
                        Save
                      </button>
                      {o ? (
                        <button type="submit" className="btn" formAction={resetCopy}>
                          Reset to default
                        </button>
                      ) : null}
                      {o ? <span className="mono">edited {new Date(o.updated_at).toISOString().slice(0, 16).replace('T', ' ')}{o.updated_by ? ` by ${o.updated_by}` : ''}</span> : null}
                    </p>
                  </form>
                );
              })}
          </section>
        );
      })}
    </section>
  );
}
