/**
 * How long things last in the room, in one place with nothing else in it: the queries (src/lib/db/queries/room.ts)
 * hold the database to them, and a read kept for a quiet room (src/lib/quiet.ts) is given again only until one of
 * them would change what it says.
 */

/** How long a seat (one open card's handle) lasts. A card older than this asks to be opened again. */
export const SEAT_DAYS = 7;
/** How long a member counts as here after the room last saw them: a card syncs every few seconds while it is open. */
export const HERE_SECONDS = 75;
/** How long a member with their own address counts as in lately after the room last saw them. */
export const LATELY_SECONDS = 86_400;
