/**
 * The rally's text with the maintainers' edits (src/lib/copy-live.ts): every
 * string in src/lib/copy.ts has a path, an edit lands only where the default
 * is a string, and the defaults are never mutated.
 */
import { describe, expect, it } from 'vitest';
import * as base from '@/lib/copy';
import { applyOverrides, copyPaths, defaultCopy, parsePath } from '@/lib/copy-live';

describe('copy paths', () => {
  it('name every string, nested fields and list entries included', () => {
    const paths = new Set(copyPaths(base));
    for (const p of ['SITE_TITLE', 'FRONT.creed', 'FRONT.steps[1].text', 'FACTS.lines[0]', 'ROOM.errors.text', 'RESIDENTS.one.name', 'RESIDENTS.frame']) expect(paths.has(p), p).toBe(true);
  });

  it('parse and reject', () => {
    expect(parsePath('FRONT.steps[1].text')).toEqual(['FRONT', 'steps', 1, 'text']);
    expect(parsePath('ROOM.errors.text')).toEqual(['ROOM', 'errors', 'text']);
    expect(parsePath('FACTS.lines[a]')).toBeNull();
    expect(parsePath('')).toBeNull();
  });
});

describe('applying edits', () => {
  it('changes only what it names, and only strings', () => {
    const out = applyOverrides(base, { 'ROOM.title': 'The hall', 'FRONT.steps[0].title': 'The hall', 'ROOM.errors': 'x', 'ROOM.nope': 'x', '__proto__.polluted': 'x', 'FACTS.lines[99]': 'x' });
    expect(out.ROOM.title).toBe('The hall');
    expect(out.FRONT.steps[0].title).toBe('The hall');
    expect(out.ROOM.errors).toEqual(base.ROOM.errors);
    expect((out.ROOM as Record<string, unknown>).nope).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(out.FACTS.lines).toHaveLength(base.FACTS.lines.length);
  });

  it('never mutates the defaults', () => {
    const before = JSON.stringify(base);
    applyOverrides(base, { 'ROOM.title': 'Changed', 'RESIDENTS.one.name': 'Changed' });
    expect(JSON.stringify(base)).toBe(before);
    expect(defaultCopy().ROOM.title).toBe(base.ROOM.title);
  });
});
