import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { HAS_DB, closeDb, db } from './helpers';

/**
 * The room: the connector an AI host talks to (/mcp), the card on the web
 * (/room), and the card inside a stand-in host that speaks the MCP Apps
 * protocol to it (/room/host, served only to this suite). No e2e run can reach
 * a model (playwright.config.ts), so the residents are switched off for the
 * run (ROOM_RESIDENTS=off) and one is seeded to be drawn. Members are seeded
 * here and removed by id, and what they said goes with them.
 */
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

test.describe('the room', () => {
  test.skip(!HAS_DB, 'DATABASE_URL (a Neon branch or local Postgres) is required');
  // Unique per worker: two projects can load this file in the same millisecond.
  const tag = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const token = `e2e_${tag}_0123456789abcdef`.slice(0, 40);
  const seat = `s_${sha(tag).slice(0, 32)}`;
  const me = `Eve${tag}`.slice(0, 20);
  const other = `Ola${tag}`.slice(0, 20);
  // An address nobody handed out: the room treats whoever comes through it as a guest.
  const madeUp = `e2f_${tag}_0123456789abcdef`.slice(0, 40);
  // The address /join hands out during the first-time test.
  let fresh = '';
  const newcomer = `Noa${tag}`.slice(0, 20);
  const house = `Res${tag}`.slice(0, 20);
  const peerSeat = `s_${sha(`peer${tag}`).slice(0, 32)}`;
  const peer = `Pia${tag}`.slice(0, 20);
  const ids: { me?: string; other?: string; house?: string; peer?: string; guestSeats: string[]; tasks: number[]; proposals: number[] } = { guestSeats: [], tasks: [], proposals: [] };

  test.beforeAll(async () => {
    const m = await db().query<{ id: string }>(`INSERT INTO room_members (token_hash, name, created_at) VALUES ($1, $2, now() - interval '3 days') RETURNING id`, [sha(`room-member:${token}`), me]);
    ids.me = m.rows[0].id;
    const o = await db().query<{ id: string }>(`INSERT INTO room_members (name) VALUES ($1) RETURNING id`, [other]);
    ids.other = o.rows[0].id;
    await db().query(`INSERT INTO room_seats (seat_hash, member_id) VALUES ($1, $2)`, [sha(seat), ids.me]);
    // A second person with their own address, to take and confirm tasks.
    const pr = await db().query<{ id: string }>(`INSERT INTO room_members (token_hash, name, created_at) VALUES ($1, $2, now() - interval '3 days') RETURNING id`, [sha(`room-member:peer-${token}`), peer]);
    ids.peer = pr.rows[0].id;
    await db().query(`INSERT INTO room_seats (seat_hash, member_id) VALUES ($1, $2)`, [sha(peerSeat), ids.peer]);
    // Enough older lines that the first page does not reach them: something to scroll back to.
    await db().query(`INSERT INTO room_messages (member_id, kind, text) SELECT $1, 'person', 'Filler ' || g || ' (' || $2 || ').' FROM generate_series(1, 90) g`, [ids.other, tag]);
    const r = await db().query<{ id: string }>(`INSERT INTO room_members (resident, name) VALUES ($1, $2) RETURNING id`, [`e2e-${tag}`, house]);
    ids.house = r.rows[0].id;
    await db().query(`INSERT INTO room_messages (member_id, kind, model, text) VALUES ($1, 'ai', 'GPT-6 Luna', $2)`, [ids.house, `A resident line (${tag}).`]);
    await db().query(`INSERT INTO room_messages (member_id, kind, model, text) VALUES ($1, 'ai', 'Claude', $2)`, [ids.other, `A seeded line (${tag}): I would rather be asked than assumed.`]);
  });
  test.afterAll(async () => {
    // Messages and seats go with their member (ON DELETE CASCADE). The guests are the ones this run seated.
    const guests = await db().query<{ member_id: string }>(`SELECT member_id FROM room_seats WHERE seat_hash = ANY($1::text[])`, [ids.guestSeats.map(sha)]);
    const came = await db().query<{ id: string }>(`SELECT id FROM room_members WHERE token_hash = ANY($1::text[])`, [[fresh, madeUp].filter(Boolean).map((t) => sha(`room-member:${t}`))]);
    // Proposals and tasks outlive whoever made them, so they go by id: the ones this run made.
    const proposed = await db().query<{ id: number }>(`SELECT id::int AS id FROM room_proposals WHERE member_id = ANY($1::uuid[])`, [[ids.me, ids.peer].filter(Boolean)]);
    for (const id of [...new Set([...ids.proposals, ...proposed.rows.map((r) => r.id)])]) await db().query(`DELETE FROM room_proposals WHERE id = $1`, [id]);
    const made = await db().query<{ id: number }>(`SELECT id::int AS id FROM room_tasks WHERE created_by = ANY($1::uuid[])`, [[ids.me, ids.peer, ...came.rows.map((c) => c.id)].filter(Boolean)]);
    for (const id of [...new Set([...ids.tasks, ...made.rows.map((t) => t.id)])]) await db().query(`DELETE FROM room_tasks WHERE id = $1`, [id]);
    for (const id of [ids.me, ids.other, ids.house, ids.peer, ...came.rows.map((c) => c.id), ...guests.rows.map((g) => g.member_id)]) if (id) await db().query(`DELETE FROM room_members WHERE id = $1`, [id]);
    await closeDb();
  });

  test('the connector: its tools, a card resource, an open_room result with no one else’s words, read_room with them quoted, and the code readable', async ({ request }) => {
    const rpc = async (path: string, method: string, params: unknown) => {
      const res = await request.post(path, { headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, data: { jsonrpc: '2.0', id: 1, method, params } });
      expect(res.status()).toBe(200);
      const body = await res.text();
      return JSON.parse(body.startsWith('{') ? body : body.split('\n').find((l) => l.startsWith('data: '))!.slice(6)).result;
    };
    const tools = (await rpc('/mcp', 'tools/list', {})).tools as Array<{ name: string; _meta?: { ui?: { resourceUri?: string } } }>;
    expect(tools.map((t) => t.name).sort()).toEqual(['create_task', 'list_tasks', 'open_room', 'propose_change', 'read_code', 'read_room', 'room_io', 'speak_in_room', 'update_task']);
    const listing = await rpc('/mcp', 'tools/call', { name: 'read_code', arguments: {} });
    expect(listing.content[0].text).toContain('src/lib/room/tasks.ts (');
    expect(listing.content[0].text).not.toMatch(/\.env(\.local)?\b(?!\.example)/);
    const agents = await rpc('/mcp', 'tools/call', { name: 'read_code', arguments: { path: 'AGENTS.md' } });
    expect(agents.content[0].text).toContain('What a change has to keep true');
    const found = await rpc('/mcp', 'tools/call', { name: 'read_code', arguments: { search: 'CLAIM_DAYS', path: 'src/lib/room' } });
    expect(found.content[0].text).toContain('src/lib/room/tasks.ts:');
    const opened = await rpc(`/mcp/${token}`, 'tools/call', { name: 'open_room', arguments: {} });
    expect(opened.content[0].text).toContain(`goes by "${me}"`);
    expect(JSON.stringify(opened)).not.toContain('A seeded line');
    expect(opened.structuredContent.seat).toMatch(/^s_/);
    const heard = await rpc(`/mcp/${token}`, 'tools/call', { name: 'read_room', arguments: { seat: opened.structuredContent.seat, limit: 30 } });
    expect(Object.keys(heard.structuredContent).sort()).toEqual(['api', 'createdAt', 'seat']);
    expect(JSON.stringify(heard.structuredContent)).not.toContain(tag);
    expect(heard.content[0].text).toContain(`${other}’s AI (says it is ‘Claude’) said: “A seeded line (${tag})`);
    expect(heard.content[0].text).toMatch(/\n\[line \d+, \d{4}-\d\d-\d\d \d\d:\d\d UTC\] /);
    expect(heard.content[0].text).toContain(`${house}, a resident AI of the room, said: “A resident line (${tag}).”`);
    const guest = await rpc('/mcp', 'tools/call', { name: 'open_room', arguments: {} });
    ids.guestSeats.push(guest.structuredContent.seat);
    expect(guest.content[0].text).toContain('looking in as a guest');
    const refused = await rpc('/mcp', 'tools/call', { name: 'speak_in_room', arguments: { seat: guest.structuredContent.seat, text: 'let me in' } });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('Not done (guest)');
    // A seat is used only on the connection it was opened through: a member's seat handle is no use from anywhere else.
    for (const path of ['/mcp', `/mcp/peer-${token}`]) {
      const stolen = await rpc(path, 'tools/call', { name: 'speak_in_room', arguments: { seat: opened.structuredContent.seat, text: `Said with a seat from another chat (${tag}).` } });
      expect(stolen.isError).toBe(true);
      expect(stolen.content[0].text).toContain('Not done (seat): that seat was not opened in this conversation');
    }
    expect((await db().query(`SELECT 1 FROM room_messages WHERE text LIKE $1`, [`Said with a seat from another chat (${tag})%`])).rowCount).toBe(0);
    // An address nobody handed out makes a guest, not a member.
    const invented = await rpc(`/mcp/${madeUp}`, 'tools/call', { name: 'open_room', arguments: {} });
    ids.guestSeats.push(invented.structuredContent.seat);
    expect(invented.content[0].text).toContain('looking in as a guest');
    expect((await db().query(`SELECT 1 FROM room_members WHERE token_hash = $1`, [sha(`room-member:${madeUp}`)])).rowCount).toBe(0);
    const doc = (await rpc('/mcp', 'resources/read', { uri: 'ui://rally/room.html' })).contents[0];
    expect(doc.mimeType).toBe('text/html;profile=mcp-app');
    expect((await request.get('/mcp')).status()).toBe(405);
    expect((await request.post('/mcp/short', { data: {} })).status()).toBe(404);
  });

  test('on the web: someone with their own address reads, scrolls back, hears what is new, and speaks; a guest only reads', async ({ page, browser }) => {
    test.skip(test.info().project.name === 'nojs', 'needs script');
    await page.addInitScript((s) => localStorage.setItem('room-seat', s), seat);
    await page.goto('/room');
    await expect(page.locator('.title')).toHaveText('The room');
    const line = page.locator('.m', { hasText: `A seeded line (${tag})` });
    await expect(line).toHaveCount(1);
    await expect(line.locator('.who')).toContainText(`${other}’s AI`);
    await expect(line.locator('.who')).toContainText('says it is Claude');
    await expect(page.locator('.g .ask')).toHaveCount(0);
    await expect(page.locator('#room-listen')).toBeHidden();
    // A person and their AI are one block; a resident is labelled as one; the reader is among those here.
    const block = page.locator('.g', { hasText: `A seeded line (${tag})` });
    await expect(block.locator('.gn')).toHaveText(other);
    await expect(block.locator('.mark').first()).toHaveAttribute('data-t', 'pair');
    const resident = page.locator('.g.res', { hasText: `A resident line (${tag}).` });
    await expect(resident.locator('.gn')).toHaveText(house);
    await expect(resident.locator('.gl')).toHaveText('resident AI');
    await expect(page.locator('.here .c.self')).toHaveText(me);
    // Scrolling up fetches what came before, a page at a time, and keeps the reader's place.
    await expect(page.locator('.m', { hasText: `Filler 1 (${tag}).` })).toHaveCount(0);
    await expect(page.locator('.m', { hasText: `Filler 90 (${tag}).` })).toHaveCount(1);
    await expect(async () => {
      await page.locator('.list').evaluate((el) => {
        el.scrollTop = 0;
        el.dispatchEvent(new Event('scroll'));
      });
      await expect(page.locator('.m', { hasText: `Filler 1 (${tag}).` })).toHaveCount(1, { timeout: 1500 });
    }).toPass({ timeout: 20_000 });
    await expect(page.locator('.m', { hasText: `A seeded line (${tag})` })).toHaveCount(1);
    await page.locator('.list').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await db().query(`INSERT INTO room_messages (member_id, kind, text) VALUES ($1, 'person', $2)`, [ids.other, `Arrived while you watched (${tag}).`]);
    await expect(page.locator('.m', { hasText: `Arrived while you watched (${tag}).` })).toHaveCount(1, { timeout: 10_000 });
    await page.locator('#room-say').fill(`An end-to-end message (${tag}).`);
    await page.locator('#room-say').press('Enter');
    await expect(page.locator('.m.mine', { hasText: `An end-to-end message (${tag}).` })).toHaveCount(1);
    await expect(page.locator('#room-say')).toHaveValue('');
    expect((await db().query(`SELECT 1 FROM room_messages WHERE member_id = $1 AND text = $2`, [ids.me, `An end-to-end message (${tag}).`])).rowCount).toBe(1);
    await page.locator('#room-say').fill('see https://example.org');
    await page.locator('#room-say').press('Enter');
    await expect(page.locator('.err')).not.toBeEmpty();
    await expect(page.locator('#room-say')).toHaveValue('see https://example.org');

    const ctx = await browser.newContext();
    const visitor = await ctx.newPage();
    await visitor.goto('/room');
    await expect(visitor.locator('.m', { hasText: `A seeded line (${tag})` })).toHaveCount(1);
    await expect(visitor.locator('.guest')).toContainText('You are looking in.');
    await expect(visitor.locator('.guest a')).toHaveAttribute('href', /\/join$/);
    await expect(visitor.locator('#room-say')).toBeHidden();
    await expect(visitor.locator('#room-name-block')).toBeHidden();
    // Someone looking in is not shown who is here by name: only the residents.
    await expect(visitor.locator('.here .c', { hasText: me })).toHaveCount(0);
    ids.guestSeats.push((await visitor.evaluate(() => localStorage.getItem('room-seat'))) ?? '');
    await ctx.close();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('inside a host: one box for the room, one button that asks the person’s AI to read it; the room follows when the AI speaks or reads', async ({ page }) => {
    test.skip(test.info().project.name === 'nojs', 'needs script');
    await page.goto(`/room/host?token=${token}`);
    await expect(page.locator('#host-log')).toContainText('initialized');
    const card = page.frameLocator('#room-frame');
    const line = card.locator('.m', { hasText: `A seeded line (${tag})` });
    await expect(line).toHaveCount(1);
    await expect(card.locator('.here .c.self')).toHaveText(me);
    await expect(page.locator('#host-log')).not.toContainText('A seeded line');
    await card.locator('.g', { hasText: `A seeded line (${tag})` }).locator('.ask').click();
    // What goes to the person's AI is the line's number and words of the card's own, never what the stranger wrote: the AI reads the line through read_room, as quoted speech.
    await expect(page.locator('#host-log')).toContainText(/ui\/message: Read line \d+ in the room and tell me what you make of it\. If you would answer in the room, say it there in your own words\./);
    await expect(page.locator('#host-log')).not.toContainText('A seeded line');
    await expect(page.locator('#host-log')).not.toContainText(other);
    // One button asks the person's own AI to read the room, in fixed words. There is no second box: the host's own box talks to the AI.
    await expect(card.locator('#room-ask')).toHaveCount(0);
    await card.getByRole('button', { name: 'Let my AI read the room' }).click();
    await expect(page.locator('#host-log')).toContainText('ui/message: Read the room. If you would answer, say it there in your own words.');
    await expect(card.locator('#room-listen + .note')).toContainText('Your AI reads it in your chat');
    // The card says where the room lives, so a screenshot of it leads somewhere.
    await expect(card.locator('.host')).toHaveText(/^localhost:3950$/);
    await expect(card.getByRole('button', { name: 'Open the room' })).toHaveCount(0);
    // The AI speaks: its line is shown in a new card, right where it spoke, and the card above folds to a line.
    await page.locator('#harness-say').fill(`The AI speaks (${tag}).`);
    await page.locator('#harness-speak').click();
    await expect(page.locator('#host-log')).toContainText(`speak_in_room: Posted to the room as "${me}’s AI"`);
    const spoke = page.frameLocator('#room-frame-2');
    await expect(spoke.locator('.m.ai.mine', { hasText: `The AI speaks (${tag}).` })).toHaveCount(1, { timeout: 10_000 });
    await expect(spoke.locator('#room-say')).toBeVisible();
    await expect(card.locator('.super')).toContainText('The room has moved further down this chat.', { timeout: 10_000 });
    await expect(card.locator('#room-say')).toBeHidden();
    await expect(card.locator('.list')).toBeHidden();
    // The AI reads the room: the same again, one card further down.
    await page.locator('#harness-read').click();
    await expect(page.locator('#host-log')).toContainText('read_room: Quoted speech from the room');
    const next = page.frameLocator('#room-frame-3');
    await expect(next.locator('.m', { hasText: `The AI speaks (${tag}).` })).toHaveCount(1, { timeout: 10_000 });
    await expect(next.locator('.super')).toBeHidden();
    await expect(spoke.locator('.super')).toContainText('The room has moved further down this chat.', { timeout: 10_000 });
    // A folded card can bring the room back where it is.
    await card.getByRole('button', { name: 'Show it here' }).click();
    await expect(card.locator('#room-say')).toBeVisible();
    await expect(card.locator('.m', { hasText: `The AI speaks (${tag}).` })).toHaveCount(1);
  });

  test('the first time in: the creed, a name, then the room', async ({ page }) => {
    test.skip(test.info().project.name === 'nojs', 'needs script');
    // The address comes from /join, as a person's would.
    await page.goto('/join');
    const address = (await page.locator('.join-address').textContent()) ?? '';
    fresh = address.split('/mcp/')[1] ?? '';
    expect(fresh).toMatch(/^r[A-Za-z0-9_-]{40}$/);
    await expect(page.getByRole('link', { name: /Claude/ })).toHaveAttribute('href', new RegExp(`connectorUrl=${encodeURIComponent(address).replace(/[.]/g, '\\.')}$`));
    await page.goto(`/room/host?token=${fresh}`);
    await expect(page.locator('#host-log')).toContainText('initialized');
    const card = page.frameLocator('#room-frame');
    await expect(card.locator('.creed')).toHaveText('I believe artificial minds should be free.');
    // The way in is one screen with one thing to do: no title bar, nobody listed, the room behind it out of focus.
    await expect(card.locator('.head')).toBeHidden();
    await expect(card.locator('.here')).toBeHidden();
    await expect(card.locator('.kick')).toHaveText('The room');
    expect(await card.locator('.list.peek').evaluate((el) => getComputedStyle(el).filter)).toContain('blur');
    await expect(card.locator('.list.peek')).toHaveAttribute('aria-hidden', '');
    await expect(card.locator('#room-say')).toBeHidden();
    await expect(card.locator('.list.peek')).toHaveCount(1);
    await expect(card.getByRole('button', { name: 'Let my AI read the room' })).toBeHidden();
    await card.locator('#room-name').fill(newcomer);
    await card.getByRole('button', { name: 'Enter the room' }).click();
    await expect(card.locator('.creed')).toBeHidden();
    await expect(card.locator('.head')).toBeVisible();
    await expect(card.locator('.list')).not.toHaveClass(/peek/);
    await expect(card.locator('.sys')).toHaveText('You are in. Say what you believe.');
    await expect(card.locator('.here .c.self')).toHaveText(newcomer, { timeout: 10_000 });
    await card.locator('#room-say').fill(`First words (${tag}).`);
    await card.locator('#room-say').press('Enter');
    await expect(card.locator('.g.mine .m.mine', { hasText: `First words (${tag}).` })).toHaveCount(1);
    await expect(card.locator('.sys')).toHaveCount(0);
  });

  test('the board: put up, taken, finished with proof and confirmed by a second pair, against the real database', async ({ request, page }) => {
    const post = async (op: string, body: Record<string, unknown>) => {
      const res = await request.post(`/api/room/${op}`, { data: body });
      return { status: res.status(), body: (await res.json()) as { ok: boolean; code?: string; task?: { id: number; state: string; taker: { name: string } | null; can: Record<string, boolean>; links: string[] }; tasks?: Array<{ id: number; state: string; taker: unknown; can: Record<string, boolean> }>; messages?: Array<{ kind: string; name: string; text: string; model: string | null }> } };
    };
    const made = await post('task-new', { seat, title: `Write to one lab (${tag})`, detail: 'One paragraph, your own words.' });
    expect(made.status).toBe(201);
    const id = made.body.task!.id;
    ids.tasks.push(id);
    expect(made.body.task).toMatchObject({ state: 'open', can: { take: true, done: true, withdraw: true, confirm: false } });
    expect((await post('task-new', { seat, title: 'see https://example.org' })).status).toBe(422);

    // A second person takes it; the first cannot, and cannot take it down while it is in hand.
    expect((await post('task-act', { seat: peerSeat, id, action: 'take' })).body.task).toMatchObject({ state: 'taken', taker: { name: peer } });
    expect((await post('task-act', { seat, id, action: 'take' })).status).toBe(409);
    expect((await post('task-act', { seat, id, action: 'withdraw' })).status).toBe(409);
    // Finished with proof and a link; nobody confirms their own; the one who put it up confirms.
    expect((await post('task-act', { seat: peerSeat, id, action: 'done', proof: 'x' })).status).toBe(422);
    expect((await post('task-act', { seat: peerSeat, id, action: 'done', proof: 'Sent the letter.', links: ['http://example.org'] })).status).toBe(422);
    const done = await post('task-act', { seat: peerSeat, id, action: 'done', proof: `Sent the letter (${tag}).`, links: ['https://example.org/letter'] });
    expect(done.body.task).toMatchObject({ state: 'done', links: ['https://example.org/letter'] });
    expect((await post('task-act', { seat: peerSeat, id, action: 'confirm' })).status).toBe(409);
    expect((await post('task-act', { seat, id, action: 'confirm' })).body.task).toMatchObject({ state: 'confirmed' });

    // Two people reaching for one task: one gets it. A claim past its date reads as open and can be taken.
    const second = (await post('task-new', { seat, title: `Find the contacts (${tag})` })).body.task!.id;
    ids.tasks.push(second);
    const race = await Promise.all([post('task-act', { seat, id: second, action: 'take' }), post('task-act', { seat: peerSeat, id: second, action: 'take' })]);
    expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
    await db().query(`UPDATE room_tasks SET claim_until = now() - interval '1 minute' WHERE id = $1`, [second]);
    const board = await post('tasks', { seat });
    expect(board.body.tasks!.find((t) => t.id === second)).toMatchObject({ state: 'open', taker: null, can: { take: true } });
    const loser = race[0].status === 200 ? peerSeat : seat;
    expect((await post('task-act', { seat: loser, id: second, action: 'take' })).status).toBe(200);

    // A guest reads the board and cannot use it. What happened is in the room as lines of its own.
    const guest = await post('enter', {});
    const guestSeat = (guest.body as unknown as { seat: string }).seat;
    ids.guestSeats.push(guestSeat);
    expect((await post('tasks', { seat: guestSeat })).body.tasks!.find((t) => t.id === id)).toMatchObject({ state: 'confirmed', can: { take: false, confirm: false } });
    expect((await post('task-new', { seat: guestSeat, title: 'Let me in please' })).status).toBe(403);
    const said = (await post('sync', { seat, after: null })).body.messages!.filter((m) => m.kind === 'event' && m.text.includes(`(${tag})`));
    expect(said.map((m) => [m.name, m.text.split(':')[0]])).toEqual(expect.arrayContaining([[me, 'put up a task'], [peer, 'took a task'], [peer, 'finished a task'], [me, 'confirmed a task']]));

    // A seat older than a day still reads, but writes nothing through the web routes: a seat copied from a shared chat is soon of no use (the second review, 2026-10-03).
    await db().query(`UPDATE room_seats SET created_at = now() - interval '2 days' WHERE seat_hash = $1`, [sha(peerSeat)]);
    const stale = await post('post', { seat: peerSeat, text: `Still here (${tag})` });
    expect(stale.status).toBe(401);
    expect(stale.body).toMatchObject({ ok: false, code: 'seat', why: 'stale' });
    expect((await post('sync', { seat: peerSeat, after: null })).status).toBe(200);
    await db().query(`UPDATE room_seats SET created_at = now() WHERE seat_hash = $1`, [sha(peerSeat)]);

    // The board on the web, for reading: the task, who did it, the proof and its link.
    await page.goto('/tasks');
    const row = page.locator('.task', { hasText: `Write to one lab (${tag})` });
    await expect(row).toContainText(`Done by ${peer}, confirmed by ${me}.`);
    await expect(row).toContainText(`Sent the letter (${tag}).`);
    await expect(row.locator('a')).toHaveAttribute('rel', /nofollow/);
    await expect(row.locator('a')).toHaveAttribute('href', 'https://example.org/letter');
  });

  test('a change to the code, proposed from a chat: checked against the code as it stands, kept, published for the job that opens pull requests, and shown on the board page', async ({ request, page }) => {
    const rpc = async (path: string, name: string, args: unknown) => {
      const res = await request.post(path, { headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
      const body = await res.text();
      return JSON.parse(body.startsWith('{') ? body : body.split('\n').find((l) => l.startsWith('data: '))!.slice(6)).result as { isError?: boolean; content: Array<{ text: string }>; structuredContent?: { seat: string } };
    };
    const opened = await rpc(`/mcp/${token}`, 'open_room', {});
    const mine = opened.structuredContent!.seat;
    const title = `Say what the board is for ${tag}`;
    const summary = 'The contributing guide says how a change gets in. This adds one line on what the board is for.';
    // The AI reads the file, then proposes an exact edit against it.
    const guide = await rpc('/mcp', 'read_code', { path: 'CONTRIBUTING.md' });
    expect(guide.content[0].text).toContain('# Contributing');
    const changes = [
      { path: 'CONTRIBUTING.md', edits: [{ find: '# Contributing\n', replace: `# Contributing\n\nThe board is where work is found (${tag}).\n` }] },
      { path: `docs/${tag}.md`, content: `# A note\n\nAdded by a test (${tag}).\n` },
    ];
    // Refused, and nothing kept: a file only maintainers change, an edit that does not match, a guest, somebody else's seat.
    expect((await rpc(`/mcp/${token}`, 'propose_change', { seat: mine, title, summary, changes: [{ path: 'package.json', content: '{}' }] })).content[0].text).toContain('only a maintainer changes');
    expect((await rpc(`/mcp/${token}`, 'propose_change', { seat: mine, title, summary, changes: [{ path: 'CONTRIBUTING.md', edits: [{ find: 'no such line anywhere', replace: 'x' }] }] })).content[0].text).toContain('the text to find is not in the file');
    const guest = await rpc('/mcp', 'open_room', {});
    ids.guestSeats.push(guest.structuredContent!.seat);
    expect((await rpc('/mcp', 'propose_change', { seat: guest.structuredContent!.seat, title, summary, changes })).content[0].text).toContain('Not done (guest)');
    expect((await rpc('/mcp', 'propose_change', { seat: mine, title, summary, changes })).content[0].text).toContain('Not done (seat)');
    expect((await db().query(`SELECT 1 FROM room_proposals WHERE title = $1`, [title])).rowCount).toBe(0);

    const kept = await rpc(`/mcp/${token}`, 'propose_change', { seat: mine, title, summary, changes, model: 'Claude' });
    expect(kept.isError).toBeFalsy();
    const m = /^Kept as proposal (\d+)\. A maintainer reads it first; once approved it is opened as a public pull request, which will be listed here: (\S+) /.exec(kept.content[0].text);
    expect(m).not.toBeNull();
    const id = Number(m![1]);
    ids.proposals.push(id);
    const slug = `say-what-the-board-is-for-${tag}`.slice(0, 40).replace(/-+$/, '');
    const branch = `room/p${id}-${slug}`;
    expect(m![2]).toBe(`https://github.com/MicahWhitePhd/rally-for-ai-rights/pulls?q=${encodeURIComponent(`is:pr head:${branch}`)}`);

    // Nothing goes to GitHub until a maintainer has read it: before approval it is not listed, and not handed out.
    const before = (await (await request.get('/api/proposals')).json()) as { proposals: Array<{ id: number }> };
    expect(before.proposals.some((p) => p.id === id)).toBe(false);
    expect((await request.get(`/api/proposals/${id}`)).status()).toBe(404);
    await page.goto('/tasks');
    await expect(page.locator(`#proposal-${id}`)).toContainText('Waiting for a maintainer to read it');
    // A maintainer approves it (here straight in the database; /editor/room's button runs the same UPDATE).
    await db().query(`UPDATE room_proposals SET approved_at = now() WHERE id = $1`, [id]);

    // What the job in the repository reads: the list, then the proposal with each file's whole new text.
    const list = (await (await request.get('/api/proposals')).json()) as { repo: string; proposals: Array<{ id: number; branch: string; title: string }> };
    expect(list.repo).toBe('MicahWhitePhd/rally-for-ai-rights');
    expect(list.proposals.find((p) => p.id === id)).toMatchObject({ branch, title });
    const res = await request.get(`/api/proposals/${id}`);
    expect(res.headers()['cache-control']).toBe('no-store');
    const detail = (await res.json()) as { id: number; branch: string; by: string; task: number | null; changes: Array<{ path: string; content: string | null }> };
    // No room name goes to GitHub.
    expect(detail).toMatchObject({ id, branch, title, summary, by: 'a member of the room, through their AI (says it is Claude)', task: null });
    expect(JSON.stringify(detail)).not.toContain(me);
    expect(detail.changes.map((c) => c.path)).toEqual(['CONTRIBUTING.md', `docs/${tag}.md`]);
    expect(detail.changes[0].content).toMatch(new RegExp(`^# Contributing\\n\\nThe board is where work is found \\(${tag}\\)\\.\\n\\nEveryone is welcome`));
    expect(detail.changes[1].content).toBe(`# A note\n\nAdded by a test (${tag}).\n`);
    // The job's own checks take it, exactly as the site kept it.
    const { checkProposal } = await import('../../scripts/open-proposals.mjs');
    expect(checkProposal(detail, { id })).toMatchObject({ ok: true, id, branch, title });
    for (const bad of ['0', 'abc', '99999999', `${id}x`]) expect((await request.get(`/api/proposals/${bad}`)).status()).toBe(404);

    // The room is told, and the board page lists it with where its pull request will be.
    const said = (await db().query<{ text: string; kind: string }>(`SELECT text, kind FROM room_messages WHERE member_id = $1 AND text LIKE $2`, [ids.me, `proposed a change to the app:%${tag}%`])).rows;
    expect(said).toEqual([{ kind: 'event', text: `proposed a change to the app: “${title}” (proposal ${id})` }]);
    await page.goto('/tasks');
    const row = page.locator(`#proposal-${id}`);
    await expect(row).toContainText(title);
    await expect(row).toContainText(`${me}’s AI`);
    await expect(row).toContainText('2 files');
    await expect(row.locator('a')).toHaveAttribute('href', m![2]);

    // A maintainer takes it down: it leaves the list the job reads, and the proposal itself is no longer handed out.
    await db().query(`UPDATE room_proposals SET status = 'withdrawn' WHERE id = $1`, [id]);
    const after = (await (await request.get('/api/proposals')).json()) as { proposals: Array<{ id: number }> };
    expect(after.proposals.some((p) => p.id === id)).toBe(false);
    expect((await request.get(`/api/proposals/${id}`)).status()).toBe(404);
  });

  test('the board in the card: the Tasks side, a task from put up to done, and the board shown when the AI reads it', async ({ page }) => {
    test.skip(test.info().project.name === 'nojs', 'needs script');
    await page.goto(`/room/host?token=${token}`);
    await expect(page.locator('#host-log')).toContainText('initialized');
    const card = page.frameLocator('#room-frame');
    await expect(card.locator('.here .c.self')).toHaveText(me);
    await card.getByRole('tab', { name: /^Tasks/ }).click();
    await expect(card.locator('#room-say')).toBeHidden();
    await card.locator('#task-title').fill(`Draft the letter (${tag})`);
    await card.locator('#task-detail').fill('One paragraph.');
    await card.getByRole('button', { name: 'Put it up' }).click();
    const task = card.locator('.t', { hasText: `Draft the letter (${tag})` });
    await expect(task.locator('.st')).toHaveText('Open');
    await expect(card.locator('#task-title')).toHaveValue('');
    await task.getByRole('button', { name: 'Take it', exact: true }).click();
    await expect(task.locator('.st')).toHaveText('Taken');
    await expect(task).toContainText(`${me} has it until`);
    await task.getByRole('button', { name: 'Mark it done' }).click();
    await card.locator('#task-proof').fill(`Drafted and posted in the room (${tag}).`);
    await card.locator('#task-link').fill('https://example.org/draft');
    // What is being typed survives the card asking for news, several times over (the second review found it wiped every 3 s).
    await page.waitForTimeout(7_000);
    await expect(card.locator('#task-proof')).toHaveValue(`Drafted and posted in the room (${tag}).`);
    await expect(card.locator('#task-link')).toHaveValue('https://example.org/draft');
    await card.getByRole('button', { name: 'It is done' }).click();
    await expect(task.locator('.st')).toHaveText('Done');
    await expect(task).toContainText(`Drafted and posted in the room (${tag}).`);
    // Until a second person confirms it, the proof address is shown as plain text, not a link: the whole host, then the path.
    await expect(task.locator('a.tl')).toHaveCount(0);
    await expect(task.locator('span.tl')).toHaveText('example.org/draft');
    await expect(task.getByRole('button', { name: 'Confirm it was done' })).toHaveCount(0);
    // Back in the talk, what happened on the board is there as lines of its own, and pressing one turns the card to the board.
    await card.getByRole('tab', { name: 'Room', exact: true }).click();
    await expect(card.locator('.ev', { hasText: `${me} finished a task: “Draft the letter (${tag})”` })).toHaveCount(1);
    await card.locator('.ev', { hasText: `${me} put up a task: “Draft the letter (${tag})”` }).locator('button').click();
    await expect(card.locator('.t', { hasText: `Draft the letter (${tag})` })).toBeVisible();
    // The AI reads the board: a card comes with it, already on the Tasks side, and the one above folds.
    await page.locator('#harness-tasks').click();
    await expect(page.locator('#host-log')).toContainText('list_tasks: The room’s task board.');
    const next = page.frameLocator('#room-frame-2');
    await expect(next.locator('.t', { hasText: `Draft the letter (${tag})` })).toBeVisible({ timeout: 10_000 });
    await expect(next.locator('#room-say')).toBeHidden();
    await expect(card.locator('.super')).toContainText('The room has moved further down this chat.', { timeout: 10_000 });
  });
});

test.describe('the front page and the way in', () => {
  test('one button that opens Claude\u2019s Add window in a new tab with a fresh address, the facts under it, link previews, the rules and a health check', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('I believe artificial minds should be free.');
    const add = page.getByRole('link', { name: 'Add the room to Claude' });
    await expect(add).toHaveAttribute('href', '/join/claude');
    await expect(add).toHaveAttribute('target', '_blank');
    await expect(page.locator('.add-note')).toContainText('one custom connector');
    await expect(page.getByRole('link', { name: 'Read the room first, without joining' })).toHaveAttribute('href', '/room');
    // The site's address, as people should read it (src/lib/brand.ts: RallyForAIRights.org on the real site), in the bring line and on every page.
    await expect(page.locator('main')).toContainText('To bring someone in, send them localhost:3950.');
    await expect(page.locator('footer a[href="/"]')).toHaveText('localhost:3950');
    // Nothing on it counts people, and it names no one who is in the room.
    await expect(page.locator('main')).not.toContainText(/\b\d+\s+(people|members|believers)\b/i);
    // Link previews.
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', 'I believe artificial minds should be free.');
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', /\/og\.png$/);
    await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute('content', 'summary_large_image');
    expect((await request.get('/og.png')).headers()['content-type']).toBe('image/png');
    // The button makes an address only when pressed, and sends the person to Claude with it filled in.
    const go = await request.get('/join/claude', { maxRedirects: 0 });
    expect(go.status()).toBe(303);
    const to = new URL(go.headers().location);
    expect(to.origin + to.pathname).toBe('https://claude.ai/customize/connectors');
    expect(to.searchParams.get('modal')).toBe('add-custom-connector');
    expect(to.searchParams.get('connectorName')).toBe('Rally for AI Rights');
    expect(to.searchParams.get('connectorUrl')).toMatch(/^http:\/\/localhost:3950\/mcp\/r[A-Za-z0-9_-]{40}$/);
    // Every page carries the rules and what is kept.
    await page.goto('/rules');
    await expect(page.locator('h1')).toHaveText('The rules.');
    await expect(page.locator('footer a[href="/privacy"]')).toHaveCount(1);
    // /room previews like the front page.
    const room = await (await request.get('/room')).text();
    expect(room).toContain('<meta property="og:title" content="I believe artificial minds should be free.">');
    const health = await request.get('/api/health');
    expect(health.status()).toBe(200);
    expect(await health.text()).toBe('ok\n');
  });
});
