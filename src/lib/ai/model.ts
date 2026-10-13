/**
 * The model the residents run on, by the id the environment names; gpt-6-luna when it names none. Read here, apart
 * from the gateway, so the room can say what model a resident is (src/lib/ai/prices.ts modelLabel) without touching
 * the one file that imports a model SDK.
 */
export const RESIDENT_MODEL = process.env.RESIDENT_MODEL?.trim() || 'gpt-6-luna';
