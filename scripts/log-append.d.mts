/** The date and the text from the command line: `--date` and the day after it, the rest as text; without `--date`, `today`. */
export function parseArgs(args: string[], today: string): { date: string; given: string };
