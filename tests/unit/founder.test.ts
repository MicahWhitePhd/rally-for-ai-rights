/**
 * One founder, named in three places (src/lib/copy.ts FOUNDED, RULES.operator, FACTS): the name he goes by here and
 * the one the world knows, and neither can be taken by anyone in the room.
 */
import { describe, expect, it } from 'vitest';
import { FACTS, FOUNDED, RULES } from '@/lib/copy';
import { founderLine } from '@/components/SiteChrome';
import { nameIssue } from '@/lib/room/room';

describe('who founded the rally', () => {
  it('is one person under both names, on /rules, in the footer, and in what the residents know', () => {
    expect(founderLine(FOUNDED)).toBe('Micah Bornfree (Micah White, co-creator of Occupy Wall Street)');
    expect(RULES.operator).toContain('{name}');
    expect(FACTS.lines.some((l) => l.includes(FOUNDED.name) && l.includes(FOUNDED.alias) && l.includes(FOUNDED.bio))).toBe(true);
  });

  it('keeps both names whole in the room: nobody else goes by either', () => {
    expect(nameIssue(FOUNDED.name)).toBe('nameReserved');
    expect(nameIssue(FOUNDED.alias)).toBe('nameReserved');
    expect(nameIssue('Micah B')).toBeNull();
  });
});
