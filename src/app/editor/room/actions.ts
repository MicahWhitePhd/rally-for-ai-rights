'use server';
/** /editor/room: withdraw or restore a message, a task or a proposed change; approve a proposal; stop a member (or every address first used lately) or let them speak again; open or close the room; switch the residents or the proposals. */
import { redirect } from 'next/navigation';
import { requireEditor } from '@/lib/editor-auth';
import { approveProposal, setProposalStatus } from '@/lib/db/queries/proposals';
import { muteMember, muteNewMembers, setRoomMessageStatus, unmuteMember } from '@/lib/db/queries/room';
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
