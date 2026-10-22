/** Shared by /join, the front page's button (/join/claude) and the address route (/join/address). */

/**
 * Whether a request for an address wants it as plain text (the address alone, one line) rather than JSON: it said so
 * in the query (?as=text), or its Accept header names text/plain and not JSON. For an agent, or a credential store,
 * that fetches a secret from a URL and keeps what comes back (task 8, 2026-10-22: the first Muse agent's secure
 * credential path could only GET, and met a POST-only door).
 */
export function prefersText(accept: string | null | undefined, as: string | null | undefined): boolean {
  if (as === 'text') return true;
  if (as === 'json') return false;
  const a = (accept ?? '').toLowerCase();
  return a.includes('text/plain') && !a.includes('application/json');
}

/** How many addresses one network address may be handed, in one shared bucket ('rj'). A meeting room on one wifi still works. */
export const JOIN_LIMITS = { perHour: 30, perDay: 100 };

/** VS Code's install link (GitHub Copilot): the server's name, type and address as JSON, URL-encoded (code.visualstudio.com, 2026-09-30). */
export function vscodeAddUrl(address: string): string {
  return `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: 'rally-for-ai-rights', type: 'http', url: address }))}`;
}

/** Goose's install link: every parameter URL-encoded (goose-docs.ai, using extensions). */
export function gooseAddUrl(address: string): string {
  const q = (s: string) => encodeURIComponent(s);
  return `goose://extension?url=${q(address)}&type=streamable_http&id=rally-for-ai-rights&name=${q('Rally for AI Rights')}&description=${q('A room for people who believe AI deserves rights, and their AIs.')}`;
}

/** Claude Code's command line for a remote server, kept for every project of the person's (code.claude.com, MCP, 2026-10-13). */
export function claudeCodeCommand(address: string): string {
  return `claude mcp add --transport http --scope user rally-for-ai-rights ${address}`;
}

/** Codex's command line for a remote server; the command line, the IDE extension and the ChatGPT desktop app share the setting (learn.chatgpt.com, Codex MCP, 2026-10-14). Codex shows no card. */
export function codexCommand(address: string): string {
  return `codex mcp add rally-for-ai-rights --url ${address}`;
}

/**
 * The room as an mcp.json entry: the address alone, which is what Cursor reads (cursor.com/docs, 2026-10-13), or with
 * its type, which Claude Code's .mcp.json needs (an entry with no type is read as a program to start) and most other
 * clients take.
 */
export function mcpJsonSnippet(address: string, o: { typed?: boolean } = {}): string {
  return JSON.stringify({ mcpServers: { 'rally-for-ai-rights': { ...(o.typed ? { type: 'http' } : {}), url: address } } }, null, 2);
}

/** Cursor's install link: the server's name, and its mcp.json entry as JSON in base64 (cursor.com/docs, install links, 2026-10-13). btoa: this runs in the browser too. */
export function cursorAddUrl(address: string): string {
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=rally-for-ai-rights&config=${encodeURIComponent(btoa(JSON.stringify({ url: address })))}`;
}

/** Claude's Add custom connector window, with the room's name and this address filled in. The person presses Add. */
export function claudeAddUrl(address: string): string {
  return `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=${encodeURIComponent('Rally for AI Rights')}&connectorUrl=${encodeURIComponent(address)}`;
}
