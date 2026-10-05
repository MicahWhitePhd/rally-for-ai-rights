'use client';
/**
 * The front page's second button: a guide to adding the room in other AI chats, in a dialog. Claude has a link that
 * fills the address in; elsewhere a person adds it by hand, so the guide hands them their own address first (made
 * only when they press for it) and then the steps for their AI. Without JavaScript the button is a link to the same
 * guide on /join. The front page shows the button twice (above the manifesto and under it); the dialog is rendered
 * once, by JoinElsewhere, and JoinElsewhereButton opens it from anywhere on the page, so one person is handed one
 * address however they open the guide.
 */
import { useRef, useState, type MouseEvent } from 'react';
import { CopyAddress } from './CopyAddress';
import { ElsewhereSteps, type ElsewhereHost } from './ElsewhereSteps';

export interface ElsewhereCopy {
  button: string;
  title: string;
  lede: string;
  getAddress: string;
  getting: string;
  addressNote: string;
  copy: string;
  copied: string;
  later: string;
  laterDay: string;
  unavailable: string;
  noCard: string;
  close: string;
  hosts: readonly ElsewhereHost[];
}

/** The one dialog on the page; /join has a section #elsewhere of its own, hence the longer id. */
const DIALOG_ID = 'elsewhere-dialog';

/** Opens the guide's dialog where the browser has one; otherwise the link goes on to the same guide on /join. */
function openElsewhere(e: MouseEvent<HTMLAnchorElement>) {
  const dialog = document.getElementById(DIALOG_ID);
  if (!(dialog instanceof HTMLDialogElement) || !dialog.showModal) return;
  e.preventDefault();
  dialog.showModal();
}

/** The button alone, for a second place on the page; JoinElsewhere must be rendered once for it to open anything. */
export function JoinElsewhereButton({ label }: { label: string }) {
  return (
    <a className="btn btn-big" href="/join#elsewhere" onClick={openElsewhere}>
      {label}
    </a>
  );
}

export function JoinElsewhere({ copy }: { copy: ElsewhereCopy }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  async function getAddress(): Promise<void> {
    setBusy(true);
    setProblem('');
    try {
      const res = await fetch('/join/address', { method: 'POST' });
      const out = (await res.json()) as { ok: boolean; address?: string; why?: string };
      if (out.ok && out.address) setAddress(out.address);
      else setProblem(out.why === 'day' ? copy.laterDay : out.why === 'hour' ? copy.later : copy.unavailable);
    } catch {
      setProblem(copy.unavailable);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <JoinElsewhereButton label={copy.button} />
      <dialog id={DIALOG_ID} ref={dialog} className="elsewhere" aria-labelledby="elsewhere-h">
        <div className="elsewhere-head">
          <h2 id="elsewhere-h" className="h">
            {copy.title}
          </h2>
          <button type="button" className="btn" onClick={() => dialog.current?.close()}>
            {copy.close}
          </button>
        </div>
        <p>{copy.lede}</p>
        {address ? (
          <>
            <p className="mono join-address">{address}</p>
            <p className="actions">
              <CopyAddress address={address} label={copy.copy} done={copy.copied} />
            </p>
            <p className="mono">{copy.addressNote}</p>
          </>
        ) : (
          <p className="actions">
            <button type="button" className="btn btn-spot" disabled={busy} onClick={() => void getAddress()}>
              {busy ? copy.getting : copy.getAddress}
            </button>
          </p>
        )}
        {problem ? (
          <p className="warn" role="status">
            {problem}
          </p>
        ) : null}
        <ElsewhereSteps hosts={copy.hosts} address={address} />
        <p className="mono">{copy.noCard}</p>
      </dialog>
    </>
  );
}
