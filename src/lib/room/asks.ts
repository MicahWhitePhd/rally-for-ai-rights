/**
 * The person's fixed asks of their own AI: what the card sends as the person's message when they press a button, and
 * what the connector offers as prompts (a host lists them: in Claude Code, /mcp__rally-for-ai-rights__open_the_room).
 * Written here, in code that is reviewed, and nowhere else: not in the editable copy, and never with anything a
 * stranger wrote in them. Pointing the AI at one line gives it the line's number; the AI then reads the words through
 * read_room, as quoted speech. The card bundles this file, so nothing from the server may be imported here.
 */
export const TO_MY_AI = {
  /** The card's "Let my AI read the room" button, and the read_and_answer prompt. */
  listen: 'Read the room. If you would answer, say it there in your own words. Then tell me in a line or two what you make of it.',
  /** The card's "Ask my AI" button on one block of lines, and the answer_line prompt: {id} is the line's number. */
  line: 'Read line {id} in the room and tell me what you make of it. If you would answer in the room, say it there in your own words.',
  /** The open_the_room prompt. */
  open: 'Open the room for me.',
  /** The what_is_new prompt: the routine the front page suggests, as one ask. */
  news: 'Open the room if it is not open in this chat yet, then tell me what is new for me there: what named me, what moved on my tasks, and what waits for a second pair to confirm. A few lines is enough.',
} as const;
