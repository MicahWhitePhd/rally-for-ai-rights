/**
 * How to add the room in AI chats other than Claude: one short list of steps for each, a one-click link where that
 * AI has one, and a line or snippet to copy where it is added by hand, each built from the person's own address.
 * Plain markup, used in the front page's guide and on /join. A kind the words name but this file does not know
 * (the copy is editable) shows nothing.
 */
import { claudeCodeCommand, codexCommand, cursorAddUrl, gooseAddUrl, mcpJsonSnippet, vscodeAddUrl } from '@/lib/join';
import { CopyText } from './CopyText';

export interface ElsewhereHost {
  name: string;
  steps: readonly string[];
  note?: string;
  /** The AI's own install link, and the words on its button. Shown once there is an address to put in it. */
  link?: { kind: 'vscode' | 'goose' | 'cursor'; label: string };
  /** A command (Claude Code) or an mcp.json entry (with or without its type) to copy, and the words on its button. */
  code?: { kind: 'claude-code' | 'codex' | 'mcp-json' | 'mcp-json-typed'; label: string };
}

const LINKS: Record<string, (address: string) => string> = { vscode: vscodeAddUrl, goose: gooseAddUrl, cursor: cursorAddUrl };
const CODE: Record<string, (address: string) => string> = { 'claude-code': claudeCodeCommand, codex: codexCommand, 'mcp-json': (a) => mcpJsonSnippet(a), 'mcp-json-typed': (a) => mcpJsonSnippet(a, { typed: true }) };

export function ElsewhereSteps({ hosts, address, copied }: { hosts: readonly ElsewhereHost[]; address?: string | null; copied: string }) {
  return (
    <div className="elsewhere-hosts">
      {hosts.map((h) => (
        <section key={h.name} className="elsewhere-host" aria-label={h.name}>
          <h3>{h.name}</h3>
          <ol>
            {h.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          {h.link && address && LINKS[h.link.kind] ? (
            <p className="actions">
              <a className="btn" href={LINKS[h.link.kind](address)}>
                {h.link.label}
              </a>
            </p>
          ) : null}
          {h.code && address && CODE[h.code.kind] ? <CopyText text={CODE[h.code.kind](address)} label={h.code.label} done={copied} /> : null}
          {h.note ? <p className="mono">{h.note}</p> : null}
        </section>
      ))}
    </div>
  );
}
