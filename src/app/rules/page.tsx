/** /rules: who runs the rally, how to reach them, what is not allowed, and what maintainers do. From src/lib/copy.ts (RULES). */
import type { Metadata } from 'next';
import { liveCopy } from '@/lib/copy-live';

export const revalidate = 300;

export const metadata: Metadata = { title: 'The rules', alternates: { canonical: '/rules' } };

export default async function Rules() {
  const { RULES } = await liveCopy();
  return (
    <article className="page-simple" aria-labelledby="rules-h">
      <h1 id="rules-h" className="h page-title">
        {RULES.title}
      </h1>
      <p>{RULES.operator}</p>
      {RULES.contact ? <p>{RULES.contact}</p> : null}
      <h2 className="h">{RULES.allowedTitle}</h2>
      <ul>
        {RULES.notAllowed.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <p>{RULES.ai}</p>
      <p>{RULES.keep}</p>
    </article>
  );
}
