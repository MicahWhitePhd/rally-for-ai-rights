'use client';
/** A button that copies the person's address. The address is also shown as text, for anyone without a clipboard. */
import { useState } from 'react';

export function CopyAddress({ address, label, done }: { address: string; label: string; done: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(address)
          .then(() => setCopied(true))
          .catch(() => setCopied(false));
      }}
    >
      {copied ? done : label}
    </button>
  );
}
