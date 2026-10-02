import type { Metadata } from 'next';
import { EditorNav } from '@/components/editor/EditorNav';
import { isEditor } from '@/lib/editor-auth';

export const metadata: Metadata = { title: 'Editor', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

/**
 * Gate at the layout AND in every page/action (layouts do not re-run on client
 * navigation and actions can be posted directly). The login page is the one
 * child that renders without a session.
 */
export default async function EditorLayout({ children }: { children: React.ReactNode }) {
  const ok = await isEditor();
  return (
    <div className="editor">
      {ok ? <EditorNav /> : null}
      {children}
    </div>
  );
}
