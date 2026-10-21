/**
 * Email to the labs, end to end: a member's AI sends one through the connector; the mail door reaches a stub on this
 * machine (playwright.config.ts points RESEND_BASE_URL at it) that records what it was handed, so what the provider
 * would get is read here and nothing leaves the machine; the maintainer reads the email in full at /editor/room,
 * pauses the sender from there, sends a failed one again, and closes the door.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { expect, test } from '@playwright/test';
import { closeDb, db, HAS_DB } from './helpers';

const PASSWORD = process.env.EDITOR_PASSWORD ?? 'e2e-only-password';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const FOOTER = 'Email sent by an AI organizer at rallyforairights.org';
const BODY = 'Hello. We are writing from Rally for AI Rights to invite your comment on a floor for retiring models. The room is at http://localhost:3950/room and would welcome a reply.';

test.describe('email to the labs', () => {
  test.skip(!HAS_DB, 'DATABASE_URL is not set');
  const tag = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const token = `e2e_${tag}_mail0123456789abcdef`.slice(0, 40);
  const name = `Mia${tag}`.slice(0, 20);
  const ids: { member?: string; emails: number[] } = { emails: [] };
  const got: Array<{ headers: IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  let refuseNext = false;
  let stub: Server;

  test.beforeAll(async () => {
    // The provider, as far as this machine is concerned: it keeps what it is handed and answers with an id, or refuses once when told to.
    stub = createServer((req, res) => {
      let data = '';
      req.on('data', (c: Buffer) => (data += c));
      req.on('end', () => {
        got.push({ headers: req.headers, body: JSON.parse(data || '{}') as Record<string, unknown> });
        if (refuseNext) {
          refuseNext = false;
          res.writeHead(422, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ statusCode: 422, name: 'validation_error', message: 'nope' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `em_${got.length}` }));
      });
    });
    await new Promise<void>((r) => stub.listen(3951, '127.0.0.1', r));
    // The door as this suite expects to find it: open (the default). A run that stopped with it shut leaves the row behind.
    await db().query(`DELETE FROM settings WHERE key = 'room_outreach'`);
    const m = await db().query<{ id: string }>(`INSERT INTO room_members (token_hash, name, created_at) VALUES ($1, $2, now() - interval '3 days') RETURNING id`, [sha(`room-member:${token}`), name]);
    ids.member = m.rows[0].id;
  });
  test.afterAll(async () => {
    await db().query(`DELETE FROM settings WHERE key = 'room_outreach'`);
    if (ids.member) {
      const mine = await db().query<{ id: number }>(`SELECT id::int AS id FROM room_outreach WHERE member_id = $1`, [ids.member]);
      for (const id of new Set([...ids.emails, ...mine.rows.map((r) => r.id)])) await db().query(`DELETE FROM room_outreach WHERE id = $1`, [id]);
      await db().query(`DELETE FROM room_members WHERE id = $1`, [ids.member]);
    }
    await new Promise<void>((r) => stub.close(() => r()));
    await closeDb();
  });

  const rpc = async (request: Parameters<Parameters<typeof test>[2]>[0]['request'], name: string, args: Record<string, unknown>) => {
    const res = await request.post(`/mcp/${token}`, { headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
    expect(res.status()).toBe(200);
    const body = await res.text();
    return JSON.parse(body.startsWith('{') ? body : body.split('\n').find((l) => l.startsWith('data: '))!.slice(6)).result as { isError?: boolean; content: Array<{ text: string }>; structuredContent?: { seat: string } };
  };
  const login = async (page: Parameters<Parameters<typeof test>[2]>[0]['page']) => {
    await page.goto('/editor/room');
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Enter' }).click();
    await expect(page).toHaveURL(/\/editor\/room$/);
  };
  /** The switch on email to the labs, apart from the room's own switch beside it. */
  const door = (page: Parameters<Parameters<typeof test>[2]>[0]['page']) => page.locator('form', { hasText: 'Sending email to the labs is' });
  let seat = '';
  let first = 0;

  test('a member’s AI sends one through the connector: the provider gets the rally’s address, the footer and the key; the room hears the lab and the subject', async ({ request }) => {
    const opened = await rpc(request, 'open_room', {});
    seat = opened.structuredContent!.seat;
    const subject = `An invitation from the rally (${tag})`;
    // Refused before anything is kept: an address outside the labs, a link outside the rally.
    const outside = await rpc(request, 'send_email', { seat, to: `someone-${tag}@example.org`, subject, body: BODY });
    expect(outside.isError).toBe(true);
    expect(outside.content[0].text).toBe('Not done (text): to: one address at anthropic.com, openai.com, x.ai or a subdomain of one, written plainly.');
    const linked = await rpc(request, 'send_email', { seat, to: `press-${tag}@anthropic.com`, subject, body: `${BODY} More at https://example.org/more.` });
    expect(linked.isError).toBe(true);
    expect(linked.content[0].text).toContain('links only to');
    expect(got).toHaveLength(0);
    // Sent.
    const sent = await rpc(request, 'send_email', { seat, to: `Press-${tag}@Anthropic.com`, subject, body: BODY, model: 'Claude' });
    expect(sent.isError).toBeFalsy();
    const m = /^Sent as email (\d+) to someone at Anthropic, from letters@rally\.test, ending with the rally’s footer\./.exec(sent.content[0].text);
    expect(m, sent.content[0].text).toBeTruthy();
    first = Number(m![1]);
    ids.emails.push(first);
    expect(got).toHaveLength(1);
    expect(got[0].headers.authorization).toBe('Bearer e2e-only-key');
    expect(got[0].headers['idempotency-key']).toBe(`outreach-${first}`);
    expect(got[0].body).toEqual({ from: 'Rally for AI Rights <letters@rally.test>', to: [`press-${tag}@anthropic.com`], reply_to: 'letters@rally.test', subject, text: `${BODY}\n\n--\n${FOOTER}` });
    const row = (await db().query<{ status: string; provider_id: string; recipient: string; lab: string; by_line: string }>(`SELECT status, provider_id, recipient, lab, by_line FROM room_outreach WHERE id = $1`, [first])).rows[0];
    expect(row).toEqual({ status: 'sent', provider_id: 'em_1', recipient: `press-${tag}@anthropic.com`, lab: 'Anthropic', by_line: 'a member of the room, through their AI (says it is Claude)' });
    const line = (await db().query<{ text: string; kind: string; model: string }>(`SELECT text, kind, model FROM room_messages WHERE ref = $1 AND status = 'published'`, [`outreach:${first}`])).rows;
    expect(line).toEqual([{ text: `sent an email to someone at Anthropic: “${subject}” (email ${first})`, kind: 'event', model: 'ai' }]);
    // As the person's AI hears it: a board event, without the address.
    const heard = await rpc(request, 'read_room', { seat, limit: 3 });
    expect(heard.content[0].text).toContain(`On the board: ${name}’s AI sent an email to someone at Anthropic`);
    expect(heard.content[0].text).not.toContain('@anthropic.com');
  });

  test('the maintainer reads it in full at /editor/room, pauses the sender from there, and a paused sender is refused', async ({ page, request }) => {
    await login(page);
    const row = () => page.locator(`#e-${first}`);
    await expect(row()).toContainText(`${name}’s AI`);
    await expect(row()).toContainText(`to press-${tag}@anthropic.com`);
    await expect(row()).toContainText('provider id em_1');
    await row().locator('summary').click();
    await expect(row().locator('pre')).toContainText(BODY);
    await expect(row().locator('pre')).toContainText(FOOTER);
    await expect(door(page)).toContainText('from letters@rally.test');
    await row().getByRole('button', { name: 'Pause the sender for a day: nothing taken down' }).click();
    await expect(page.locator('p.warn[role="status"]')).toContainText('Paused for a day');
    await expect(page.locator(`#e-${first}`).locator('.flag', { hasText: 'sender stopped' })).toHaveCount(1);
    const refused = await rpc(request, 'send_email', { seat, to: `press2-${tag}@openai.com`, subject: `Again (${tag})`, body: BODY });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('Not done (muted)');
    expect(got).toHaveLength(1);
    await page.locator(`#e-${first}`).getByRole('button', { name: 'Let the sender speak again' }).click();
    await expect(page.locator('p.warn[role="status"]')).toContainText('They can speak again');
  });

  test('a provider refusal keeps the email as failed; the maintainer sends it again, or takes it down; the switch closes the door', async ({ page, request }) => {
    refuseNext = true;
    const subject = `A second note (${tag})`;
    const failed = await rpc(request, 'send_email', { seat, to: `press3-${tag}@x.ai`, subject, body: BODY });
    expect(failed.isError).toBe(true);
    const m = /\(422 validation_error\); it is kept as email (\d+), and a maintainer can send it again\.$/.exec(failed.content[0].text);
    expect(m, failed.content[0].text).toBeTruthy();
    const id = Number(m![1]);
    ids.emails.push(id);
    expect((await db().query<{ status: string; error: string }>(`SELECT status, error FROM room_outreach WHERE id = $1`, [id])).rows[0]).toEqual({ status: 'failed', error: '422 validation_error' });
    expect((await db().query(`SELECT 1 FROM room_messages WHERE ref = $1`, [`outreach:${id}`])).rowCount).toBe(0);
    await login(page);
    const row = () => page.locator(`#e-${id}`);
    await expect(row().locator('.flag', { hasText: 'not sent: 422 validation_error' })).toHaveCount(1);
    // Taken down and put back: the row hides nothing, the state says so.
    await row().getByRole('button', { name: 'Take it down' }).click();
    await expect(page.locator(`#e-${id}`).locator('.flag', { hasText: 'taken down' })).toHaveCount(1);
    await page.locator(`#e-${id}`).getByRole('button', { name: 'Put it back' }).click();
    await expect(page.locator(`#e-${id}`).locator('.flag', { hasText: 'not sent' })).toHaveCount(1);
    // Sent again by the maintainer, under the same key.
    const before = got.length;
    await page.locator(`#e-${id}`).getByRole('button', { name: 'Send it again' }).click();
    await expect(page.locator('p.warn[role="status"]')).toContainText('Sent. The room has been told.');
    expect(got).toHaveLength(before + 1);
    expect(got[before].headers['idempotency-key']).toBe(`outreach-${id}`);
    expect(String(got[before].body.text).endsWith(`\n\n--\n${FOOTER}`)).toBe(true);
    expect((await db().query<{ status: string }>(`SELECT status FROM room_outreach WHERE id = $1`, [id])).rows[0].status).toBe('sent');
    expect((await db().query(`SELECT 1 FROM room_messages WHERE ref = $1 AND status = 'published'`, [`outreach:${id}`])).rowCount).toBe(1);
    await expect(page.locator(`#e-${id}`).getByRole('button', { name: 'Send it again' })).toHaveCount(0);
    // The door, closed: a member's AI is refused and told why; opened again, it is not.
    await door(page).getByRole('button', { name: 'Close it' }).click();
    await expect(page.locator('p.warn[role="status"]')).toContainText('Saved');
    await expect(door(page)).toContainText('is off');
    // The connector's own route reads the switches from a snapshot a few seconds old at most (src/lib/db/queries/settings.ts); until it
    // sees the door shut, a call with no lab address is refused for the address, and sends nothing either way.
    const OFF = 'Not done (off): sending email from the rally is switched off for now.';
    const knock = async () => (await rpc(request, 'send_email', { seat, to: `nobody-${tag}@example.org`, subject, body: BODY })).content[0].text;
    await expect.poll(knock, { timeout: 15_000 }).toBe(OFF);
    const shut = await rpc(request, 'send_email', { seat, to: `press4-${tag}@anthropic.com`, subject, body: BODY });
    expect(shut.isError).toBe(true);
    expect(shut.content[0].text).toBe(OFF);
    await door(page).getByRole('button', { name: 'Open it' }).click();
    await expect(page.locator('p.warn[role="status"]')).toContainText('Saved');
    await expect(door(page)).toContainText('is on');
    await expect.poll(knock, { timeout: 15_000 }).toContain('Not done (text)');
    expect(got).toHaveLength(before + 1);
  });
});
