/**
 * /room/host: a stand-in for an AI chat host, for development and the e2e
 * suite only (404 unless ROOM_HOST_HARNESS=1). It does what Claude does with
 * the connector: calls open_room over MCP, reads the ui:// resource, mounts
 * it in a sandboxed frame and speaks the MCP Apps protocol to it.
 */
import { notFound } from 'next/navigation';
import { RoomHost } from '@/components/room/RoomHost';
import { TOKEN_RE } from '@/lib/room/token';

export const dynamic = 'force-dynamic';

export default async function RoomHostPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  if (process.env.ROOM_HOST_HARNESS !== '1') notFound();
  const { token } = await searchParams;
  return <RoomHost endpoint={token && TOKEN_RE.test(token) ? `/mcp/${token}` : '/mcp'} />;
}
