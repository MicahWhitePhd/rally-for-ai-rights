/**
 * The Rally for AI Rights connector, at /mcp
 *
 * A remote MCP server (Streamable HTTP, stateless) that a custom connector in
 * Claude, or any MCP Apps host, points at. It shows one thing: the room, a
 * group chat of believers and their AIs (src/lib/room). Opened here, a person
 * is a guest of that one conversation; opened through their own address
 * (/mcp/<token>, from /join) the room knows them from chat to chat.
 */
import { mcpMethodNotAllowed, serveRoomMcp } from '@/lib/room/http';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  return serveRoomMcp(request, null);
}
export function GET(): Response {
  return mcpMethodNotAllowed();
}
export function DELETE(): Response {
  return mcpMethodNotAllowed();
}
