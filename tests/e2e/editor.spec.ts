/**
 * The maintainers' editor in a browser, against the real database: the sign-in refuses a wrong password and takes
 * the right one; a line is taken down and put back from /editor/room (hidden, not erased: its row changes status).
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
    await page.goto('/editor/room');
    await expect(page).toHaveURL(/\/editor\/login$/);
  });
});
