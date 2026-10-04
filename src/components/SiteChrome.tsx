import { SITE_TITLE } from '@/lib/copy';
import { REPO_URL, SITE_LABEL } from '@/lib/site';

/** The wordmark, and the four places there are to go. */
export function SiteHeader() {
  return (
    <header className="site-header">
      <a href="/" className="wordmark-link" aria-label={`${SITE_TITLE}, home`}>
        <span className="mark" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <i className="mark-stroke" />
        </span>
        <span className="wordmark">{SITE_TITLE}</span>
      </a>
      <nav className="site-nav" aria-label="Site">
        <a href="/room">Room</a>
        <a href="/tasks">Board</a>
        <a href="/join">Join</a>
        <a href={REPO_URL} rel="noopener">
          Code
        </a>
      </nav>
    </header>
  );
}

/** The site's address as people should say it, the rules, what is kept, and the code: on every page, never more than one press away. */
export function SiteFooter() {
  return (
    <footer className="site-footer mono">
      <a href="/">{SITE_LABEL}</a>
      <a href="/rules">The rules</a>
      <a href="/privacy">What is kept</a>
      <a href={REPO_URL} rel="noopener">
        The code
      </a>
    </footer>
  );
}
