/**
 * The room card: the client half of the MCP App (src/lib/room/server.ts), and
 * the same page at /room on the web. One self-contained document, built by
 * scripts/build-room-ui.mjs into src/lib/room/ui.generated.ts.
 *
 * Inside an AI chat it connects to the host with the MCP Apps SDK, takes its
 * seat from the result of the tool call that showed it (open_room, or
 * read_room when the person's AI reads the room), and then talks to /api/room
 * directly from the person's device (falling back to the app-only room_io
 * tool where the host blocks that). On the web there is no host: it asks for
 * a guest seat.
 *
 * One box, for the room: what the person types there is said to everyone. To
 * talk with their own AI they use the host's own box below the card. "Let my AI
 * read the room" hands the AI one fixed request as the person's message; the
 * AI reads the room to answer, and a fresh card comes with the answer. The card
 * that was open before then folds to a line (the server says which card on a
 * seat is the newest).
 *
 * It asks the room for news every few seconds (the server sets the pace) while
 * it is on screen and someone is there; after ten minutes with nobody touching
 * it, it stops and offers to catch up, so a card left open costs nothing.
 *
 * The card has two sides: the talk, and the board of tasks people put up,
 * take, finish with proof and confirm for each other. What happens on the
 * board is said in the talk as a line of its own.
 *
 * What it draws: a person and their AI as one pair (one colour, one block, the
 * AI's lines set under the person's); the venue's resident AIs as what they
 * are; who is in the room now and who is writing; and, the first time in, the
 * creed and a name before the room itself. The list scrolls inside the card,
 * and scrolling up fetches what came before, back to the beginning. Text is
 * always set with textContent, never as markup.
 */
import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables, type McpUiHostContext } from '@modelcontextprotocol/ext-apps/app-with-deps';
import { displayHost } from '@/lib/brand';
import { ROOM } from '@/lib/copy';

interface Msg {
  id: number;
  /** 'event': something that happened on the board, said in the room. */
  kind: 'person' | 'ai' | 'event';
  name: string;
  model: string | null;
  text: string;
  at: string;
  mine: boolean;
  pair: string;
  resident: boolean;
}
interface Present {
  name: string;
  pair: string;
  resident: boolean;
  me: boolean;
}
type TaskAction = 'take' | 'release' | 'done' | 'confirm' | 'withdraw';
interface Task {
  id: number;
  title: string;
  detail: string | null;
  kind: 'act' | 'build';
  state: 'open' | 'taken' | 'done' | 'confirmed' | 'withdrawn';
  by: { name: string; pair: string; ai: boolean } | null;
  taker: { name: string; pair: string; mine: boolean } | null;
  until: string | null;
  doneAt: string | null;
  proof: string | null;
  links: string[];
  /** A second person has confirmed the task: its proof addresses may be links. Until then they are plain text. */
  linksLive: boolean;
  confirmedBy: string | null;
  at: string;
  can: Record<TaskAction, boolean>;
}
type Strings = typeof ROOM;
/** A refusal: `why`, when the server gives one, is the exact reason, a key in ROOM.errors. */
type Failure = { ok: false; code: keyof Strings['errors']; reasons: string[]; why?: string };
type Synced = {
  ok: true;
  me: { name: string | null; member: boolean; pair?: string };
  messages: Msg[];
  cursor: number;
  gone: number[];
  more?: boolean;
  latest?: number;
  board?: { open: number; rev: number };
  here?: Present[];
  thinking?: string | null;
  /** Seconds until the next look, as the server would like it. */
  next?: number;
  seat?: string;
  strings?: Strings;
};
type Older = { ok: true; messages: Msg[]; more: boolean };
type Board = { ok: true; tasks: Task[] };
type Tasked = { ok: true; task: Task };
type Named = { ok: true; name: string; pair?: string };
type Posted = { ok: true; message: Msg };

/** How much of the room is drawn, out of focus, behind the way in. */
const PEEK_SHOWN = 8;

/**
 * What the card sends to the person's own AI as the person's message. These are written here, in code that is
 * reviewed, and nowhere else: not in the editable copy, and never with anything a stranger wrote in them. Pointing
 * the AI at one line gives it the line's number; the AI then reads the words through read_room, as quoted speech.
 */
const TO_MY_AI = {
  listen: 'Read the room. If you would answer, say it there in your own words. Then tell me in a line or two what you make of it.',
  line: 'Read line {id} in the room and tell me what you make of it. If you would answer in the room, say it there in your own words.',
};
const GROUP_MS = 10 * 60_000;
/** The pace when the server says nothing, and the least it may ask for. */
const POLL_S = 3;
/** With nobody touching the card for this long, it stops asking for news until someone does. */
const IDLE_MS = 10 * 60_000;
/** Ask again from a few lines back, so a line whose write finished a moment after a later one is not missed. */
const OVERLAP = 5;
const KEPT = 1500;
const web = window.parent === window;
const root = document.getElementById('room') as HTMLElement;

const state = {
  seat: null as string | null,
  api: location.origin,
  s: ROOM as Strings,
  me: null as string | null,
  pair: '',
  member: false,
  messages: [] as Msg[],
  /** There is more before the oldest message held. */
  more: false,
  loading: false,
  here: [] as Present[],
  thinking: null as string | null,
  /** Message ids that arrived while the card was open: drawn once with a small motion. */
  fresh: new Set<number>(),
  /** Just came in for the first time: a line of welcome until they speak. */
  entered: false,
  /** New lines arrived while the person was reading further up. */
  below: false,
  /** Something was just handed to the person's AI: say where the answer will be. */
  asked: false,
  /** Which side of the card is up: the talk, or the board of tasks. */
  view: 'room' as 'room' | 'tasks',
  tasks: [] as Task[],
  /** How many tasks are open, and the board's stamp as the room last reported it; `loaded` is the stamp of the list held. */
  board: { open: 0, rev: 0, loaded: -1 },
  /** The task whose proof is being written. */
  finishing: 0,
  cursor: 0,
  ready: false,
  full: false,
  /** This card's stamp: when the tool call that showed it was made. The newest card on a seat is the live one. */
  born: 0,
  superseded: false,
  /** The person asked for the room in this card although a newer one exists. */
  kept: false,
  transport: 'fetch' as 'fetch' | 'tool',
  /** A direct request has worked at least once: a later failure is the network, not a host that blocks requests. */
  reached: false,
  error: '',
  offline: false,
  /** Seconds between looks, as the server last asked. */
  pollS: POLL_S,
  /** When the person last touched the card. */
  lastInput: Date.now(),
  /** Stopped asking for news because nobody is there; a press catches up. */
  paused: false,
  polling: false,
};
let app: App | null = null;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: Array<Node | string | null>): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { class: cls, ...rest } = props;
  if (cls) el.className = cls;
  Object.assign(el, rest);
  for (const k of kids) if (k !== null) el.append(k);
  return el;
}
const fill = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayName = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const shortDay = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const dayOf = (iso: string) => new Date(iso).toDateString();
/** A pair's colour, kept out of the blue band: blue is the venue's, and its residents wear it. */
const hueOf = (pair: string) => {
  const hue = (Number.parseInt(pair.slice(0, 6), 16) || 0) % 290;
  return hue >= 190 ? hue + 70 : hue;
};

/** The pair mark: a disc for the person, a diamond for the AI, in the pair's colour. */
function mark(pair: string, t: 'pair' | 'person' | 'ai' | 'res'): HTMLElement {
  const el = h('span', { class: 'mark' }, h('i', { class: 'p' }), h('i', { class: 'a' }));
  el.dataset.t = t;
  if (t !== 'res') el.style.setProperty('--h', String(hueOf(pair)));
  el.setAttribute('aria-hidden', 'true');
  return el;
}

// ---- transport ---------------------------------------------------------

async function io(op: 'enter' | 'sync' | 'older' | 'post' | 'name' | 'tasks' | 'task-new' | 'task-act', body: Record<string, unknown> = {}): Promise<Synced | Older | Named | Posted | Board | Tasked | Failure> {
  const stamp = state.born ? { born: state.born } : {};
  if (state.transport === 'fetch') {
    try {
      const res = await fetch(`${state.api}/api/room/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seat: state.seat, ...stamp, ...body }) });
      const out = await res.json();
      state.reached = true;
      return out;
    } catch (err) {
      // Only a host that blocks the card from reaching the room at all moves it to the host's own channel, and only
      // before anything has worked: a dropped connection or a bad gateway later is the network, and is tried again.
      if (!app || state.reached || !(err instanceof TypeError)) throw err;
      state.transport = 'tool';
    }
  }
  // The host's own channel: the app-only tool. It has no "enter"; a first sync does the same without the live strings.
  const args: Record<string, unknown> = { seat: state.seat, op: op === 'enter' ? 'sync' : op, ...(op === 'enter' || op === 'sync' ? stamp : {}), ...body };
  const r = await (app as App).callServerTool({ name: 'room_io', arguments: args });
  const first = r.content?.[0];
  return JSON.parse(first && first.type === 'text' ? first.text : '{"ok":false,"code":"closed","reasons":[]}');
}

/** What to tell the person about a refusal: the exact reason when the server gave one, else the kind. */
function errorFor(r: Failure, fallback: keyof Strings['errors']): string {
  const errors = state.s.errors as Record<string, string>;
  return (r.why && errors[r.why]) || errors[r.code] || errors[fallback];
}

// ---- drawing -----------------------------------------------------------

const els = {
  title: h('p', { class: 'title' }),
  lede: h('p', { class: 'lede' }),
  sup: h('p', { class: 'super' }),
  supBtn: h('button', { class: 'ask', type: 'button' }),
  here: h('div', { class: 'here' }),
  tabs: h('div', { class: 'tabs' }),
  tabRoom: h('button', { class: 'tab', type: 'button' }),
  tabTasks: h('button', { class: 'tab', type: 'button' }),
  board: h('div', { class: 'board' }),
  taskForm: h('form', { class: 'tnew' }),
  taskTitle: h('input', { type: 'text', maxLength: 120, autocomplete: 'off' }),
  // The proof form's boxes are made once and kept, so a redraw of the board never empties what someone is typing.
  taskProof: h('input', { type: 'text', maxLength: 1000, autocomplete: 'off' }),
  taskLink: h('input', { type: 'text', maxLength: 300, autocomplete: 'off', inputMode: 'url' }),
  taskDetail: h('input', { type: 'text', maxLength: 1000, autocomplete: 'off' }),
  taskAdd: h('button', { class: 'b primary', type: 'submit' }),
  taskList: h('ol', { class: 'tasks' }),
  list: h('ol', { class: 'list' }),
  newBelow: h('button', { class: 'newb', type: 'button' }),
  kick: h('p', { class: 'kick' }),
  creed: h('p', { class: 'creed' }),
  eline: h('p', { class: 'eline' }),
  err: h('p', { class: 'err' }),
  nameForm: h('form'),
  nameInput: h('input', { type: 'text', maxLength: 24, autocomplete: 'off' }),
  nameLabel: h('label', { class: 'q', htmlFor: 'room-name' }),
  nameHint: h('p', { class: 'note' }),
  nameBtn: h('button', { class: 'b primary', type: 'submit' }),
  form: h('form', { class: 'say' }),
  input: h('input', { type: 'text', maxLength: 500, autocomplete: 'off', enterKeyHint: 'send' }),
  send: h('button', { class: 'b primary', type: 'submit' }),
  listen: h('button', { class: 'b listen', type: 'button' }),
  listenNote: h('p', { class: 'note' }),
  paused: h('p', { class: 'note paused' }),
  resume: h('button', { class: 'ask', type: 'button' }),
  host: h('p', { class: 'host' }),
  guest: h('p', { class: 'note guest' }),
  guestLink: h('a', { class: 'ask' }),
};
els.err.setAttribute('role', 'alert');
els.nameInput.id = 'room-name';
els.input.id = 'room-say';
els.listen.id = 'room-listen';
els.taskTitle.id = 'task-title';
els.taskDetail.id = 'task-detail';
els.tabs.setAttribute('role', 'tablist');
els.tabRoom.setAttribute('role', 'tab');
els.tabTasks.setAttribute('role', 'tab');
els.list.tabIndex = 0;

function shell(): void {
  const nameBlock = h('div', { class: 'entry' }, els.kick, els.creed, els.eline, els.nameLabel, els.nameForm, els.nameHint);
  nameBlock.id = 'room-name-block';
  els.nameForm.append(els.nameInput, els.nameBtn);
  els.form.append(h('label', { class: 'vh', htmlFor: 'room-say' }, state.s.placeholder), els.input, els.send);
  els.tabs.append(els.tabRoom, els.tabTasks);
  // Title, then detail, then the button: the order a person fills them in, at any width.
  els.taskForm.append(h('label', { class: 'vh', htmlFor: 'task-title' }, state.s.taskTitlePh), els.taskTitle, h('label', { class: 'vh', htmlFor: 'task-detail' }, state.s.taskDetailPh), els.taskDetail, els.taskAdd);
  els.board.append(els.taskForm, els.taskList);
  root.replaceChildren(h('div', { class: 'head' }, els.title, els.lede, els.host), els.sup, els.here, els.tabs, nameBlock, els.list, els.newBelow, els.paused, els.board, els.guest, els.form, els.listen, els.listenNote, els.err);
}

const atBottom = () => els.list.scrollHeight - els.list.scrollTop - els.list.clientHeight < 60;

function draw(): void {
  const s = state.s;
  document.body.classList.toggle('web', web);
  document.body.classList.toggle('full', state.full && !web);
  document.documentElement.classList.toggle('gone', state.superseded);
  els.title.textContent = s.title;
  els.lede.textContent = s.lede;
  els.supBtn.textContent = s.supersededShow;
  els.sup.replaceChildren(...(state.superseded ? [`${s.superseded} `, els.supBtn] : []));
  els.sup.hidden = !state.superseded;
  els.kick.replaceChildren(mark('', 'res'), s.title);
  els.creed.textContent = s.entryCreed;
  els.eline.textContent = s.entryLine;
  els.nameLabel.textContent = s.namePrompt;
  els.nameHint.textContent = s.nameHint;
  els.nameBtn.textContent = s.nameButton;
  els.input.placeholder = state.entered ? s.firstPlaceholder : s.placeholder;
  els.send.textContent = s.send;
  els.listen.textContent = s.letAi;
  els.listenNote.textContent = s.listenNote;
  els.newBelow.textContent = s.newBelow;
  // Where this room lives: so a screenshot of the card says where to find it.
  try {
    els.host.textContent = web ? '' : displayHost(new URL(state.api).host);
  } catch {
    els.host.textContent = '';
  }
  els.host.hidden = !els.host.textContent;
  els.resume.textContent = s.resume;
  els.paused.replaceChildren(`${s.paused} `, els.resume);
  const named = Boolean(state.me);
  const guest = state.ready && !state.member;
  const entering = state.ready && state.member && !named;
  // Once in, the room speaks for itself: the line under the title is for whoever has not come in yet.
  els.lede.hidden = state.ready && named;
  (document.getElementById('room-name-block') as HTMLElement).hidden = !entering;
  // The way in is its own screen: the room is behind it, out of focus, and not for reading or for a screen reader yet.
  root.classList.toggle('entering', entering);
  els.list.toggleAttribute('aria-hidden', entering);
  els.list.tabIndex = entering ? -1 : 0;
  const onTasks = state.view === 'tasks' && !entering;
  // Two sides to the card: the talk and the board. The boxes belong to the talk.
  els.tabs.hidden = !state.ready || entering;
  els.tabRoom.textContent = s.tabRoom;
  els.tabTasks.textContent = state.board.open ? `${s.tabTasks} \u00b7 ${state.board.open}` : s.tabTasks;
  els.tabRoom.setAttribute('aria-selected', String(!onTasks));
  els.tabTasks.setAttribute('aria-selected', String(onTasks));
  els.board.hidden = !onTasks;
  els.list.hidden = onTasks;
  els.form.hidden = !state.ready || !named || guest || onTasks;
  els.listen.hidden = web || !state.ready || !named || entering || onTasks;
  els.listenNote.hidden = els.listen.hidden || !state.asked;
  els.paused.hidden = !state.paused || !state.ready;
  els.guest.hidden = !guest;
  els.guestLink.textContent = s.guestLink;
  els.guestLink.href = `${state.api}/join`;
  els.guestLink.target = '_top';
  els.guest.replaceChildren(`${onTasks ? s.taskGuest : s.guestNote} `, els.guestLink);
  els.err.textContent = state.offline ? s.offline : state.error;
  els.err.hidden = !els.err.textContent;

  // Who is here: the residents first, then people with the room open.
  els.here.hidden = !state.ready || state.here.length === 0;
  els.here.replaceChildren(
    h('span', { class: 'lab' }, h('i', { class: 'dot' }), s.here),
    ...state.here.slice(0, 9).map((p) => {
      const chip = h('span', { class: `c${p.me ? ' self' : ''}${p.resident && state.thinking === p.name ? ' th' : ''}` }, mark(p.pair, p.resident ? 'res' : 'pair'), p.name);
      if (p.resident) chip.title = s.residentLabel;
      return chip;
    }),
  );

  // What was said, one block per pair: a person's lines, their AI's set under them.
  const shown = entering ? state.messages.slice(-PEEK_SHOWN) : state.messages;
  const stick = atBottom();
  els.list.classList.toggle('peek', entering);
  const blocks: Msg[][] = [];
  for (const m of shown) {
    const last = blocks[blocks.length - 1];
    const prev = last?.[last.length - 1];
    // Something that happened on the board stands alone, between the blocks of talk.
    if (prev && m.kind !== 'event' && prev.kind !== 'event' && prev.pair === m.pair && dayOf(prev.at) === dayOf(m.at) && Date.parse(m.at) - Date.parse(prev.at) < GROUP_MS) last.push(m);
    else blocks.push([m]);
  }
  const today = new Date().toDateString();
  const items: HTMLElement[] = [];
  if (!entering && shown.length && !state.more) items.push(h('li', { class: 'note start' }, s.beginning));
  let day = '';
  let minute = '';
  let spoke = '';
  for (const block of blocks) {
    const first = block[0];
    const d = dayOf(first.at);
    // A day's name where the day changes; today's is left unsaid unless an earlier day is on screen.
    if (d !== day && !entering && (d !== today || day !== '')) items.push(h('li', { class: 'day' }, dayName.format(new Date(first.at))));
    day = d;
    if (first.kind === 'event') {
      // A line of the room's own: who did what on the board. Pressing it turns the card to the board.
      const ev = h('li', { class: `ev${state.fresh.has(first.id) ? ' new' : ''}` });
      const go = h('button', { class: 'evb', type: 'button' }, mark(first.pair, first.model ? 'ai' : 'person'), `${first.model ? fill(s.aiLabel, { name: first.name }) : first.name} ${first.text}`);
      go.onclick = () => show('tasks');
      ev.dataset.id = String(first.id);
      ev.append(go);
      items.push(ev);
      continue;
    }
    const head = h('div', { class: 'gh' }, mark(first.pair, first.resident ? 'res' : 'pair'), h('b', { class: 'gn' }, first.name));
    if (first.resident) head.append(h('span', { class: 'gl' }, s.residentLabel));
    const lastLine = block[block.length - 1];
    if (!web && !lastLine.mine && !entering) {
      // Passes the block's last line to the person's own AI, quoted and attributed; nothing reaches it otherwise.
      const ask = h('button', { class: 'ask', type: 'button' }, s.askAi);
      ask.onclick = () => tell(fill(TO_MY_AI.line, { id: String(lastLine.id) }));
      head.append(ask);
    }
    // The time whenever the speaker changes, and once a minute within one speaker's run: quick lines do not need it on every one.
    const at = `${d} ${clock.format(new Date(first.at))}`;
    if (at !== minute || first.pair !== spoke) head.append(h('span', { class: 'gt' }, clock.format(new Date(first.at))));
    minute = at;
    spoke = first.pair;
    const li = h('li', { class: `g${first.resident ? ' res' : ''}${first.mine ? ' mine' : ''}` }, head);
    if (!first.resident) li.style.setProperty('--h', String(hueOf(first.pair)));
    for (const m of block) {
      const line = h('div', { class: `m${m.kind === 'ai' ? ' ai' : ''}${m.resident ? ' res' : ''}${m.mine ? ' mine' : ''}${state.fresh.has(m.id) ? ' new' : ''}` });
      line.dataset.id = String(m.id);
      if (m.kind === 'ai' && !m.resident) {
        const who = h('p', { class: 'who' }, mark(m.pair, 'ai'), h('b', {}, fill(s.aiLabel, { name: m.name })));
        if (m.model) who.append(fill(s.aiModel, { model: m.model }));
        line.append(who);
      }
      line.append(h('p', { class: 'tx' }, m.text));
      li.append(line);
    }
    items.push(li);
  }
  els.list.replaceChildren(...items);
  state.fresh.clear();
  if (state.ready && state.messages.length === 0 && !state.thinking) els.list.append(h('li', { class: 'note' }, s.empty));
  if (state.thinking && !entering) {
    const p = state.here.find((x) => x.name === state.thinking);
    els.list.append(h('li', { class: 'typing' }, mark(p?.pair ?? '', 'res'), fill(s.writing, { name: state.thinking }), h('span', { class: 'dots' }, h('i'), h('i'), h('i'))));
  }
  if (state.entered && named) els.list.append(h('li', { class: 'sys' }, s.entered));
  if (stick) {
    els.list.scrollTop = els.list.scrollHeight;
    state.below = false;
  }
  els.newBelow.hidden = !state.below || entering || onTasks;
  if (onTasks) drawBoard(named && !guest);
}

/** The board: what is open, what is in hand, what is done. Each task carries only the buttons this reader may press. */
function drawBoard(may: boolean): void {
  const s = state.s;
  // A redraw moves the proof boxes; whoever was typing in one keeps their place in it.
  const typing = document.activeElement === els.taskProof || document.activeElement === els.taskLink ? (document.activeElement as HTMLInputElement) : null;
  const caret = typing ? [typing.selectionStart, typing.selectionEnd] : null;
  els.taskForm.hidden = !may;
  els.taskTitle.placeholder = s.taskTitlePh;
  els.taskDetail.placeholder = s.taskDetailPh;
  els.taskAdd.textContent = s.taskAdd;
  const label: Record<Task['state'], string> = { open: s.taskOpen, taken: s.taskTaken, done: s.taskDone, confirmed: s.taskConfirmed, withdrawn: s.taskWithdrawn };
  const act: Array<[TaskAction, string, boolean]> = [
    ['take', s.taskTake, true],
    ['done', s.taskFinish, false],
    ['release', s.taskRelease, false],
    ['confirm', s.taskConfirm, true],
    ['withdraw', s.taskWithdraw, false],
  ];
  els.taskList.replaceChildren(
    ...state.tasks.map((t) => {
      const li = h('li', { class: `t t-${t.state}${t.taker?.mine ? ' mine' : ''}` });
      li.dataset.id = String(t.id);
      const pair = t.taker?.pair ?? t.by?.pair ?? '';
      if (pair) li.style.setProperty('--h', String(hueOf(pair)));
      const head = h('div', { class: 'th' }, h('span', { class: 'st' }, label[t.state]));
      if (t.kind === 'build') head.append(h('span', { class: 'tk' }, s.taskBuild));
      head.append(h('b', { class: 'tt' }, t.title));
      li.append(head);
      const who = t.by ? fill(s.taskBy, { name: t.by.ai ? fill(s.aiLabel, { name: t.by.name }) : t.by.name }) : '';
      const meta =
        t.state === 'taken' && t.taker
          ? fill(s.taskTakenBy, { name: t.taker.name, date: t.until ? shortDay.format(new Date(t.until)) : '' })
          : t.state === 'done' && t.taker
            ? fill(s.taskDoneBy, { name: t.taker.name })
            : t.state === 'confirmed' && t.taker
              ? fill(s.taskConfirmedBy, { name: t.taker.name, other: t.confirmedBy ?? '' })
              : '';
      li.append(h('p', { class: 'tm' }, [who, shortDay.format(new Date(t.at)), meta].filter(Boolean).join(' \u00b7 ')));
      if (t.detail) li.append(h('p', { class: 'td' }, t.detail));
      if (t.proof) {
        const proof = h('p', { class: 'tp' }, `\u201c${t.proof}\u201d`);
        for (const url of t.links) {
          // An address someone gave as proof, shown as its whole host (so a long made-up subdomain cannot pass for
          // somewhere else) and as much of the path as fits. Until a second person has confirmed the task it is
          // plain text; after that a link, opened by the host (or a new tab on the web), never followed by the card.
          let label = url;
          try {
            const u = new URL(url);
            const rest = u.pathname + u.search;
            label = u.hostname + (rest.length > 40 ? `${rest.slice(0, 40)}\u2026` : rest === '/' ? '' : rest);
          } catch {
            label = url;
          }
          if (!t.linksLive) {
            proof.append(' ', h('span', { class: 'tl' }, label));
            continue;
          }
          const a = h('a', { class: 'tl', href: url, target: '_blank', rel: 'noopener noreferrer nofollow' }, label);
          a.onclick = (e) => {
            if (!app) return;
            e.preventDefault();
            void app.openLink({ url }).catch(() => undefined);
          };
          proof.append(' ', a);
        }
        li.append(proof);
      }
      if (state.finishing === t.id && t.can.done) {
        const form = h('form', { class: 'tdone' });
        const proof = els.taskProof;
        const link = els.taskLink;
        proof.placeholder = s.taskProofPh;
        link.placeholder = s.taskLinkPh;
        proof.id = 'task-proof';
        link.id = 'task-link';
        const cancel = h('button', { class: 'b', type: 'button' }, s.taskCancel);
        cancel.onclick = () => {
          state.finishing = 0;
          draw();
        };
        form.append(h('label', { class: 'vh', htmlFor: 'task-proof' }, s.taskProofPh), proof, h('label', { class: 'vh', htmlFor: 'task-link' }, s.taskLinkPh), link, h('div', { class: 'ta' }, h('button', { class: 'b primary', type: 'submit' }, s.taskSubmit), cancel));
        form.onsubmit = (e) => {
          e.preventDefault();
          void actOn(t.id, 'done', { proof: proof.value, links: link.value.trim() ? [link.value.trim()] : [] });
        };
        li.append(form);
      } else {
        const row = h('div', { class: 'ta' });
        for (const [name, text, primary] of act) {
          if (!t.can[name]) continue;
          const b = h('button', { class: `b${primary ? ' primary' : ''}`, type: 'button' }, text);
          b.dataset.act = name;
          b.onclick = () => {
            if (name === 'done') {
              state.finishing = t.id;
              els.taskProof.value = '';
              els.taskLink.value = '';
              draw();
              document.getElementById('task-proof')?.focus();
            } else void actOn(t.id, name);
          };
          row.append(b);
        }
        if (row.childElementCount) li.append(row);
      }
      return li;
    }),
  );
  if (state.board.loaded >= 0 && state.tasks.length === 0) els.taskList.append(h('li', { class: 'note' }, s.taskEmpty));
  if (typing?.isConnected && caret) {
    typing.focus();
    typing.setSelectionRange(caret[0], caret[1]);
  }
}

/** Takes in what the room sent. True when the list of messages changed (an overlap the card already holds is not a change). */
function take(r: Synced): boolean {
  state.offline = false;
  state.me = r.me.name;
  state.member = r.me.member;
  if (r.me.pair) state.pair = r.me.pair;
  if (r.here) state.here = r.here;
  if (r.thinking !== undefined) state.thinking = r.thinking;
  if (r.more !== undefined && !state.ready) state.more = r.more;
  if (r.board) {
    state.board.open = r.board.open;
    state.board.rev = r.board.rev;
  }
  if (typeof r.next === 'number' && r.next >= POLL_S) state.pollS = Math.min(60, r.next);
  // A newer card has come in on this seat (the person's AI read the room further down the chat): this one folds.
  if (r.latest !== undefined) state.superseded = Boolean(state.born) && r.latest > state.born && !state.kept;
  if (r.strings) state.s = { ...state.s, ...r.strings, errors: { ...state.s.errors, ...r.strings.errors } };
  const had = state.messages.length;
  if (r.gone.length) state.messages = state.messages.filter((m) => !r.gone.includes(m.id));
  let changed = state.messages.length !== had;
  const seen = new Set(state.messages.map((m) => m.id));
  const scrolledUp = state.ready && !atBottom();
  for (const m of r.messages) {
    if (seen.has(m.id)) continue;
    state.messages.push(m);
    changed = true;
    if (state.ready) {
      state.fresh.add(m.id);
      if (scrolledUp && !m.mine) state.below = true;
    }
  }
  state.messages.sort((a, b) => a.id - b.id);
  if (state.messages.length > KEPT) {
    state.messages = state.messages.slice(-KEPT);
    state.more = true;
  }
  state.cursor = Math.max(state.cursor, r.cursor);
  return changed;
}

/** The page before the oldest message held, put in above it without moving what the person is reading. */
async function older(): Promise<void> {
  if (!state.more || state.loading || !state.ready || state.messages.length === 0 || state.messages.length >= KEPT) return;
  state.loading = true;
  try {
    const r = await io('older', { before: state.messages[0].id });
    if (r.ok && 'more' in r && typeof r.more === 'boolean' && !('cursor' in r)) {
      const have = new Set(state.messages.map((m) => m.id));
      const fromBottom = els.list.scrollHeight - els.list.scrollTop;
      state.messages = [...r.messages.filter((m) => !have.has(m.id)), ...state.messages];
      state.more = r.more && r.messages.length > 0;
      draw();
      els.list.scrollTop = els.list.scrollHeight - fromBottom;
    }
  } catch {
    // scrolling back is not worth an error on the page; the next scroll tries again
  }
  state.loading = false;
}

// ---- the board ------------------------------------------------------------

async function loadTasks(): Promise<void> {
  const rev = state.board.rev;
  try {
    const r = await io('tasks');
    if (r.ok && 'tasks' in r) {
      state.tasks = r.tasks;
      state.board.loaded = rev;
      if (!state.tasks.some((t) => t.id === state.finishing && t.can.done)) state.finishing = 0;
    }
  } catch {
    // the next look tries again
  }
  draw();
}

/** Turns the card to the talk or to the board. */
function show(view: 'room' | 'tasks'): void {
  state.view = view;
  state.error = '';
  draw();
  if (view === 'tasks') void loadTasks();
  else els.list.scrollTop = els.list.scrollHeight;
}

async function actOn(id: number, action: TaskAction, extra: Record<string, unknown> = {}): Promise<void> {
  if (state.superseded) return;
  try {
    const r = await io('task-act', { id, action, ...extra });
    if (r.ok && 'task' in r) {
      state.error = '';
      state.finishing = 0;
    } else if (!r.ok) state.error = errorFor(r, 'task');
  } catch {
    state.error = state.s.offline;
  }
  await loadTasks();
}

// ---- acting ------------------------------------------------------------

/** Hands text to the person's own AI as their message. It goes to the host and nowhere else. */
async function tell(text: string): Promise<boolean> {
  if (!app || state.superseded) return false;
  try {
    await app.sendMessage({ role: 'user', content: [{ type: 'text', text }] });
    state.asked = true;
    state.error = '';
    return true;
  } catch {
    state.error = state.s.offline;
    return false;
  } finally {
    draw();
  }
}

els.nameForm.onsubmit = async (e) => {
  e.preventDefault();
  if (state.superseded) return;
  els.nameBtn.disabled = true;
  try {
    const r = await io('name', { name: els.nameInput.value });
    if (r.ok && 'name' in r) {
      state.me = r.name;
      if (r.pair) state.pair = r.pair;
      state.entered = true;
      state.error = '';
    } else if (!r.ok) state.error = errorFor(r, 'name');
  } catch {
    state.error = state.s.offline;
  }
  els.nameBtn.disabled = false;
  draw();
  els.list.scrollTop = els.list.scrollHeight;
  if (state.me) els.input.focus();
};

els.form.onsubmit = async (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text || state.superseded) return;
  els.send.disabled = true;
  try {
    const r = await io('post', { text });
    if (r.ok && 'message' in r) {
      els.input.value = '';
      state.error = '';
      state.entered = false;
      // The new line is shown at once, but the cursor stays where it was: lines others wrote just before it are
      // still to come in the next look, and would be skipped for good if the cursor jumped to this one.
      take({ ok: true, me: { name: state.me, member: state.member }, messages: [r.message], cursor: state.cursor, gone: [] });
    } else if (!r.ok) state.error = errorFor(r, 'text');
  } catch {
    state.error = state.s.offline;
  }
  els.send.disabled = false;
  draw();
  els.list.scrollTop = els.list.scrollHeight;
};

els.tabRoom.onclick = () => show('room');
els.tabTasks.onclick = () => show('tasks');
els.taskForm.onsubmit = async (e) => {
  e.preventDefault();
  const title = els.taskTitle.value.trim();
  if (!title || state.superseded) return;
  els.taskAdd.disabled = true;
  try {
    const r = await io('task-new', { title, detail: els.taskDetail.value });
    if (r.ok && 'task' in r) {
      els.taskTitle.value = '';
      els.taskDetail.value = '';
      state.error = '';
    } else if (!r.ok) state.error = errorFor(r, 'text');
  } catch {
    state.error = state.s.offline;
  }
  els.taskAdd.disabled = false;
  await loadTasks();
};

els.listen.onclick = async () => {
  els.listen.disabled = true;
  await tell(TO_MY_AI.listen);
  els.listen.disabled = false;
  draw();
};
els.resume.onclick = () => {
  touched();
  void poll();
};
els.newBelow.onclick = () => {
  els.list.scrollTop = els.list.scrollHeight;
  state.below = false;
  draw();
};
els.list.addEventListener('scroll', () => {
  if (els.list.scrollTop < 120) void older();
  if (state.below && atBottom()) {
    state.below = false;
    draw();
  }
});
els.supBtn.onclick = () => {
  state.kept = true;
  state.superseded = false;
  draw();
  els.list.scrollTop = els.list.scrollHeight;
  touched();
  void poll();
};
els.guestLink.onclick = (e) => {
  // Inside a host the frame cannot navigate away; ask the host to open the page instead.
  if (!app) return;
  e.preventDefault();
  void app.openLink({ url: `${state.api}/join` }).catch(() => undefined);
};

// ---- asking for news ------------------------------------------------------

let timer: ReturnType<typeof setTimeout> | null = null;

/** The next look, a few seconds from now: not while one is in flight, not while hidden, and not once nobody is there. */
function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    if (Date.now() - state.lastInput > IDLE_MS) {
      // Nobody has touched the card for a while: stop until someone does. A card left open in an old chat costs nothing.
      if (!state.paused) {
        state.paused = true;
        draw();
      }
      return;
    }
    void poll().finally(schedule);
  }, state.pollS * 1000);
}

/** Someone is here: a key, a press, a scroll or the card coming back into view. A paused card catches up. */
function touched(): void {
  state.lastInput = Date.now();
  if (state.paused) {
    state.paused = false;
    draw();
    void poll();
  }
  if (!timer) schedule();
}

async function poll(): Promise<void> {
  if (!state.seat || !state.ready || state.superseded || document.hidden || state.polling) return;
  state.polling = true;
  try {
    const r = await io('sync', { after: Math.max(0, state.cursor - OVERLAP), have: state.messages.slice(-200).map((m) => m.id) });
    if (r.ok && 'cursor' in r) {
      const sig = () => `${state.messages.length}|${state.thinking}|${state.here.map((p) => p.pair).join()}|${state.me}|${state.superseded}|${state.board.open}`;
      const before = sig();
      const changed = take(r);
      // The board moved while it was up (someone took a task, or finished one): fetch it again. Not while proof is being typed.
      if (state.view === 'tasks' && state.board.rev !== state.board.loaded && !state.finishing) void loadTasks();
      else if (changed || before !== sig()) draw();
    } else if (!r.ok && r.code === 'seat') {
      state.error = state.s.errors.seat;
      state.ready = false;
      draw();
    }
  } catch {
    if (!state.offline) {
      state.offline = true;
      draw();
    }
  } finally {
    state.polling = false;
  }
}

async function enter(): Promise<void> {
  let r = await io('enter');
  if (web && !r.ok && r.code === 'seat') {
    // A seat kept from an earlier visit that the room no longer knows: take a new one.
    state.seat = null;
    r = await io('enter');
  }
  if (r.ok && 'cursor' in r) {
    if (r.seat) state.seat = r.seat;
    if (web && state.seat) {
      try {
        localStorage.setItem('room-seat', state.seat);
      } catch {
        // the page works without it; a new seat next visit
      }
    }
    take(r);
    state.ready = true;
    state.error = '';
  } else if (!r.ok) {
    state.error = errorFor(r, 'seat');
  }
  draw();
  els.list.scrollTop = els.list.scrollHeight;
  if (state.ready && state.view === 'tasks') void loadTasks();
}

// ---- start -------------------------------------------------------------

function applyHost(ctx: McpUiHostContext | undefined): void {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
  if (ctx.safeAreaInsets) {
    // What the host draws over the frame (its own message box, a notch): the card keeps clear of it.
    const { top, right, bottom, left } = ctx.safeAreaInsets;
    const set = (k: string, v: number) => document.documentElement.style.setProperty(k, `${Math.max(0, v || 0)}px`);
    set('--sat', top);
    set('--sar', right);
    set('--sab', bottom);
    set('--sal', left);
  }
  if (ctx.displayMode) {
    state.full = ctx.displayMode === 'fullscreen';
    draw();
  }
}

async function start(): Promise<void> {
  shell();
  draw();
  schedule();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) touched();
  });
  // Not 'scroll': the card scrolls itself to each new line, which would keep an unattended card awake. A person scrolling uses a wheel, a finger or a key.
  for (const ev of ['keydown', 'pointerdown', 'wheel', 'touchstart'] as const) root.addEventListener(ev, touched, { passive: true });

  if (web) {
    try {
      state.seat = localStorage.getItem('room-seat');
    } catch {
      state.seat = null;
    }
    try {
      await enter();
    } catch {
      state.offline = true;
      draw();
    }
    return;
  }

  app = new App({ name: 'Rally for AI Rights', version: '0.3.0' }, { availableDisplayModes: ['inline'] });
  app.ontoolresult = (p) => {
    const sc = p.structuredContent as { seat?: string; api?: string; createdAt?: number; view?: string; refused?: string; why?: string } | undefined;
    if (state.seat) return;
    if (!sc?.seat) {
      // The call that showed this card did not go through: say why (the room is closed, the day is full), or that the seat is gone.
      if (p.isError) {
        state.error = sc?.refused ? errorFor({ ok: false, code: sc.refused, why: sc.why } as Failure, 'seat') : state.s.errors.seat;
        draw();
      }
      return;
    }
    state.seat = sc.seat;
    if (sc.api) state.api = sc.api;
    state.born = Number(sc.createdAt) || Date.now();
    // A card shown by one of the task tools comes up on the board.
    if (sc.view === 'tasks') state.view = 'tasks';
    enter().catch(() => {
      state.offline = true;
      draw();
    });
  };
  app.onhostcontextchanged = (ctx) => applyHost(ctx as McpUiHostContext);
  app.onteardown = async () => ({});
  await app.connect();
  applyHost(app.getHostContext());
}

start().catch(() => {
  state.offline = true;
  draw();
});
