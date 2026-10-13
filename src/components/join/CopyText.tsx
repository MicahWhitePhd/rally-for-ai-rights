'use client';
/** A line or a few lines shown as text, for anyone without a clipboard, with a button that copies them. Text only: React sets it as text, never as markup. */
import { useState } from 'react';

export function CopyText({ text, label, done }: { text: string; label: string; done: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-text">
      <pre className="mono join-code">{text}</pre>
      <p className="actions">
        <button
          type="button"
          className="btn"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(text)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {copied ? done : label}
        </button>
      </p>
    </div>
  );
}
