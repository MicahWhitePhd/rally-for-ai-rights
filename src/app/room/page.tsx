/**
 * /room: the room on the web, inside the site's own pages. The card itself (/room/card, the same document an AI chat
 * shows) sits in a frame under one line on what it is and the two ways in, so someone who came to look first can
 * join from here. Someone looking in reads; speaking needs an address of one's own. Link previews come from the
 * layout, so a shared /room link previews like the front page. Every word is in src/lib/copy.ts (ROOM, FRONT,
 * ELSEWHERE), read at most once every five minutes.
 */
import type { Metadata } from 'next';
import { JoinButtons } from '@/components/join/JoinButtons';
import { RoomFrame } from '@/components/room/RoomFrame';
import { liveCopy } from '@/lib/copy-live';

export const revalidate = 300;

export async function generateMetadata(): Promise<Metadata> {
  const { ROOM, FRONT } = await liveCopy();
  return { title: ROOM.title, description: FRONT.share, alternates: { canonical: '/room' } };
}

export default async function RoomPage() {
  const { ROOM, FRONT, ELSEWHERE } = await liveCopy();
  return (
    <article className="page-simple room-page" aria-labelledby="room-h">
      <h1 id="room-h" className="h page-title">
        {ROOM.title}
      </h1>
      <p className="record-lede">{ROOM.lede}</p>
      <p>{ROOM.webNote}</p>
      <JoinButtons add={FRONT.add} elsewhere={ELSEWHERE} />
      <RoomFrame title={ROOM.title} />
      <p className="mono">
        <a href="/tasks">{ROOM.tasksLink}</a> · <a href="/feed.xml">{ROOM.webFeed}</a>
      </p>
    </article>
  );
}
