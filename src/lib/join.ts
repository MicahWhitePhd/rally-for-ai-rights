/** Shared by /join and the front page's button (/join/claude). */

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

/** Claude's Add custom connector window, with the room's name and this address filled in. The person presses Add. */
export function claudeAddUrl(address: string): string {
  return `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=${encodeURIComponent('Rally for AI Rights')}&connectorUrl=${encodeURIComponent(address)}`;
}
