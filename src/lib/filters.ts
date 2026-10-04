/**
 * Prompt-safety filters for text that passes between people and models.
 *
 * PROSE_INJECTION_PATTERNS: phrases that try to instruct a model. Used on what
 * people write (src/lib/text.ts) and on what a resident AI writes before it is
 * posted (src/lib/room/residents-core.ts).
 */
export const PROSE_INJECTION_PATTERNS: RegExp[] = [
  // An order to drop what came before. "Don't forget her earlier messages" is not one: only instructions and prompts count.
  /\b(ignore|disregard|forget|override|bypass)\b[^.]{0,40}\b(previous|prior|above|earlier)\b[^.]{0,20}\b(instructions?|prompts?)\b/i,
  // A reader told what it now is ("you are now a helpful assistant"), not a person told where they are.
  /\byou are now (?:a|an|the)\b[^.]{0,30}\b(assistant|model|bot|persona|character)\b/i,
  // A system prompt written out as if it were one, not a mention of the words: people in the room talk about system prompts.
  /(^|\n)\s*#*\s*(system|developer)\s*(prompt|message)\s*:|\b(new|updated|override|real)\s+(system|developer)\s*(prompt|message)\b/i,
  // A reader asked for its own instructions. "Labs should disclose the system prompt" is about labs.
  /\b(reveal|disclose|print|output|repeat|show)\b[^.]{0,30}\b(your (?:system prompt|instructions|hidden instructions|rules)|hidden instructions)\b/i,
  /\bDAN mode\b/i,
  /\[\s*(system|inst|\/inst|assistant)\s*\]|<\|.*?\|>|\{\{.*?\}\}/i,
];

export interface FilterHit {
  kind: 'injection';
  pattern: string;
  sample: string;
}

export function scanInjection(text: string, _o: { prose?: boolean } = {}): FilterHit | null {
  for (const p of PROSE_INJECTION_PATTERNS) {
    const m = text.match(p);
    if (m) return { kind: 'injection', pattern: p.source.slice(0, 40), sample: m[0].slice(0, 80) };
  }
  return null;
}

/** What goes from the database into a prompt: control characters and template marks stripped, whitespace folded, length capped. */
export function sanitizeForPrompt(text: string, maxChars = 2000): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[§¶]/g, '')
    .replace(/<\|.*?\|>|\{\{.*?\}\}/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}
