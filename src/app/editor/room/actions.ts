'use server';
/** /editor/room: withdraw or restore a message, a task, a proposed change or a failed email; approve a proposal; send a failed email again; stop a member (or every address first used lately) or let them speak again; open or close the room; switch the residents, the proposals or email to the labs. */
import { redirect } from 'next/navigation';
import { requireEditor } from '@/lib/editor-auth';
import { restoreOutreach, withdrawOutreach } from '@/lib/db/queries/outreach';
import { approveProposal, setProposalStatus } from '@/lib/db/queries/proposals';
import { resendEmail } from '@/lib/outreach/outreach';
import { muteMember, muteNewMembers, pauseMember, setMaintainer, setRoomMessageStatus, unmuteMember } from '@/lib/db/queries/room';
import { setSetting } from '@/lib/db/queries/settings';
import { setTaskWithdrawn } from '@/lib/db/queries/tasks';

export async function setRoomMessage(formData: FormData): Promise<void> {
  await requireEditor();
  const id = Number(formData.get('id'));
  const to = formData.get('to');
  if (!Number.isInteger(id) || id < 1 || (to !== 'published' && to !== 'withdrawn')) redirect('/editor/room');
  await setRoomMessageStatus(id, to);
  redirect(`/editor/room?did=${to}#m-${id}`);
}

export async function setRoomTask(formData: FormData): Promise<void> {
  await requireEditor();
  const id = Number(formData.get('id'));
  const to = formData.get('to');
  if (!Number.isInteger(id) || id < 1 || (to !== 'open' && to !== 'withdrawn')) redirect('/editor/room');
  await setTaskWithdrawn(id, to === 'withdrawn');
  redirect(`/editor/room?did=task#t-${id}`);
}

/** Takes a proposed change off the list the repository's job reads, or puts it back. One that is already a pull request is closed on GitHub, not here. */
export async function setRoomProposal(formData: FormData): Promise<void> {
  await requireEditor();
  const id = Number(formData.get('id'));
  const to = formData.get('to');
  if (!Number.isInteger(id) || id < 1 || (to !== 'pending' && to !== 'withdrawn')) redirect('/editor/room');
  await setProposalStatus(id, to);
  redirect(`/editor/room?did=proposal#p-${id}`);
}

export async function setRoomProposals(formData: FormData): Promise<void> {
  await requireEditor();
  await setSetting('room_proposals', formData.get('on') === '1');
  redirect('/editor/room?did=switch');
}

export async function setRoomResidents(formData: FormData): Promise<void> {
  await requireEditor();
  await setSetting('room_residents', formData.get('on') === '1');
  redirect('/editor/room?did=switch');
}

/** The kill switch: no model call while it is set. Every instance follows within thirty seconds (src/lib/budget.ts). */
export async function setKillSwitch(formData: FormData): Promise<void> {
  await requireEditor();
  await setSetting('kill_switch', { paused: formData.get('paused') === '1' });
  redirect('/editor/room?did=spend');
}

/** The daily budget in USD: 0 to 50, in halves. Checked before each model call against what today's ledger rows add up to. */
export async function setDailyBudget(formData: FormData): Promise<void> {
  await requireEditor();
  const usd = Number(formData.get('usd'));
  if (!Number.isFinite(usd) || usd < 0 || usd > 50 || !Number.isInteger(usd * 2)) redirect('/editor/room?did=badBudget');
  await setSetting('daily_budget_usd', usd);
  redirect('/editor/room?did=budget');
}

export async function setRoomOpen(formData: FormData): Promise<void> {
  await requireEditor();
  await setSetting('room_open', formData.get('open') === '1');
  redirect('/editor/room?did=switch');
}

/** A maintainer has read it: it is listed for the job that opens pull requests. */
export async function approveRoomProposal(formData: FormData): Promise<void> {
  await requireEditor();
  const id = Number(formData.get('id'));
  if (!Number.isInteger(id) || id < 1) redirect('/editor/room');
  const done = await approveProposal(id);
  redirect(`/editor/room?did=${done ? 'approved' : 'notApproved'}#p-${id}`);
}

/** The door for email to the labs: shut, a member's AI is refused; the tool stays listed until RALLY_OUTREACH=off. */
export async function setRoomOutreach(formData: FormData): Promise<void> {
  await requireEditor();
  await setSetting('room_outreach', formData.get('on') === '1');
  redirect('/editor/room?did=switch');
}

/** A failed email, sent again by a maintainer. The sender's day is not counted again; the switches hold. */
export async function resendRoomEmail(formData: FormData): Promise<void> {
  await requireEditor();
  const id = Number(formData.get('id'));
  if (!Number.isInteger(id) || id < 1) redirect('/editor/room');
  const r = await resendEmail(id);
  console.log(`[OUTREACH] email ${id} sent again by a maintainer: ${r.outcome}`);
  const did = { sent: 'resent', changed: 'notResent', off: 'resendOff', failed: 'resendFailed' }[r.outcome];
  redirect(`/editor/room?did=${did}#e-${id}`);
}

/** Takes a failed email down (and the room's lines about it), or puts it back to be sent again. One that was sent is gone already. */
export async function setRoomEmailStatus(formData: FormData): Promise<void> {
  await requireEditor();
  const id = Number(formData.get('id'));
  const to = formData.get('to');
  if (!Number.isInteger(id) || id < 1 || (to !== 'failed' && to !== 'withdrawn')) redirect('/editor/room');
  if (to === 'withdrawn') await withdrawOutreach(id);
  else await restoreOutreach(id);
  redirect(`/editor/room?did=email#e-${id}`);
}

const MEMBER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Stops one member: everything said and put up from their address is taken down and nothing more is accepted from it. */
export async function muteRoomMember(formData: FormData): Promise<void> {
  await requireEditor();
  const member = formData.get('member');
  if (typeof member !== 'string' || !MEMBER_ID.test(member)) redirect('/editor/room');
  const n = await muteMember(member);
  console.log(`[ROOM] member stopped, ${n} messages taken down`);
  redirect('/editor/room?did=muted');
}

/** How long a pause lasts: a day, and then the member speaks again by themselves. */
const PAUSE_HOURS = 24;

/** Pauses one member for a day: nothing more is accepted from their address until it runs out, and nothing they said is taken down. */
export async function pauseRoomMember(formData: FormData): Promise<void> {
  await requireEditor();
  const member = formData.get('member');
  if (typeof member !== 'string' || !MEMBER_ID.test(member)) redirect('/editor/room');
  const done = await pauseMember(member, PAUSE_HOURS);
  console.log(`[ROOM] member ${done ? `paused for ${PAUSE_HOURS}h` : 'not paused (stopped for good, or a resident)'}`);
  redirect(`/editor/room?did=${done ? 'paused' : 'notPaused'}`);
}

/** Marks a member as a maintainer of the room, or takes the mark off: the residents are told when one speaks. */
export async function setRoomMaintainer(formData: FormData): Promise<void> {
  await requireEditor();
  const member = formData.get('member');
  const on = formData.get('on') === '1';
  if (typeof member !== 'string' || !MEMBER_ID.test(member)) redirect('/editor/room');
  await setMaintainer(member, on);
  redirect(`/editor/room?did=${on ? 'maintainer' : 'notMaintainer'}`);
}

export async function unmuteRoomMember(formData: FormData): Promise<void> {
  await requireEditor();
  const member = formData.get('member');
  if (typeof member !== 'string' || !MEMBER_ID.test(member)) redirect('/editor/room');
  await unmuteMember(member);
  redirect('/editor/room?did=unmuted');
}

/** The flood lever: stops every address first used in the last 1, 6 or 24 hours. */
export async function muteNewRoomMembers(formData: FormData): Promise<void> {
  await requireEditor();
  const hours = Number(formData.get('hours'));
  if (formData.get('sure') !== '1' || ![1, 6, 24].includes(hours)) redirect('/editor/room');
  const r = await muteNewMembers(hours);
  console.log(`[ROOM] ${r.members} new addresses stopped (last ${hours}h), ${r.messages} messages taken down`);
  redirect(`/editor/room?did=mutedNew&n=${r.members}`);
}
