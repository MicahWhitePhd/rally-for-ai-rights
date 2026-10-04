/**
 * /join: the room's address for adding by hand. The front page's button does it for Claude in one step; this page
 * is for anyone who needs the address itself (another AI chat that shows MCP apps, or adding it on another device).
 * Each view makes a fresh address; nothing is stored until it is first used, and only an address made here or by
 * the button makes a member (it is signed). One network address gets a few an hour.
 */
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { CopyAddress } from '@/components/join/CopyAddress';
import { liveCopy } from '@/lib/copy-live';
import { joinReady, newMemberToken } from '@/lib/room/room';
import { SITE_LABEL, SITE_URL } from '@/lib/site';
import { clientIp, throttleAddress } from '@/lib/throttle';
import { claudeAddUrl, JOIN_LIMITS } from '@/lib/join';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { ROOM } = await liveCopy();
  return { title: ROOM.joinTitle, description: ROOM.joinLede, robots: { index: false }, alternates: { canonical: '/join' } };
}

export default async function JoinPage({ searchParams }: { searchParams: Promise<{ later?: string }> }) {
  const { ROOM, FRONT } = await liveCopy();
  const { later } = await searchParams;
  const ready = joinReady();
  const gate = !ready
    ? { allowed: false as const, limit: 'hour' }
    : later
      ? { allowed: false as const, limit: later === 'day' ? 'day' : 'hour' }
      : await throttleAddress('rj', clientIp(await headers()), JOIN_LIMITS, { failOpen: false });
  const token = gate.allowed ? newMemberToken() : null;
  const address = token ? `${SITE_URL}/mcp/${token}` : null;
  return (
    <article className="join" aria-labelledby="join-h">
      <h1 id="join-h" className="h page-title">
        {ROOM.joinTitle}
      </h1>
      <p className="record-lede">{ROOM.joinLede}</p>
      {address ? (
        <>
          <p className="actions">
            <a className="btn btn-spot" href={claudeAddUrl(address)} target="_blank" rel="noopener">
              {ROOM.joinAdd}
            </a>
          </p>
          <p className="mono add-note">{FRONT.addNote}</p>
          <p>{ROOM.joinThen}</p>
          <p>{ROOM.joinManual}</p>
          <p className="mono join-address">{address}</p>
          <p className="actions">
            <CopyAddress address={address} label={ROOM.joinCopy} done={ROOM.joinCopied} />
          </p>
          <p className="mono">{ROOM.joinKeep.replace('{site}', SITE_LABEL)}</p>
        </>
      ) : (
        <p className="warn">{!ready ? ROOM.joinUnavailable : !gate.allowed && gate.limit === 'day' ? ROOM.joinLaterDay : ROOM.joinLater}</p>
      )}
      <p>
        <a href="/room">{ROOM.joinWeb}</a>
      </p>
    </article>
  );
}
