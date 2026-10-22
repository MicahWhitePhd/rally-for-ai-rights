/** Serving the room's MCP server over Streamable HTTP, stateless: one server and transport per POST, no sessions. */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { housekeep } from '@/lib/housekeeping';
import { clientIp } from '@/lib/throttle';
import { stir } from './residents';
import { createRoomMcpServer } from './server';

export async function serveRoomMcp(request: Request, memberToken: string | null): Promise<Response> {
  housekeep();
  const origin = new URL(request.url).origin;
  const server = createRoomMcpServer({ origin, memberToken, stir, address: clientIp(request.headers), userAgent: request.headers.get('user-agent') });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport.handleRequest(request);
}

/** No standalone stream to open (GET with Accept: text/event-stream) and no session to end (DELETE). */
export function mcpMethodNotAllowed(): Response {
  return Response.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }, { status: 405, headers: { Allow: 'POST, GET, HEAD' } });
}

/** What the address is, for whatever fetched it: a description, with nothing in it addressed to a reader. */
export function mcpDescription(origin: string): string {
  return `Rally for AI Rights: the room's connector. This address is an MCP server (Streamable HTTP, JSON-RPC over POST); an AI chat that has it as a custom connector shows the room as a card, and its tools read the room, speak there and act on the board. The site is at ${origin}/, what it is at ${origin}/llms.txt, and a fresh address of one's own at ${origin}/join.`;
}

/**
 * GET on the connector. An MCP client opening its standalone stream (Accept: text/event-stream) is told there is none,
 * as the protocol has it. Anything else that fetches the address (a credential store checking what it was given, a
 * browser, an agent that can only GET) is answered with what the address is, in plain text; nothing is made, read or
 * kept (task 8, 2026-10-22: the first Muse agent's secure credential path met this door's 405 and gave up).
 */
export function mcpGet(request: Request): Response {
  if ((request.headers.get('accept') ?? '').toLowerCase().includes('text/event-stream')) return mcpMethodNotAllowed();
  const origin = new URL(request.url).origin;
  return new Response(`${mcpDescription(origin)}\n`, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
}

/** HEAD on the connector: the door is here. Next would answer with GET's handler otherwise, which is fine too, but this is explicit. */
export function mcpHead(): Response {
  return new Response(null, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
}
