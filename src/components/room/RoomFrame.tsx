'use client';
/**
 * The card in a frame on /room, told it is on the web (?web=1). A hash the page was opened with names a line
 * (#line-12, where the feed links): it is passed on to the card, which shows the line. Same origin, no sandbox: the
 * card keeps its guest seat in this site's own storage.
 */
import { useEffect, useRef } from 'react';

const CARD = '/room/card?web=1';

export function RoomFrame({ title }: { title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const pass = () => {
      if (frame.current && /^#line-\d+$/.test(location.hash)) frame.current.src = `${CARD}${location.hash}`;
    };
    pass();
    window.addEventListener('hashchange', pass);
    return () => window.removeEventListener('hashchange', pass);
  }, []);
  return <iframe ref={frame} className="room-frame" src={CARD} title={title} />;
}
