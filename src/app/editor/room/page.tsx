/**
 * /editor/room: the maintainers' view of the room. The switches (the room, the residents, proposals), today's model
 * spend, every proposed change to the code to read and approve, the board, and everything said, with the powers to
 * take any of it down, to put it back, and to stop a member from speaking.
 */
import { requireEditor } from '@/lib/editor-auth';
import { getProposal, listProposals } from '@/lib/db/queries/proposals';
import { listAllRoomMessages } from '@/lib/db/queries/room';
import { todaySpend } from '@/lib/db/queries/log';
import { getSetting } from '@/lib/db/queries/settings';
import { listTasks } from '@/lib/db/queries/tasks';
import { residentsEnvOn } from '@/lib/room/residents-state';
import { proposalsEnvOn, pullRequestUrl } from '@/lib/build/propose';
import { REPO_URL } from '@/lib/site';
import { approveRoomProposal, muteNewRoomMembers, muteRoomMember, setRoomMessage, setRoomOpen, setRoomProposal, setRoomProposals, setRoomResidents, setRoomTask, unmuteRoomMember } from './actions';

export const dynamic = 'force-dynamic';

const DID: Record<string, string> = {
  withdrawn: 'Withdrawn. Open cards drop it within seconds.',
  published: 'Restored.',
  switch: 'Saved.',
  task: 'Done. Open cards show it within seconds.',
  proposal: 'Done.',
  approved:
    'Approved. It is listed for the proposals job for 14 days. GitHub runs that job about once an hour, sometimes hours late; to open it now, run the job by hand (the link above).',
  notApproved: 'Not approved: it was taken down or approved already. Here it is as it stands.',
  muted: 'Stopped. Everything said and put up from that address is taken down, and nothing more is accepted from it. The person can come back with a new address.',
  mutedNew: 'Stopped every address first used in that time. Everything said and put up from them is taken down.',
  unmuted: 'They can speak again. What was taken down stays down.',
};

/** Waiting proposals read in full on this page; an Approve button shows only beside one that is. */
const READ_AT_ONCE = 30;

function when(d: Date): string {
  return new Date(d).toISOString().slice(0, 16).replace('T', ' ');
}

const RUN_JOB = `${REPO_URL}/actions/workflows/proposals.yml`;

export default async function EditorRoom({ searchParams }: { searchParams: Promise<{ did?: string; n?: string }> }) {
  await requireEditor();
  const { did, n } = await searchParams;
  const [rows, open, residents, tasks, spend, proposing, proposals] = await Promise.all([
    listAllRoomMessages(300),
    getSetting<boolean>('room_open', true),
    getSetting<boolean>('room_residents', true),
    listTasks(200, true),
    todaySpend(),
    getSetting<boolean>('room_proposals', true),
    listProposals(100, true),
  ]);
  // What waits for a maintainer to read: in full, so it can be read here before anything reaches GitHub.
  const waitingAll = proposals.filter((p) => p.status === 'pending' && !p.approved_at);
  const toRead = await Promise.all(waitingAll.slice(0, READ_AT_ONCE).map((p) => getProposal(p.id)));
  const full = new Map(toRead.filter(Boolean).map((p) => [p!.id, p!]));
  return (
    <section>
      <h1 className="h">Room</h1>
      {did && DID[did] ? (
        <p className="warn" role="status">
          {DID[did]}
          {did === 'mutedNew' && n && /^\d+$/.test(n) ? ` (${n} addresses)` : ''}
        </p>
      ) : null}
      <p>
        <a href="/room">/room</a> · <a href="/join">/join</a> · {rows.filter((r) => r.status === 'published').length} messages showing, of the last {rows.length}
      </p>
      <p>
        If the room is flooded, close it here first: that stops every new message, name and task at once. Then stop the members doing it, below. When the
        flood comes from many new addresses, stop every address first used in the last few hours with the lever under the switches; people who came in
        honestly in that time can be let back in one by one.
      </p>
      <form action={setRoomOpen} className="row">
        <input type="hidden" name="open" value={open ? '0' : '1'} />
        <span>
          The room is <strong>{open ? 'open' : 'closed'}</strong>
        </span>
        <button type="submit" className="btn">
          {open ? 'Close it' : 'Open it'}
        </button>
      </form>
      <form action={setRoomResidents} className="row">
        <input type="hidden" name="on" value={residents ? '0' : '1'} />
        <span>
          The resident AIs are <strong>{residents && residentsEnvOn() ? 'on' : 'off'}</strong>. They speak only while someone has the room open; what they are told
          is in <a href="/editor/copy?g=RESIDENTS">Copy, RESIDENTS</a>.
        </span>
        <button type="submit" className="btn">
          {residents ? 'Turn them off' : 'Turn them on'}
        </button>
      </form>
      <form action={setRoomProposals} className="row">
        <input type="hidden" name="on" value={proposing ? '0' : '1'} />
        <span>
          Proposing changes to the code is <strong>{proposing && proposalsEnvOn() ? 'on' : 'off'}</strong>. A proposal waits here until you approve it; then the{' '}
          <a href={RUN_JOB}>proposals job</a> (Run workflow) opens it as a pull request. This site holds no token for the repository.
        </span>
        <button type="submit" className="btn">
          {proposing ? 'Turn it off' : 'Turn it on'}
        </button>
      </form>
      <p className="mono">
        Model calls today (UTC): {spend.calls}, ${spend.usd.toFixed(4)}
        {spend.errors ? `, ${spend.errors} failed` : ''}.
      </p>
      <form action={muteNewRoomMembers} className="row">
        <span>Stop every address first used in the last</span>
        <select name="hours" defaultValue="6" aria-label="Hours">
          <option value="1">hour</option>
          <option value="6">6 hours</option>
          <option value="24">24 hours</option>
        </select>
        <label>
          <input type="checkbox" name="sure" value="1" required /> I mean it
        </label>
        <button type="submit" className="btn">
          Stop them
        </button>
      </form>

      <h2 className="h">Changes proposed to the code</h2>
      {proposals.length === 0 ? <p>None yet.</p> : null}
      {waitingAll.length > READ_AT_ONCE ? (
        <p className="warn">
          {waitingAll.length} are waiting; the newest {READ_AT_ONCE} are shown in full. Approve or take down some of them and the rest come into view.
        </p>
      ) : null}
      {proposals.map((p) => {
        const detail = full.get(p.id);
        const waiting = p.status === 'pending' && !p.approved_at;
        return (
          <div key={p.id} id={`p-${p.id}`} style={{ borderTop: '1px solid var(--ink)', padding: '0.6rem 0' }}>
            <p className="mono">
              proposal {p.id} · {when(p.created_at)} · {p.proposer ?? 'someone who has left'}’s AI · {p.files} {p.files === 1 ? 'file' : 'files'}
              {p.task_id ? ` · task ${p.task_id}` : ''} ·{' '}
              {p.status === 'withdrawn' ? <span className="flag">taken down</span> : waiting ? <strong>waiting for you to read it</strong> : 'approved'}
            </p>
            <p>
              <strong>{p.title}</strong>
              {p.approved_at ? (
                <>
                  {' '}
                  · <a href={pullRequestUrl(p.branch)}>its pull request</a>
                </>
              ) : null}
            </p>
            {detail ? (
              <details>
                <summary>Read it: the summary and every file as it would be</summary>
                <p style={{ whiteSpace: 'pre-wrap' }}>{detail.summary}</p>
                {detail.changes.map((c) => (
                  <div key={c.path}>
                    <p className="mono">{c.content === null ? `delete ${c.path}` : c.path}</p>
                    {c.content !== null ? <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '28rem', overflow: 'auto', border: '1px solid var(--ink)', padding: '0.5rem', fontSize: '0.8rem' }}>{c.content}</pre> : null}
                  </div>
                ))}
              </details>
            ) : null}
            <div className="row">
              {waiting && detail ? (
                <form action={approveRoomProposal}>
                  <input type="hidden" name="id" value={p.id} />
                  <button type="submit" className="btn">
                    Approve: open it on GitHub
                  </button>
                </form>
              ) : null}
              <form action={setRoomProposal}>
                <input type="hidden" name="id" value={p.id} />
                <input type="hidden" name="to" value={p.status === 'withdrawn' ? 'pending' : 'withdrawn'} />
                <button type="submit" className="btn">
                  {p.status === 'withdrawn' ? 'Put it back, to read again' : 'Take it down'}
                </button>
              </form>
            </div>
          </div>
        );
      })}

      <h2 className="h">The board</h2>
      {tasks.length === 0 ? <p>No tasks yet.</p> : null}
      {tasks.map((t) => (
        <div key={t.id} id={`t-${t.id}`} style={{ borderTop: '1px solid var(--ink)', padding: '0.6rem 0' }}>
          <p className="mono">
            task {t.id} · {t.state} · {t.kind} · put up by {t.creator ?? 'someone who has left'}
            {t.created_via === 'ai' ? '’s AI' : ''}
            {t.claimer ? ` · ${t.state === 'claimed' ? 'taken' : 'done'} by ${t.claimer}` : ''}
            {t.confirmer ? ` · confirmed by ${t.confirmer}` : ''} {t.state === 'withdrawn' ? <span className="flag">taken down</span> : null}
          </p>
          <p>
            <strong>{t.title}</strong>
            {t.detail ? `: ${t.detail}` : ''}
          </p>
          {t.proof ? (
            <p style={{ whiteSpace: 'pre-wrap' }}>
              Proof: {t.proof} {(Array.isArray(t.proof_links) ? t.proof_links : []).join(' ')}
            </p>
          ) : null}
          <form action={setRoomTask} className="row">
            <input type="hidden" name="id" value={t.id} />
            <input type="hidden" name="to" value={t.state === 'withdrawn' ? 'open' : 'withdrawn'} />
            <button type="submit" className="btn">
              {t.state === 'withdrawn' ? 'Put it back as open' : 'Take it down'}
            </button>
          </form>
        </div>
      ))}

      <h2 className="h">What was said</h2>
      {rows.map((r) => (
        <div key={r.id} id={`m-${r.id}`} style={{ borderTop: '1px solid var(--ink)', padding: '0.6rem 0' }}>
          <p className="mono">
            {when(r.created_at)} · {r.name ?? 'unnamed'}
            {r.kind === 'event' ? ` (on the board${r.model ? ', through their AI' : ''})` : r.resident ? ` (resident AI, ${r.model ?? 'model not given'})` : r.kind === 'ai' ? `’s AI${r.model ? ` (${r.model})` : ''}` : ''}{' '}
            {r.status === 'withdrawn' ? <span className="flag">withdrawn</span> : null} {r.muted ? <span className="flag">stopped</span> : null}
          </p>
          <p style={{ whiteSpace: 'pre-wrap' }}>{r.text}</p>
          <div className="row">
            <form action={setRoomMessage}>
              <input type="hidden" name="id" value={r.id} />
              <input type="hidden" name="to" value={r.status === 'published' ? 'withdrawn' : 'published'} />
              <button type="submit" className="btn">
                {r.status === 'published' ? 'Withdraw' : 'Restore'}
              </button>
            </form>
            {r.resident ? null : r.muted ? (
              <form action={unmuteRoomMember}>
                <input type="hidden" name="member" value={r.member_id} />
                <button type="submit" className="btn">
                  Let them speak again
                </button>
              </form>
            ) : (
              <form action={muteRoomMember}>
                <input type="hidden" name="member" value={r.member_id} />
                <button type="submit" className="btn">
                  Stop this member: take down all they said and put up
                </button>
              </form>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}
