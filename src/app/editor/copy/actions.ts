'use server';
/** /editor/copy: save or reset one string of the site's text. Each action checks the editor itself. */
import { redirect } from 'next/navigation';
import { requireEditor } from '@/lib/editor-auth';
import * as base from '@/lib/copy';
import { copyPaths, invalidateLiveCopy, parsePath } from '@/lib/copy-live';
import { deleteCopyOverride, setCopyOverride } from '@/lib/db/queries/copy';

const PATHS = new Set(copyPaths(base));

function defaultAt(path: string): string | null {
  const segs = parsePath(path);
  if (!segs) return null;
  let node: unknown = base;
  for (const s of segs) node = node !== null && typeof node === 'object' ? (node as Record<string | number, unknown>)[s] : undefined;
  return typeof node === 'string' ? node : null;
}

function back(path: string, did: string): never {
  const group = path.split(/[.[]/)[0];
  redirect(`/editor/copy?g=${encodeURIComponent(group)}&did=${did}#f-${encodeURIComponent(path).replace(/%/g, '_')}`);
}

export async function saveCopy(formData: FormData): Promise<void> {
  const { editor } = await requireEditor();
  const path = formData.get('path');
  const raw = formData.get('value');
  if (typeof path !== 'string' || !PATHS.has(path) || typeof raw !== 'string') redirect('/editor/copy?did=bad');
  const value = raw.replace(/\r\n/g, '\n').trim();
  const dflt = defaultAt(path);
  if (!value || value === dflt) await deleteCopyOverride(path);
  else await setCopyOverride(path, value, editor);
  invalidateLiveCopy();
  console.log(`[COPY] ${editor} ${!value || value === dflt ? 'reset' : 'set'} ${path}`);
  back(path, !value || value === dflt ? 'reset' : 'saved');
}

export async function resetCopy(formData: FormData): Promise<void> {
  const { editor } = await requireEditor();
  const path = formData.get('path');
  if (typeof path !== 'string' || !PATHS.has(path)) redirect('/editor/copy?did=bad');
  await deleteCopyOverride(path);
  invalidateLiveCopy();
  console.log(`[COPY] ${editor} reset ${path}`);
  back(path, 'reset');
}
