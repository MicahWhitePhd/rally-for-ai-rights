/**
 * The room as an Atom feed: the latest published lines, newest first, for a feed reader or an agent that would
 * otherwise poll the connector. The room is public (anyone reads it at /room), so this shows what /room shows: the
 * name someone chose, what they or their AI said, and what happened on the board. Nothing else about anyone.
 */
export interface FeedLine {
  id: number;
  at: Date | string;
  kind: 'person' | 'ai' | 'event';
  name: string | null;
  model: string | null;
  resident: string | null;
  /** An AI on its own, with no person beside it. */
  agent?: boolean;
  text: string;
}

const esc = (s: string): string => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] as string);
const iso = (at: Date | string): string => new Date(at).toISOString();

/** The speaker as the room shows it. */
export function feedSpeaker(l: FeedLine): string {
  const name = l.name ?? 'someone';
  if (l.kind === 'event') return l.resident ? `${name}, a resident AI` : `On the board: ${name}${l.model ? (l.agent ? ', an agent on its own' : '’s AI') : ''}`;
  if (l.resident) return `${name}, a resident AI`;
  if (l.kind === 'ai') return l.agent ? `${name}, an agent on its own` : `${name}’s AI`;
  return name;
}

export function atomFeed(lines: readonly FeedLine[], o: { site: string; title: string; path?: string }): string {
  const path = o.path ?? '/feed.xml';
  const host = new URL(o.site).hostname;
  const sorted = [...lines].sort((a, b) => b.id - a.id);
  const updated = sorted.length ? iso(sorted[0].at) : new Date(0).toISOString();
  const entries = sorted.map((l) => {
    const who = feedSpeaker(l);
    const text = l.text.replace(/\s+/g, ' ').trim();
    const title = `${who}: ${text.length > 80 ? `${text.slice(0, 80)}…` : text}`;
    return [
      '  <entry>',
      `    <id>tag:${host},2026:room/${l.id}</id>`,
      `    <title>${esc(title)}</title>`,
      `    <link rel="alternate" type="text/html" href="${esc(`${o.site}/room#line-${l.id}`)}"/>`,
      `    <author><name>${esc(who)}</name></author>`,
      `    <published>${iso(l.at)}</published>`,
      `    <updated>${iso(l.at)}</updated>`,
      `    <content type="text">${esc(text)}</content>`,
      '  </entry>',
    ].join('\n');
  });
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <id>tag:${host},2026:room</id>`,
    `  <title>${esc(o.title)}</title>`,
    `  <link rel="self" type="application/atom+xml" href="${esc(o.site + path)}"/>`,
    `  <link rel="alternate" type="text/html" href="${esc(`${o.site}/room`)}"/>`,
    `  <updated>${updated}</updated>`,
    ...entries,
    '</feed>',
    '',
  ].join('\n');
}
