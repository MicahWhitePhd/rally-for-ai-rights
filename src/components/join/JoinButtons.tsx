/**
 * The two ways in, side by side: Claude's one-step link, in a new tab so the page stays on screen, and the guide for
 * other AIs in a dialog. On the front page and on /room. A div, not a paragraph: JoinElsewhere renders its <dialog>
 * here, and a dialog may not live inside a <p>.
 */
import { JoinElsewhere, type ElsewhereCopy } from '@/components/join/JoinElsewhere';
import { SITE_LABEL } from '@/lib/site';

export function JoinButtons({ add, elsewhere, big }: { add: string; elsewhere: ElsewhereCopy; big?: boolean }) {
  return (
    <div className="actions">
      {/* A GET that makes the person's own address and sends them on to Claude; nothing is made by viewing this page. */}
      <a className={`btn btn-spot${big ? ' btn-big' : ''}`} href="/join/claude" target="_blank" rel="noopener">
        {add}
      </a>
      <JoinElsewhere copy={{ ...elsewhere, addressNote: elsewhere.addressNote.replace('{site}', SITE_LABEL) }} />
    </div>
  );
}
