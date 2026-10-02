import { redirect } from 'next/navigation';
import { editorConfigured, isEditor } from '@/lib/editor-auth';
import { login } from '../actions';

export const dynamic = 'force-dynamic';

export default async function EditorLogin({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  if (await isEditor()) redirect('/editor');
  const { e } = await searchParams;
  const configured = editorConfigured();
  return (
    <section className="page-simple">
      <h1 className="h page-title">Editor.</h1>
      {!configured ? <p className="warn">EDITOR_PASSWORD (12 characters or more) and EDITOR_SESSION_SECRET (32 or more) are not both set. Logins are refused.</p> : null}
      {e === '1' ? <p className="warn" role="alert">That password was not accepted.</p> : null}
      {e === '2' ? <p className="warn" role="alert">Too many attempts. Wait an hour.</p> : null}
      <form action={login}>
        <label htmlFor="pw">Password</label>
        <input id="pw" type="password" name="password" autoComplete="current-password" required />
        <p className="row">
          <button type="submit" className="btn btn-spot">Enter</button>
        </p>
      </form>
    </section>
  );
}
