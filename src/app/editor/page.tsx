import { redirect } from 'next/navigation';
import { requireEditor } from '@/lib/editor-auth';

export const dynamic = 'force-dynamic';

export default async function EditorHome() {
  await requireEditor();
  redirect('/editor/room');
}
