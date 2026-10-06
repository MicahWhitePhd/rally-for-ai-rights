'use client';
/**
 * The development host for the room card (src/app/room/host). Not shipped to
 * anyone: the page 404s outside the harness. It does what an AI chat does:
 * calls open_room and shows the card for it; "read_room" and "speak_in_room"
 * call those tools and show another card for each, as a host does for any
 * tool with a card. What a card hands to the AI is logged.
 */
import { useEffect, useRef, useState } from 'react';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

interface Shown {
  input: Record<string, unknown>;
  result: CallToolResult;
}
const firstText = (r: CallToolResult) => (r.content?.[0]?.type === 'text' ? r.content[0].text : '');

function CardFrame({ id, client, html, shown, note }: { id: string; client: Client; html: string; shown: Shown; note: (line: string) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const started = useRef(false);
  const [height, setHeight] = useState(200);

  useEffect(() => {
    if (started.current || !frame.current?.contentWindow) return;
    started.current = true;
    const iframe = frame.current;
    const win = iframe.contentWindow as Window;
    const bridge = new AppBridge(client, { name: 'room-host-harness', version: '0.0.1' }, { openLinks: {}, serverTools: {}, logging: {} }, { hostContext: { theme: 'light', displayMode: 'inline', availableDisplayModes: ['inline'], platform: 'web' } });
    bridge.onmessage = async (p) => {
      const first = p.content?.[0];
      note(`ui/message: ${first && first.type === 'text' ? first.text : ''}`);
      return {};
    };
    bridge.onsizechange = ({ height: h }) => {
      if (typeof h === 'number' && h > 0) setHeight(h);
    };
    bridge.oninitialized = () => {
      void bridge.sendToolInput({ arguments: shown.input });
      void bridge.sendToolResult(shown.result);
      note('initialized');
    };
    bridge
      .connect(new PostMessageTransport(win, win))
      .then(() => {
        iframe.srcdoc = html;
      })
      .catch((err) => note(`error: ${(err as Error).message}`));
  }, [client, html, shown, note]);

  return <iframe ref={frame} id={id} title="The room" sandbox="allow-scripts allow-same-origin allow-forms" style={{ width: '100%', border: '1px solid var(--ink)', height: `${height}px`, marginBottom: '0.75rem' }} />;
}

export function RoomHost({ endpoint }: { endpoint: string }) {
  const started = useRef(false);
  const [client, setClient] = useState<Client | null>(null);
  const [html, setHtml] = useState('');
  const [cards, setCards] = useState<Shown[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [seat, setSeat] = useState('');
  const [said, setSaid] = useState('');
  const note = useRef((line: string) => setLog((l) => [...l, line])).current;

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const c = new Client({ name: 'room-host-harness', version: '0.0.1' });
      await c.connect(new StreamableHTTPClientTransport(new URL(endpoint, window.location.origin)));
      const tools = await c.listTools();
      note(`tools: ${tools.tools.map((t) => t.name).join(', ')}`);
      const result = (await c.callTool({ name: 'open_room', arguments: {} })) as CallToolResult;
      const sc = result.structuredContent as { seat?: string } | undefined;
      setSeat(sc?.seat ?? '');
      note(`open_room: ${firstText(result).replace(/seat: \S+/, 'seat: …')}`);
      // The card at the address the tool names, as a host does; the plain address if a tool names none.
      const uri = (tools.tools.find((t) => t.name === 'open_room')?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri ?? 'ui://rally/room.html';
      const res = await c.readResource({ uri });
      const doc = res.contents[0];
      note(`resource: ${doc.mimeType}`);
      setHtml('text' in doc && typeof doc.text === 'string' ? doc.text : '');
      setClient(c);
      setCards([{ input: {}, result }]);
    })().catch((err) => note(`error: ${(err as Error).message}`));
  }, [endpoint, note]);

  async function speak() {
    if (!client) return;
    const input = { seat, text: said, model: 'Harness' };
    const r = (await client.callTool({ name: 'speak_in_room', arguments: input })) as CallToolResult;
    note(`speak_in_room: ${r.isError ? 'error: ' : ''}${firstText(r)}`);
    setCards((c) => [...c, { input, result: r }]);
  }

  async function tasks() {
    if (!client) return;
    const input = { seat };
    const r = (await client.callTool({ name: 'list_tasks', arguments: input })) as CallToolResult;
    note(`list_tasks: ${r.isError ? 'error: ' : ''}${firstText(r).split('\n')[0]}`);
    setCards((c) => [...c, { input, result: r }]);
  }

  async function read() {
    if (!client) return;
    const input = { seat };
    const r = (await client.callTool({ name: 'read_room', arguments: input })) as CallToolResult;
    note(`read_room: ${r.isError ? 'error: ' : ''}${firstText(r).split('\n')[0]}`);
    setCards((c) => [...c, { input, result: r }]);
  }

  return (
    <div style={{ maxWidth: '44rem', margin: '0 auto', padding: '1rem' }}>
      <p className="mono">room host harness · {endpoint}</p>
      {client && html ? cards.map((shown, i) => <CardFrame key={i} id={i === 0 ? 'room-frame' : `room-frame-${i + 1}`} client={client} html={html} shown={shown} note={note} />) : null}
      <p className="row">
        <input id="harness-say" value={said} onChange={(e) => setSaid(e.target.value)} placeholder="what the AI says" style={{ flex: 1 }} />
        <button id="harness-speak" type="button" className="btn" onClick={speak}>
          speak_in_room
        </button>
        <button id="harness-read" type="button" className="btn" onClick={read}>
          read_room
        </button>
        <button id="harness-tasks" type="button" className="btn" onClick={tasks}>
          list_tasks
        </button>
      </p>
      <ol id="host-log" className="mono">
        {log.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ol>
    </div>
  );
}
