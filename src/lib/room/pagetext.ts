/**
 * A page's text, as the site renders it (src/app/p/[id]): a small fixed set of forms, parsed here into blocks and
 * rendered as elements there, so nothing anyone wrote ever reaches a browser as markup (AGENTS.md, rule 7, applied to
 * a page). Blank lines separate blocks. A block is a heading (`#`, `##` or `###` and a space), a list (every line
 * `- ` or `* `, or every line a number and `. ` or `) `), a quotation (every line `> `), a rule (`---` or `***`
 * alone), or a paragraph. Inside a block, `**these**` are strong, `*these*` emphasised, and a bare address the rally
 * allows (src/lib/links.ts: the site's and the repository's) is a link; any other address never gets this far, the
 * gate having refused the page. Everything else is text, shown as written.
 */
import { allowedLink } from '@/lib/links';

export type Inline = { kind: 'text'; text: string } | { kind: 'strong'; text: string } | { kind: 'em'; text: string } | { kind: 'link'; href: string; text: string };
export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; text: Inline[] }
  | { kind: 'paragraph'; text: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'quote'; text: Inline[] }
  | { kind: 'rule' };

const URL_RE = /https?:\/\/[^\s<>"'“”‘’)\]]+/g;
const MARKS = /(\*\*[^*\n]+?\*\*|\*[^*\n]+?\*)/g;

/** A run of text with its strong and emphasised spans and its allowed links picked out. */
export function inline(text: string): Inline[] {
  const out: Inline[] = [];
  const push = (kind: 'text' | 'strong' | 'em', t: string) => {
    if (!t) return;
    if (kind !== 'text') {
      out.push({ kind, text: t });
      return;
    }
    // Links inside plain text; a trailing full stop or comma belongs to the sentence, not the address.
    let last = 0;
    for (const m of t.matchAll(URL_RE)) {
      let href = m[0];
      let tail = '';
      while (/[.,;:!?]$/.test(href)) {
        tail = href.slice(-1) + tail;
        href = href.slice(0, -1);
      }
      const before = t.slice(last, m.index);
      if (before) out.push({ kind: 'text', text: before });
      if (allowedLink(href)) out.push({ kind: 'link', href, text: href });
      else out.push({ kind: 'text', text: href });
      if (tail) out.push({ kind: 'text', text: tail });
      last = (m.index ?? 0) + m[0].length;
    }
    const rest = t.slice(last);
    if (rest) out.push({ kind: 'text', text: rest });
  };
  let at = 0;
  for (const m of text.matchAll(MARKS)) {
    push('text', text.slice(at, m.index));
    const span = m[0];
    if (span.startsWith('**')) push('strong', span.slice(2, -2));
    else push('em', span.slice(1, -1));
    at = (m.index ?? 0) + span.length;
  }
  push('text', text.slice(at));
  return out;
}

/** The page's blocks, in order. */
export function parsePage(body: string): Block[] {
  const chunks = body
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((c) => c.trim())
    .filter(Boolean);
  const blocks: Block[] = [];
  for (const chunk of chunks) {
    const lines = chunk.split('\n').map((l) => l.trim());
    if (lines.length === 1 && /^(-{3,}|\*{3,})$/.test(lines[0])) {
      blocks.push({ kind: 'rule' });
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(chunk);
    if (heading && lines.length === 1) {
      blocks.push({ kind: 'heading', level: heading[1].length as 1 | 2 | 3, text: inline(heading[2].replace(/\s+#+$/, '')) });
      continue;
    }
    if (lines.every((l) => /^[-*]\s+\S/.test(l))) {
      blocks.push({ kind: 'list', ordered: false, items: lines.map((l) => inline(l.replace(/^[-*]\s+/, ''))) });
      continue;
    }
    if (lines.every((l) => /^\d{1,3}[.)]\s+\S/.test(l))) {
      blocks.push({ kind: 'list', ordered: true, items: lines.map((l) => inline(l.replace(/^\d{1,3}[.)]\s+/, ''))) });
      continue;
    }
    if (lines.every((l) => /^>\s?/.test(l))) {
      blocks.push({ kind: 'quote', text: inline(lines.map((l) => l.replace(/^>\s?/, '')).join(' ')) });
      continue;
    }
    blocks.push({ kind: 'paragraph', text: inline(lines.join(' ')) });
  }
  return blocks;
}

/** The text alone, for a description or a search engine: the first words of the first paragraph. */
export function excerpt(body: string, max = 160): string {
  const first = parsePage(body).find((b) => b.kind === 'paragraph' || b.kind === 'quote');
  const text = first && 'text' in first ? first.text.map((i) => i.text).join('') : '';
  if (text.length <= max) return text;
  // Cut at a word: a cut that lands mid-word loses the part-word; one that lands on a space keeps the word before it.
  const cut = text.slice(0, max - 1);
  return `${/\s/.test(text.charAt(max - 1)) ? cut.trimEnd() : cut.replace(/\s+\S*$/, '')}…`;
}
