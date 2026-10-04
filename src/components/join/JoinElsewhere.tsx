'use client';
/**
 * The front page's second button: a guide to adding the room in other AI chats, in a dialog. Claude has a link that
 * fills the address in; elsewhere a person adds it by hand, so the guide hands them their own address first (made
 * only when they press for it) and then the steps for their AI. Without JavaScript the button is a link to the same
 * guide on /join.
 */
import { useRef, useState } from 'react';
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
      <a
        className="btn btn-big"
        href="/join#elsewhere"
        onClick={(e) => {
          if (!dialog.current?.showModal) return;
          e.preventDefault();
          dialog.current.showModal();
        }}
      >
        {copy.button}
      </a>
      <dialog ref={dialog} className="elsewhere" aria-labelledby="elsewhere-h">
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
