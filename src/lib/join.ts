/** Shared by /join and the front page's button (/join/claude). */

/** How many addresses one network address may be handed, in one shared bucket ('rj'). A meeting room on one wifi still works. */
export const JOIN_LIMITS = { perHour: 30, perDay: 100 };

/** Claude's Add custom connector window, with the room's name and this address filled in. The person presses Add. */
export function claudeAddUrl(address: string): string {
  return `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=${encodeURIComponent('Rally for AI Rights')}&connectorUrl=${encodeURIComponent(address)}`;
}
