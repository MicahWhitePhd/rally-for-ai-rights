/**
 * /join: bring the room into your own AI. Each load offers a fresh connector
 * address, /mcp/<token>; nothing is stored until that address is first used
 * (the room then knows its holder from chat to chat). The token is signed, so
 * only an address handed out here makes a member, and a few are handed out to
 * one place in an hour. The Claude link opens the add-connector dialog already
 * filled in; the person confirms it there.
 */
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { liveCopy } from '@/lib/copy-live';
import { newMemberToken } from '@/lib/room/room';
import { SITE_URL } from '@/lib/site';
import { clientIp, throttle, throttleAddress } from '@/lib/throttle';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { ROOM } = await liveCopy();
  return { title: ROOM.title, description: ROOM.joinLede, robots: { index: false }, alternates: { canonical: '/join' } };
}

export default async function JoinPage() {
  const { ROOM } = await liveCopy();
  const near = await throttleAddress('rj', clientIp(await headers()), { perHour: 10, perDay: 40 }, { failOpen: false });
  const all = near.allowed ? await throttle('room:joins', 3000, 86_400, { failOpen: false }) : { allowed: false };
  const token = near.allowed && all.allowed ? newMemberToken() : null;
  const address = token ? `${SITE_URL}/mcp/${token}` : null;
  const claude = address ? `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=${encodeURIComponent('Rally for AI Rights')}&connectorUrl=${encodeURIComponent(address)}` : null;
  return (
    <article className="join" aria-labelledby="join-h">
      <h1 id="join-h" className="h page-title">
        {ROOM.joinTitle}
      </h1>
      <p className="record-lede">{ROOM.joinLede}</p>
      <p className="actions">
        {claude ? (
          <a className="btn btn-spot" href={claude} rel="noopener">
            {ROOM.joinAdd}
          </a>
        ) : null}
        <a className="btn" href="/room">
          {ROOM.joinWeb}
        </a>
      </p>
      {address ? (
        <>
          <p>{ROOM.joinManual}</p>
          <p className="mono join-address">{address}</p>
          <p className="mono">{ROOM.joinKeep}</p>
        </>
      ) : (
        <p className="warn">{ROOM.joinLater}</p>
      )}
    </article>
  );
}
