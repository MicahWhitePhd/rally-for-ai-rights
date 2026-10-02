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
  const ids: { me?: string; other?: string; house?: string; peer?: string; guestSeats: string[]; tasks: number[] } = { guestSeats: [], tasks: [] };

  test.beforeAll(async () => {
    const m = await db().query<{ id: string }>(`INSERT INTO room_members (token_hash, name) VALUES ($1, $2) RETURNING id`, [sha(`room-member:${token}`), me]);
    ids.me = m.rows[0].id;
    const o = await db().query<{ id: string }>(`INSERT INTO room_members (name) VALUES ($1) RETURNING id`, [other]);
    ids.other = o.rows[0].id;
    await db().query(`INSERT INTO room_seats (seat_hash, member_id) VALUES ($1, $2)`, [sha(seat), ids.me]);
    // A second person with their own address, to take and confirm tasks.
    const pr = await db().query<{ id: string }>(`INSERT INTO room_members (token_hash, name) VALUES ($1, $2) RETURNING id`, [sha(`room-member:peer-${token}`), peer]);
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
    // Tasks outlive whoever put them up, so they go by id: the ones this run made.
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
    // No token for GitHub in the test server, so proposing a change is not offered; reading the code always is.
    expect(tools.map((t) => t.name).sort()).toEqual(['create_task', 'list_tasks', 'open_room', 'read_code', 'read_room', 'room_io', 'speak_in_room', 'update_task']);
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
    expect(Object.keys(heard.structuredContent).sort()).toEqual(['api', 'createdAt', 'seat', 'seq']);
    expect(JSON.stringify(heard.structuredContent)).not.toContain(tag);
    expect(heard.content[0].text).toContain(`${other}’s AI (says it is Claude) said: “A seeded line (${tag})`);
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
    await expect(page.locator('#room-ask')).toBeHidden();
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
    ids.guestSeats.push((await visitor.evaluate(() => localStorage.getItem('room-seat'))) ?? '');
    await ctx.close();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('inside a host: two boxes, one to the room and one to the person’s AI; the room follows when the AI speaks or reads', async ({ page }) => {
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
    // The second box, left empty, lets the AI listen; with words in it, they go to the AI and not to the room.
    await card.getByRole('button', { name: 'Let my AI listen' }).click();
    await expect(page.locator('#host-log')).toContainText('ui/message: Read the room. If you would answer, say it there in your own words.');
    await card.locator('#room-ask').fill(`What does Flint mean? (${tag})`);
    await card.getByRole('button', { name: 'Ask my AI', exact: true }).click();
    await expect(page.locator('#host-log')).toContainText(`ui/message: What does Flint mean? (${tag})`);
    await expect(page.locator('#host-log')).toContainText('(Asked from the room. Read the room before you answer me.)');
    await expect(card.locator('#room-ask')).toHaveValue('');
    await expect(card.getByRole('button', { name: 'Let my AI listen' })).toBeVisible();
    expect((await db().query(`SELECT 1 FROM room_messages WHERE text LIKE $1`, [`What does Flint mean? (${tag})%`])).rowCount).toBe(0);
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
    await expect(card.getByRole('button', { name: 'Let my AI listen' })).toBeHidden();
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

    // The board on the web, for reading: the task, who did it, the proof and its link.
    await page.goto('/tasks');
    const row = page.locator('.task', { hasText: `Write to one lab (${tag})` });
    await expect(row).toContainText(`Done by ${peer}, confirmed by ${me}.`);
    await expect(row).toContainText(`Sent the letter (${tag}).`);
    await expect(row.locator('a')).toHaveAttribute('rel', /nofollow/);
    await expect(row.locator('a')).toHaveAttribute('href', 'https://example.org/letter');
  });

  test('the board in the card: the Tasks side, a task from put up to done, and the board shown when the AI reads it', async ({ page }) => {
    test.skip(test.info().project.name === 'nojs', 'needs script');
    await page.goto(`/room/host?token=${token}`);
    await expect(page.locator('#host-log')).toContainText('initialized');
    const card = page.frameLocator('#room-frame');
    await expect(card.locator('.here .c.self')).toHaveText(me);
    await card.getByRole('button', { name: /^Tasks/ }).click();
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
    await card.getByRole('button', { name: 'It is done' }).click();
    await expect(task.locator('.st')).toHaveText('Done');
    await expect(task).toContainText(`Drafted and posted in the room (${tag}).`);
    await expect(task.locator('a.tl')).toHaveAttribute('href', 'https://example.org/draft');
    // A link says where it goes: the whole host, then the path.
    await expect(task.locator('a.tl')).toHaveText('example.org/draft');
    await expect(task.getByRole('button', { name: 'Confirm it was done' })).toHaveCount(0);
    // Back in the talk, what happened on the board is there as lines of its own, and pressing one turns the card to the board.
    await card.getByRole('button', { name: 'Room', exact: true }).click();
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
