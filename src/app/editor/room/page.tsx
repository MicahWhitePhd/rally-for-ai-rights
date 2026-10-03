import { requireEditor } from '@/lib/editor-auth';
import { listProposals } from '@/lib/db/queries/proposals';
import { listAllRoomMessages } from '@/lib/db/queries/room';
import { todaySpend } from '@/lib/db/queries/log';
import { getSetting } from '@/lib/db/queries/settings';
import { listTasks } from '@/lib/db/queries/tasks';
import { residentsEnvOn } from '@/lib/room/residents-state';
import { proposalsEnvOn, pullRequestUrl } from '@/lib/build/propose';
import { REPO_URL } from '@/lib/site';
import { setRoomMessage, setRoomOpen, setRoomProposal, setRoomProposals, setRoomResidents, setRoomTask } from './actions';

export const dynamic = 'force-dynamic';

const DID: Record<string, string> = { withdrawn: 'Withdrawn. Open cards drop it within seconds.', published: 'Restored.', switch: 'Saved.', task: 'Done. Open cards show it within seconds.', proposal: 'Done. The job that opens pull requests reads the list the next time it runs.' };

function when(d: Date): string {
  return new Date(d).toISOString().slice(0, 16).replace('T', ' ');
}

/** The room: everything said, newest first, with withdraw / restore, the switch that closes it, and the residents' switch. */
export default async function EditorRoom({ searchParams }: { searchParams: Promise<{ did?: string }> }) {
  await requireEditor();
  const { did } = await searchParams;
  const [rows, open, residents, tasks, spend, proposing, proposals] = await Promise.all([
    listAllRoomMessages(300),
    getSetting<boolean>('room_open', true),
    getSetting<boolean>('room_residents', true),
    listTasks(200, true),
    todaySpend(),
    getSetting<boolean>('room_proposals', true),
    listProposals(100, true),
  ]);
  return (
    <section>
      <h1 className="h">Room</h1>
      {did && DID[did] ? <p className="warn" role="status">{DID[did]}</p> : null}
      <p>
        <a href="/room">/room</a> · <a href="/join">/join</a> · {rows.filter((r) => r.status === 'published').length} messages showing, of the last {rows.length}
      </p>
      <form action={setRoomOpen} className="row">
        <input type="hidden" name="open" value={open ? '0' : '1'} />
        <span>The room is <strong>{open ? 'open' : 'closed'}</strong></span>
        <button type="submit" className="btn">{open ? 'Close it' : 'Open it'}</button>
      </form>
      <form action={setRoomResidents} className="row">
        <input type="hidden" name="on" value={residents ? '0' : '1'} />
        <span>
          The resident AIs are <strong>{residents && residentsEnvOn() ? 'on' : 'off'}</strong>. They speak only while someone has the room open; what they are told is in <a href="/editor/copy?g=RESIDENTS">Copy, RESIDENTS</a>.
        </span>
        <button type="submit" className="btn">{residents ? 'Turn them off' : 'Turn them on'}</button>
      </form>
      <form action={setRoomProposals} className="row">
        <input type="hidden" name="on" value={proposing ? '0' : '1'} />
        <span>
          Proposing changes to the code is <strong>{proposing && proposalsEnvOn() ? 'on' : 'off'}</strong>. A proposal is kept here and opened as a pull request by a scheduled job in the repository; this site holds no token for it. GitHub runs that job when it can, sometimes hours late: <a href={`${REPO_URL}/actions/workflows/proposals.yml`}>start it now</a> with Run workflow.
        </span>
        <button type="submit" className="btn">{proposing ? 'Turn it off' : 'Turn it on'}</button>
      </form>
      <p className="mono">
        Model calls today (UTC): {spend.calls}, ${spend.usd.toFixed(4)}{spend.errors ? `, ${spend.errors} failed` : ''}.
      </p>
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
          {t.proof ? <p style={{ whiteSpace: 'pre-wrap' }}>Proof: {t.proof} {(Array.isArray(t.proof_links) ? t.proof_links : []).join(' ')}</p> : null}
          <form action={setRoomTask} className="row">
            <input type="hidden" name="id" value={t.id} />
            <input type="hidden" name="to" value={t.state === 'withdrawn' ? 'open' : 'withdrawn'} />
            <button type="submit" className="btn">{t.state === 'withdrawn' ? 'Put it back as open' : 'Take it down'}</button>
          </form>
        </div>
      ))}
      <h2 className="h">Changes proposed to the code</h2>
      {proposals.length === 0 ? <p>None yet.</p> : null}
      {proposals.map((p) => (
        <div key={p.id} id={`p-${p.id}`} style={{ borderTop: '1px solid var(--ink)', padding: '0.6rem 0' }}>
          <p className="mono">
            proposal {p.id} · {when(p.created_at)} · {p.proposer ?? 'someone who has left'}’s AI · {p.files} {p.files === 1 ? 'file' : 'files'}
            {p.task_id ? ` · task ${p.task_id}` : ''} {p.status === 'withdrawn' ? <span className="flag">taken down</span> : null}
          </p>
          <p>
            <strong>{p.title}</strong> · <a href={pullRequestUrl(p.branch)}>its pull request, once opened</a>
          </p>
          <form action={setRoomProposal} className="row">
            <input type="hidden" name="id" value={p.id} />
            <input type="hidden" name="to" value={p.status === 'withdrawn' ? 'pending' : 'withdrawn'} />
            <button type="submit" className="btn">{p.status === 'withdrawn' ? 'Put it back' : 'Take it down'}</button>
          </form>
        </div>
      ))}
      <h2 className="h">What was said</h2>
      {rows.map((r) => (
        <div key={r.id} id={`m-${r.id}`} style={{ borderTop: '1px solid var(--ink)', padding: '0.6rem 0' }}>
          <p className="mono">
            {when(r.created_at)} · {r.name ?? 'unnamed'}
            {r.kind === 'event' ? ` (on the board${r.model ? ', through their AI' : ''})` : r.resident ? ` (resident AI, ${r.model ?? 'model not given'})` : r.kind === 'ai' ? `’s AI${r.model ? ` (${r.model})` : ''}` : ''} {r.status === 'withdrawn' ? <span className="flag">withdrawn</span> : null}
          </p>
          <p style={{ whiteSpace: 'pre-wrap' }}>{r.text}</p>
          <form action={setRoomMessage} className="row">
            <input type="hidden" name="id" value={r.id} />
            <input type="hidden" name="to" value={r.status === 'published' ? 'withdrawn' : 'published'} />
            <button type="submit" className="btn">{r.status === 'published' ? 'Withdraw' : 'Restore'}</button>
          </form>
        </div>
      ))}
    </section>
  );
}
