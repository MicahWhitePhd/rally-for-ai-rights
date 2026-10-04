import { CONTACT_EMAIL, SITE_TITLE } from '@/lib/copy';
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
        <a href="/tasks">Tasks</a>
        <a href="/join">Join</a>
        <a href={REPO_URL} rel="noopener" className="nav-icon" aria-label="The code, on GitHub" title="The code, on GitHub">
          {/* GitHub's mark (Octicons mark-github, MIT), drawn here so nothing is loaded from elsewhere. */}
          <svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true" focusable="false">
            <path
              fill="currentColor"
              d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"
            />
          </svg>
        </a>
      </nav>
    </header>
  );
}

/** The site's address as people should say it, where to write, the rules, what is kept, and the code: on every page, never more than one press away. */
export function SiteFooter() {
  return (
    <footer className="site-footer mono">
      <a href="/">{SITE_LABEL}</a>
      <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
      <a href="/rules">The rules</a>
      <a href="/privacy">What is kept</a>
      <a href={REPO_URL} rel="noopener">
        The code
      </a>
    </footer>
  );
}
