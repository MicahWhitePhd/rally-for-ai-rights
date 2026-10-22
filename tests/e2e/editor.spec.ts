/**
 * The maintainers' editor in a browser, against the real database: the sign-in refuses a wrong password and takes
 * the right one; a line is taken down and put back from /editor/room (hidden, not erased: its row changes status); a
 * member is paused for a day with nothing taken down, and the pause ends by itself.
 * The password and secret are the test configuration's own (playwright.config.ts), never a deployment's.
 */
import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { closeDb, db, HAS_DB } from './helpers';

const PASSWORD = process.env.EDITOR_PASSWORD ?? 'e2e-only-password';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

test.describe('the editor', () => {
  test.skip(!HAS_DB, 'DATABASE_URL is not set');
  const tag = `ed${Date.now().toString(36)}`;
  const name = `Ida${tag}`.slice(0, 20);
  const ids: { member?: string; message?: number } = {};

  test.beforeAll(async () => {
    const m = await db().query<{ id: string }>(`INSERT INTO room_members (token_hash, name, created_at) VALUES ($1, $2, now() - interval '3 days') RETURNING id`, [sha(`room-member:editor-${tag}`), name]);
    ids.member = m.rows[0].id;
    const r = await db().query<{ id: number }>(`INSERT INTO room_messages (member_id, kind, text) VALUES ($1, 'person', $2) RETURNING id::int AS id`, [ids.member, `A line for the editor to take down (${tag}).`]);
    ids.message = r.rows[0].id;
  });
  test.afterAll(async () => {
    if (ids.member) await db().query(`DELETE FROM room_members WHERE id = $1`, [ids.member]);
    await closeDb();
  });

  test('refuses a wrong password, takes the right one, and takes a line down and puts it back', async ({ page }) => {
    await page.goto('/editor/room');
    await expect(page).toHaveURL(/\/editor\/login$/);
    await page.getByLabel('Password').fill('not-the-password-at-all');
    await page.getByRole('button', { name: 'Enter' }).click();
    await expect(page).toHaveURL(/\/editor\/login\?e=1$/);
    // The page's own notice (Next's route announcer carries role=alert too).
    await expect(page.locator('p.warn[role="alert"]')).toContainText('not accepted');
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Enter' }).click();
    await expect(page).toHaveURL(/\/editor\/room$/);
    await expect(page.locator('h1')).toHaveText('Room');

    const row = page.locator(`#m-${ids.message}`);
    await expect(row).toContainText(`A line for the editor to take down (${tag}).`);
    await expect(row.locator('.flag', { hasText: 'withdrawn' })).toHaveCount(0);
    await row.getByRole('button', { name: 'Withdraw' }).click();
    await expect(page.locator('p.warn[role="status"]')).toContainText('Withdrawn');
    await expect(page.locator(`#m-${ids.message}`).locator('.flag', { hasText: 'withdrawn' })).toHaveCount(1);
    expect((await db().query<{ status: string }>(`SELECT status FROM room_messages WHERE id = $1`, [ids.message])).rows[0].status).toBe('withdrawn');
    await page.locator(`#m-${ids.message}`).getByRole('button', { name: 'Restore' }).click();
    await expect(page.locator('p.warn[role="status"]')).toContainText('Restored');
    expect((await db().query<{ status: string }>(`SELECT status FROM room_messages WHERE id = $1`, [ids.message])).rows[0].status).toBe('published');
    // Signed out, the page is a login page again.
    await page.getByRole('button', { name: 'Log out' }).click();
    // The sign-out's own redirect first: going on before it lands races the cookie being cleared.
    await expect(page).toHaveURL(/\/editor\/login$/);
    await page.goto('/editor/room');
    await expect(page).toHaveURL(/\/editor\/login$/);
  });

  test('pauses a member for a day with nothing taken down, and the pause ends by itself', async ({ page }) => {
    await page.goto('/editor/room');
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Enter' }).click();
    await expect(page).toHaveURL(/\/editor\/room$/);

    const row = () => page.locator(`#m-${ids.message}`);
    await row().getByRole('button', { name: 'Pause this member for a day: nothing taken down' }).click();
    await expect(page.locator('p.warn[role="status"]')).toContainText('Paused for a day');
    await expect(row().locator('.flag', { hasText: 'paused until' })).toHaveCount(1);
    const m = (await db().query<{ hours: number; status: string }>(
      `SELECT EXTRACT(EPOCH FROM (m.muted_until - now())) / 3600 AS hours, r.status FROM room_members m JOIN room_messages r ON r.member_id = m.id WHERE m.id = $1 AND r.id = $2`,
      [ids.member, ids.message],
    )).rows[0];
    expect(Number(m.hours)).toBeGreaterThan(23.9);
    expect(Number(m.hours)).toBeLessThanOrEqual(24);
    // Nothing they said is taken down by a pause.
    expect(m.status).toBe('published');

    // The day runs out: the member is no longer stopped, with nothing having to run.
    await db().query(`UPDATE room_members SET muted_until = now() - interval '1 minute' WHERE id = $1`, [ids.member]);
    await page.reload();
    await expect(row().locator('.flag', { hasText: /paused|stopped/ })).toHaveCount(0);

    // Paused again, then let speak again by hand: both marks are cleared.
    await row().getByRole('button', { name: 'Pause this member for a day: nothing taken down' }).click();
    await expect(row().locator('.flag', { hasText: 'paused until' })).toHaveCount(1);
    await row().getByRole('button', { name: 'Let them speak again' }).click();
    await expect(page.locator('p.warn[role="status"]')).toContainText('They can speak again');
    const after = (await db().query<{ muted_at: Date | null; muted_until: Date | null }>(`SELECT muted_at, muted_until FROM room_members WHERE id = $1`, [ids.member])).rows[0];
    expect(after).toEqual({ muted_at: null, muted_until: null });
  });

  test('marks a member as a maintainer and takes the mark off; the room\u2019s own data never carries it', async ({ page, request }) => {
    await page.goto('/editor/room');
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Enter' }).click();
    await expect(page).toHaveURL(/\/editor\/room$/);

    const row = () => page.locator(`#m-${ids.message}`);
    await row().getByRole('button', { name: 'Mark as a maintainer' }).click();
    await expect(page.locator('p.warn[role="status"]')).toContainText('Marked as a maintainer');
    await expect(row().locator('.flag', { hasText: 'maintainer' })).toHaveCount(1);
    expect((await db().query<{ on: boolean }>(`SELECT maintainer_at IS NOT NULL AS on FROM room_members WHERE id = $1`, [ids.member])).rows[0].on).toBe(true);

    // What a card is sent about each line names no maintainer.
    const entered = await (await request.post('/api/room/enter', { data: {} })).json();
    // Every line carries only the public fields, whichever lines the latest page holds (other specs fill the room too).
    expect(entered.ok).toBe(true);
    expect(entered.messages.length).toBeGreaterThan(0);
    // 'agent' is public on purpose: the card names an AI on its own by it (2026-10-22). The maintainer mark is not in this list.
    const fields = new Set(['id', 'kind', 'name', 'model', 'text', 'at', 'mine', 'pair', 'resident', 'agent', 'about', 'answers']);
    for (const m of entered.messages as Record<string, unknown>[]) expect(Object.keys(m).filter((k) => !fields.has(k)), String(m.id)).toEqual([]);

    await row().getByRole('button', { name: 'No longer a maintainer' }).click();
    await expect(page.locator('p.warn[role="status"]')).toContainText('No longer marked');
    await expect(row().locator('.flag', { hasText: 'maintainer' })).toHaveCount(0);
    expect((await db().query<{ on: boolean }>(`SELECT maintainer_at IS NOT NULL AS on FROM room_members WHERE id = $1`, [ids.member])).rows[0].on).toBe(false);
  });
});
