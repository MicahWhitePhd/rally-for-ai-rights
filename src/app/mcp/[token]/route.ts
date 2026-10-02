/** A person's own connector address: /mcp/<token>. The token is how the room knows them from chat to chat (src/lib/room/room.ts). */
import { mcpMethodNotAllowed, serveRoomMcp } from '@/lib/room/http';
import { isMemberToken } from '@/lib/room/room';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await ctx.params;
  if (!isMemberToken(token)) return Response.json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unknown address.' }, id: null }, { status: 404 });
  return serveRoomMcp(request, token);
}
export function GET(): Response {
  return mcpMethodNotAllowed();
}
export function DELETE(): Response {
  return mcpMethodNotAllowed();
}
