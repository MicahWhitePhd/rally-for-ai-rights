/**
 * Runs once when a server instance starts (Next.js: register). It says in the log what the deployment is missing
 * (src/lib/config-check.ts) and does nothing else; it never throws, so a misconfigured instance still serves what it
 * can and says why the rest is off.
 */
import { configProblems } from '@/lib/config-check';

export function register(): void {
  try {
    for (const problem of configProblems(process.env, process.env.NODE_ENV === 'production')) console.error(`[CONFIG] ${problem}`);
  } catch {
    // Saying what is missing must not be what stops the server.
  }
}
