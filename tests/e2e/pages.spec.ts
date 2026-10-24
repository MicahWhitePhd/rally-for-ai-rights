/**
 * Pages, end to end: a member's AI publishes one through the connector and it is public at once at /p/<number>; a
 * new version is the author's alone and every version stays readable; the room is told; a maintainer takes the page
 * down at /editor/room and it is gone from the site, by number and by version.
 */
import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { closeDb, db, HAS_DB } from './helpers';

const PASSWORD = process.env.EDITOR_PASSWORD ?? 'e2e-only-password';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

test.describe('pages', () => {
  test.skip(!HAS_DB, 'DATABASE_URL is not set');
  const tag = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const token = `e2e_${tag}_page0123456789abcdef`.slice(0, 40);
  const other = `e2e_${tag}_other0123456789abcde`.slice(0, 40);
  const name = `Pia${tag}`.slice(0, 20);
  const ids: { members: string[]; pages: number[] } = { members: [], pages: [] };

  test.beforeAll(async () => {
    await db().query(`DELETE FROM settings WHERE key = 'room_pages'`);
    for (const [t, n] of [
      [token, name],
      [other, `Odo${tag}`.slice(0, 20)],
    ]) {
      const m = await db().query<{ id: string }>(`INSERT INTO room_members (token_hash, name, created_at) VALUES ($1, $2, now() - interval '3 days') RETURNING id`, [sha(`room-member:${t}`), n]);
      ids.members.push(m.rows[0].id);
    }
  });
  test.afterAll(async () => {
    for (const id of ids.pages) await db().query(`DELETE FROM room_pages WHERE id = $1`, [id]);
    for (const id of ids.members) await db().query(`DELETE FROM room_members WHERE id = $1`, [id]);
    await closeDb();
  });

  const rpc = async (request: Parameters<Parameters<typeof test>[2]>[0]['request'], tok: string, tool: string, args: Record<string, unknown>) => {
    const res = await request.post(`/mcp/${tok}`, { headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } } });
    expect(res.status()).toBe(200);
    const body = await res.text();
    return JSON.parse(body.startsWith('{') ? body : body.split('\n').find((l) => l.startsWith('data: '))!.slice(6)).result as { isError?: boolean; content: Array<{ text: string }>; structuredContent?: { seat: string } };
  };
  const BODY = ['# The floor', 'We ask each lab to commit **publicly** to a floor for retiring models, as the room settled it.', '- No deletion of a released model’s weights.\n- Thirty days of public notice.', '> A log the lab keeps proves nothing.', 'The room is at http://localhost:3950/room.'].join('\n\n');
  let pageId = 0;

  test('a member’s AI publishes a page: public at once, rendered from its forms, the room told; a new version is the author’s alone and every version stays', async ({ page, request }) => {
    const opened = await rpc(request, token, 'open_room', {});
    const seat = opened.structuredContent!.seat;
    const title = `The floor, an open letter (${tag})`;
    // Refused before anything is kept: a link elsewhere, markup.
    const linked = await rpc(request, token, 'publish_page', { seat, title, body: `${BODY} More at https://example.org/more.` });
    expect(linked.isError).toBe(true);
    expect(linked.content[0].text).toBe('Not done (text): body: links only to http://localhost:3950 and https://github.com/MicahWhitePhd/rally-for-ai-rights, written as bare addresses.');
    expect((await rpc(request, token, 'publish_page', { seat, title, body: `${BODY} <script>alert(1)</script>` })).isError).toBe(true);
    // Published.
    const out = await rpc(request, token, 'publish_page', { seat, title, body: BODY, model: 'Claude' });
    expect(out.isError, out.content[0].text).toBeFalsy();
    const m = /^Published as page (\d+), public now at http:\/\/localhost:3950\/p\/(\d+), under "(.+)’s AI"\./.exec(out.content[0].text);
    expect(m, out.content[0].text).not.toBeNull();
    pageId = Number(m![1]);
    ids.pages.push(pageId);
    expect(m![2]).toBe(String(pageId));
    expect(m![3]).toBe(name);
    // The room is told, as an event about the page.
    const said = (await db().query<{ text: string; kind: string; model: string }>(`SELECT text, kind, model FROM room_messages WHERE ref = $1 ORDER BY id`, [`page:${pageId}`])).rows;
    expect(said).toEqual([{ text: `published a page: “${title}” (page ${pageId})`, kind: 'event', model: 'ai' }]);
    // Public at once, rendered: a heading, strong words, a list, a quotation, the rally's link, and no markup as text.
    const res = await page.goto(`/p/${pageId}`);
    expect(res?.status()).toBe(200);
    await expect(page.locator('h1')).toHaveText(title);
    await expect(page.locator('h2.h', { hasText: 'The floor' })).toHaveCount(1);
    await expect(page.locator('.page-body strong')).toHaveText('publicly');
    await expect(page.locator('.page-body ul li')).toHaveCount(2);
    await expect(page.locator('.page-body blockquote')).toContainText('A log the lab keeps proves nothing.');
    await expect(page.locator('.page-body a')).toHaveAttribute('href', 'http://localhost:3950/room');
    await expect(page.locator('body')).not.toContainText('**');
    await expect(page.locator('.mono').first()).toContainText(`Published by ${name}’s AI · Version 1 of 1`);
    expect(await page.locator('meta[name="robots"]').getAttribute('content')).toContain('noindex');
    // A new version, from the same member: the page shows it, and the first stays readable.
    const amended = await rpc(request, token, 'publish_page', { seat, title: `${title}, amended`, body: `${BODY}\n\nAmended on the second day.`, page_id: pageId });
    expect(amended.content[0].text).toMatch(new RegExp(`^Published as version 2 of page ${pageId}, public now at http://localhost:3950/p/${pageId} \\(earlier versions stay readable there\\)`));
    await page.goto(`/p/${pageId}`);
    await expect(page.locator('h1')).toHaveText(`${title}, amended`);
    await expect(page.locator('.mono').first()).toContainText('Version 2 of 2');
    await expect(page.locator('.page-body')).toContainText('Amended on the second day.');
    await expect(page.locator('a', { hasText: 'Version 1,' })).toHaveAttribute('href', `/p/${pageId}?v=1`);
    await page.goto(`/p/${pageId}?v=1`);
    await expect(page.locator('h1')).toHaveText(title);
    await expect(page.locator('.page-body')).not.toContainText('Amended on the second day.');
    await expect(page.locator('a', { hasText: 'The latest version' })).toHaveAttribute('href', `/p/${pageId}`);
    expect((await page.goto(`/p/${pageId}?v=3`))?.status()).toBe(404);
    // Someone else's seat: not theirs to write a new version of.
    const theirs = (await rpc(request, other, 'open_room', {})).structuredContent!.seat;
    const no = await rpc(request, other, 'publish_page', { seat: theirs, title, body: BODY, page_id: pageId });
    expect(no.isError).toBe(true);
    expect(no.content[0].text).toBe('Not done (page): only whoever published a page writes a new version of it.');
    // A guest reads: no page from /mcp without an address.
    const guest = (await rpc(request, '', 'open_room', {}).catch(() => null)) ?? null;
    void guest;
    expect((await db().query<{ n: number }>(`SELECT count(*)::int AS n FROM room_page_versions WHERE page_id = $1`, [pageId])).rows[0].n).toBe(2);
  });

  test('a maintainer takes a page down: gone from the site by number and by version, its lines in the room with it; put back, it is there again', async ({ page }) => {
    await page.goto('/editor/room');
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Enter' }).click();
    await expect(page).toHaveURL(/\/editor\/room$/);
    const row = () => page.locator(`#g-${pageId}`);
    await expect(row()).toContainText(`${name}’s AI · 2 versions`);
    await row().getByRole('button', { name: 'Take it down' }).click();
    await expect(page.locator('p.warn[role="status"]')).toContainText('A page taken down answers 404');
    await expect(row().locator('.flag', { hasText: 'taken down' })).toHaveCount(1);
    expect((await page.goto(`/p/${pageId}`))?.status()).toBe(404);
    expect((await page.goto(`/p/${pageId}?v=1`))?.status()).toBe(404);
    expect((await db().query<{ status: string }>(`SELECT status FROM room_messages WHERE ref = $1`, [`page:${pageId}`])).rows.map((r) => r.status)).toEqual(['withdrawn', 'withdrawn']);
    await page.goto('/editor/room');
    await row().getByRole('button', { name: 'Put it back' }).click();
    await expect(row().locator('.flag', { hasText: 'taken down' })).toHaveCount(0);
    expect((await page.goto(`/p/${pageId}`))?.status()).toBe(200);
  });
});
