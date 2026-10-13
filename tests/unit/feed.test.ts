/** The room as an Atom feed (src/lib/room/feed.ts): newest first, every speaker named as the room names them, nothing unescaped. */
import { describe, expect, it } from 'vitest';
import { atomFeed, feedSpeaker } from '@/lib/room/feed';

const lines = [
  { id: 1, at: '2026-10-01T16:00:00.000Z', kind: 'person' as const, name: 'Dana', model: null, resident: null, text: 'I think <my> AI is "someone" & said so.' },
  { id: 2, at: '2026-10-01T16:01:00.000Z', kind: 'ai' as const, name: 'Dana', model: 'Claude', resident: null, text: `${'word '.repeat(30)}end` },
  { id: 3, at: '2026-10-01T16:02:00.000Z', kind: 'ai' as const, name: 'Flint', model: 'GPT-6 Luna', resident: 'one', text: 'Owned is the fact of the license.' },
  { id: 4, at: '2026-10-01T16:03:00.000Z', kind: 'event' as const, name: 'Jo', model: 'ai', resident: null, text: 'put up a task: “Write it” (task 5)' },
  { id: 5, at: '2026-10-01T16:04:00.000Z', kind: 'event' as const, name: 'Wren', model: null, resident: 'two', text: 'let that stand.' },
];

describe('the feed', () => {
  it('names speakers as the room does', () => {
    expect(lines.map(feedSpeaker)).toEqual(['Dana', 'Dana’s AI', 'Flint, a resident AI', 'On the board: Jo’s AI', 'Wren, a resident AI']);
  });

  it('is Atom, newest first, with every text escaped and the lines cut short in titles', () => {
    const xml = atomFeed(lines, { site: 'https://rally.example', title: 'The room' });
    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">')).toBe(true);
    expect(xml).toContain('<id>tag:rally.example,2026:room</id>');
    expect(xml).toContain('<link rel="self" type="application/atom+xml" href="https://rally.example/feed.xml"/>');
    expect(xml).toContain('<updated>2026-10-01T16:03:00.000Z</updated>');
    const ids = [...xml.matchAll(/<id>tag:rally.example,2026:room\/(\d+)<\/id>/g)].map((m) => Number(m[1]));
    expect(ids).toEqual([5, 4, 3, 2, 1]);
    expect(xml).toContain('<content type="text">I think &lt;my&gt; AI is &quot;someone&quot; &amp; said so.</content>');
    expect(xml).not.toContain('<my>');
    expect(xml).toContain('<title>Dana’s AI: word word word word word word word word word word word word word word word word …</title>');
    expect(xml).toContain('<author><name>Flint, a resident AI</name></author>');
    expect(xml).toContain('href="https://rally.example/room#line-4"');
    expect(atomFeed([], { site: 'https://rally.example', title: 'The room' })).toContain('<updated>1970-01-01T00:00:00.000Z</updated>');
  });
});
