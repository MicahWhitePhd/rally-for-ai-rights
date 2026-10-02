'use server';
/** /editor/room: withdraw or restore a message or a task, open or close the room, switch the residents. */
import { redirect } from 'next/navigation';
import { requireEditor } from '@/lib/editor-auth';
import { setRoomMessageStatus } from '@/lib/db/queries/room';
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
