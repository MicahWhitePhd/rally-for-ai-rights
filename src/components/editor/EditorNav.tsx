import { logout } from '@/app/editor/actions';

export function EditorNav() {
  return (
    <nav className="editor-nav" aria-label="Editor">
      <a href="/editor/room">Room and board</a>
      <a href="/editor/copy">Copy</a>
      <a href="/">Site</a>
      <form action={logout} className="inline" style={{ marginLeft: 'auto' }}>
        <button type="submit">Log out</button>
      </form>
    </nav>
  );
}
