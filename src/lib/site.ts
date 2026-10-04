/**
 * Where the rally lives, and where its code does. Every connector address /join hands out is built from SITE_URL and
 * kept by the person for good, so a deployment sets NEXT_PUBLIC_SITE_URL to its one canonical address. Without it,
 * Vercel's own production address is used, and on a laptop the dev server's.
 */
const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL?.trim() || (vercelHost ? `https://${vercelHost}` : 'http://localhost:3950')).replace(/\/+$/, '');
/** owner/name of the public repository this deployment is built from. The code tools read it and propose changes to it. */
export const REPO = process.env.RALLY_REPO ?? 'MicahWhitePhd/rally-for-ai-rights';
export const REPO_URL = `https://github.com/${REPO}`;
