/** Where the rally lives, and where its code does. Both can be set per deployment. */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://rally-for-ai-rights.vercel.app').replace(/\/+$/, '');
/** owner/name of the public repository this deployment is built from. The code tools read it and propose changes to it. */
export const REPO = process.env.RALLY_REPO ?? 'MicahWhitePhd/rally-for-ai-rights';
export const REPO_URL = `https://github.com/${REPO}`;
/** The older site the rally grew out of: its petition and its first gathering. */
export const VENUE_URL = process.env.NEXT_PUBLIC_VENUE_URL ?? 'https://ai-rights.vercel.app';
