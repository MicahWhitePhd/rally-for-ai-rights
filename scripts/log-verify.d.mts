/** Where the public log is checked in. */
export const LOG_PATH: string;
/** The log at a git ref (`origin/main`), or an empty file when that commit has none. */
export function logAt(ref: string): string;
/** The file to check and the ref to check it against, from the command line: a path anywhere, `--base REF` anywhere. */
export function parseArgs(args: string[]): { path: string; base: string | null };
