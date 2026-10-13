/**
 * The words (src/lib/copy.ts): what a page promises in a comment is on the page.
 */
import { describe, expect, it } from 'vitest';
import { FRONT, ROOM } from '@/lib/copy';

describe('the fine print under the Claude button', () => {
  it('names the three walls people hit: the free plan, Team and Enterprise, and phones', () => {
    expect(FRONT.addNote).toMatch(/free plan/i);
    expect(FRONT.addNote).toMatch(/Team or Enterprise/);
    expect(FRONT.addNote).toMatch(/phone/);
    expect(FRONT.addNote).toMatch(/MCP apps/);
  });

  it('says that Claude Desktop has the connector too', () => {
    expect(ROOM.joinDesktop).toMatch(/Claude Desktop/);
  });
});
