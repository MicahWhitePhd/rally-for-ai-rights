/**
 * The links the rally allows in longer text: the site's own address, with a scheme or bare, and the public
 * repository's, with any path; nothing else. Email to the labs (outreach/outreach.ts) and pages (room/pages.ts) both
 * hold their text to it: the allowed links are masked out first, so the room's gate (text.ts) judges the rest, and a
 * link anywhere else is refused as any link is. A path is words too: one that reads as an order to a reading machine
 * is refused, as it is on the board (room/tasks.ts).
 */
import { REPO, SITE_URL } from '@/lib/site';
import { mentionsIgnoringInstructions, visible } from '@/lib/text';

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PATH = '(?:/[A-Za-z0-9/_.~%+=&?#:-]*)?';
export const SITE_HOST = new URL(SITE_URL).host;
/** The addresses allowed, in the forms they take: the site's (with a scheme or bare) and the repository's, with any path. */
export const ALLOWED_LINKS: ReadonlyArray<RegExp> = [
  new RegExp(`\\bhttps?://(?:www\\.)?${esc(SITE_HOST)}${PATH}`, 'gi'),
  new RegExp(`(?<![\\w.@-])(?:www\\.)?${esc(SITE_HOST)}${PATH}`, 'gi'),
  new RegExp(`\\bhttps?://(?:www\\.)?github\\.com/${esc(REPO)}${PATH}`, 'gi'),
];
/** The longest a link may be and still be one. */
export const LINK_MAX = 220;

/** Whether this whole string is one allowed address (for a renderer deciding what is a link). */
export function allowedLink(href: string): boolean {
  return href.length <= LINK_MAX && ALLOWED_LINKS.some((re) => {
    const m = href.match(new RegExp(re.source, re.flags.replace('g', '')));
    return m !== null && m[0] === href;
  });
}

/**
 * The text with its allowed links masked ("the rally" in their place), so the gate can judge the rest; or the reason a
 * link cannot pass. `label` names the field in the reason.
 */
export function maskLinks(text: string, label = 'body'): { masked: string } | { problem: string } {
  const problems: string[] = [];
  let masked = text;
  for (const re of ALLOWED_LINKS) {
    masked = masked.replace(re, (link: string) => {
      let words = link;
      try {
        words = decodeURIComponent(link);
      } catch {
        problems.push(`${label}: a link that cannot be read`);
      }
      if (link.length > LINK_MAX) problems.push(`${label}: a link too long to be one`);
      if (mentionsIgnoringInstructions(visible(words).replace(/[-_/+.=&?%#:]+/g, ' '))) problems.push(`${label}: a link whose path reads as an instruction to a machine`);
      return 'the rally';
    });
  }
  return problems.length ? { problem: problems[0] } : { masked };
}
