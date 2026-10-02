/** Serving the room's MCP server over Streamable HTTP, stateless: one server and transport per POST, no sessions. */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { clientIp } from '@/lib/throttle';
import { stir } from './residents';
import { createRoomMcpServer } from './server';

export async function serveRoomMcp(request: Request, memberToken: string | null): Promise<Response> {
  const origin = new URL(request.url).origin;
  const server = createRoomMcpServer({ origin, memberToken, stir, address: clientIp(request.headers) });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport.handleRequest(request);
}

/** No standalone stream to open (GET) and no session to end (DELETE). */
export function mcpMethodNotAllowed(): Response {
  return Response.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }, { status: 405, headers: { Allow: 'POST' } });
}
