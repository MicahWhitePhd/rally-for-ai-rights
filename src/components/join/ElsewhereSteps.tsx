/**
 * How to add the room in AI chats other than Claude: one short list of steps for each, and a one-click link where
 * that AI has one, built from the person's own address. Plain markup, used in the front page's guide and on /join.
 */
import { gooseAddUrl, vscodeAddUrl } from '@/lib/join';

export interface ElsewhereHost {
  name: string;
  steps: readonly string[];
  note?: string;
  /** The AI's own install link, and the words on its button. Shown once there is an address to put in it. */
  link?: { kind: 'vscode' | 'goose'; label: string };
}

const LINKS = { vscode: vscodeAddUrl, goose: gooseAddUrl };

export function ElsewhereSteps({ hosts, address }: { hosts: readonly ElsewhereHost[]; address?: string | null }) {
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
          {h.link && address ? (
            <p className="actions">
              <a className="btn" href={LINKS[h.link.kind](address)}>
                {h.link.label}
              </a>
            </p>
          ) : null}
          {h.note ? <p className="mono">{h.note}</p> : null}
        </section>
      ))}
    </div>
  );
}
