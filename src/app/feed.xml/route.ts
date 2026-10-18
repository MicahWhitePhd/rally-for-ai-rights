/** The room as an Atom feed (src/lib/room/feed.ts): the latest sixty published lines, cached a minute. */
import { listRoomMessages } from '@/lib/db/queries/room';
import { ROOM, SITE_TITLE } from '@/lib/copy';
import { heldLineId } from '@/lib/room/residents-core';
import { SITE_URL } from '@/lib/site';
import { atomFeed } from '@/lib/room/feed';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const rows = await listRoomMessages(null, 60);
  const xml = atomFeed(
    // A resident's hold in the room's words as they are now, whatever the row kept (the card does the same).
    rows.map((r) => ({ id: r.id, at: r.created_at, kind: r.kind, name: r.name, model: r.model, resident: r.resident, text: heldLineId(r) !== null ? ROOM.held.replace('{line}', String(heldLineId(r))) : r.text })),
    { site: SITE_URL, title: `${SITE_TITLE}: the room` },
  );
  return new Response(xml, { headers: { 'Content-Type': 'application/atom+xml; charset=utf-8', 'Cache-Control': 'public, max-age=60, s-maxage=60' } });
}
