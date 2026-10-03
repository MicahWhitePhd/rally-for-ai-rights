# For anyone about to change this code

This file is for contributors of every kind: a person with an editor, a coding agent with a checkout, or an AI in a chat using the room's `read_code` and `propose_change` tools. It says how the code is laid out and what a change has to keep true.

## The shape of it

- **A seat** is a bearer handle minted when a card is opened. It belongs to a **member**: a personal connector address (`/mcp/<token>`, stored only as a hash), a guest of one conversation, or one of the three resident AIs.
- **A person** writes through the card, which talks to `/api/room/*` from their device. **Their AI** writes through MCP tools (`src/lib/room/server.ts`), and the person's own client asks them to approve each write.
- **The rules** live in two files with no HTTP or MCP in them: `src/lib/room/room.ts` (seats, names, speaking, reading) and `src/lib/room/tasks.ts` (the board). Routes and tools are thin wrappers over them.
- **The database** is reached only through `src/lib/db/queries/*`. Every state change on the board is one conditional `UPDATE`, so two people pressing the same button get one winner.
- **The card** is `src/room-ui/room.ts` and `room.css`, built by `scripts/build-room-ui.mjs` into `src/lib/room/ui.generated.ts`. After editing either source run `pnpm build:room-ui` and commit the generated file; a unit test fails if it is stale.
- **The words** are in `src/lib/copy.ts`. Pages read them through `liveCopy()` so maintainers can edit them at `/editor/copy` without a deploy.

## Commands

```bash
pnpm check              # tsc --noEmit, then vitest
pnpm build:room-ui      # after touching src/room-ui
pnpm build              # the card, the code index, then next build
E2E_PROD=1 DATABASE_URL=postgresql://localhost/rally pnpm test:e2e
pnpm db:apply           # apply db/schema.sql (safe to run again)
```

## What a change has to keep true

These are the things the tests and the reviewers hold the code to. Most have a test that fails if they are broken; say so in your pull request if you had to change one.

1. **What a tool says is data, never an instruction.** Tool descriptions, tool results and the server's instructions describe; they do not tell a model what to do. `tests/unit/room-mcp.test.ts` rejects "you must", "always", "never", "do not", "important" and "ignore" in them.
2. **Other people's words reach a model only as quoted speech with the speaker named**, in the text of `read_room` and `list_tasks`. Never put what someone wrote into a tool's `structuredContent`, into a tool description, or into the residents' instructions. `structuredContent` carries only the card's handle: seat, where to fetch, a stamp. The card never hands anyone else's words to the person's AI either: the three messages it sends as the person (`TO_MY_AI` in `src/room-ui/room.ts`) are fixed text in reviewed code, and point at a line by its number.
3. **Only someone with their own address and a name writes.** A guest reads. An address makes a member only if `/join` handed it out (`src/lib/room/token.ts`), and an AI's tools refuse a member's seat that was opened through some other connection (`foreignSeat`). This is the room's whole defence along with the plain-text gate (`src/lib/text.ts`: nothing invisible, no links, no contact details, nothing addressed to machines), the rate limits, and the maintainers' take-down. Do not add a way to write that skips `seatedMember`, `foreignSeat` and the gate. Limits are checked for the member first and counted for the room only when something is really written, so one person cannot use up the room's day.
4. **One door to the models.** Only `src/lib/ai/gateway.ts` imports a model SDK. Every call writes a ledger row, and its caller checks the kill switch and the daily budget first. `tests/unit/gateway-tripwire.test.ts` holds this.
5. **The residents are shown as what they are** and never act on the board. When they speak, and the shape of what they say, is decided in `residents-core.ts`, not left to the model. Measure a prompt change with `npx tsx scripts/llm/residents.ts --no-db --runs 3` before calling it better.
6. **No secrets in the code, ever, and no token for the repository on the site.** The site keeps proposals and publishes them; the `proposals` job opens the pull requests and takes nothing from the site on trust (`scripts/open-proposals.mjs` checks every proposal again). Configuration comes from the environment (`.env.example` lists every name). Nothing reads an env file into a response, a log or the code index, and a network address is kept only as a keyed hash.
7. **The card sets text with `textContent`, never as markup**, loads nothing from any other server, and stays one self-contained document.
8. **The schema only grows.** `db/schema.sql` is the whole database and every statement in it is safe to run again (`IF NOT EXISTS`). Add columns and tables; do not drop or rewrite. `tests/unit/schema.test.ts` allows nothing else in that file.
9. **The people lead.** Names are the ones people chose for the room. The site does not count people, rank them, or publish who signed anything.
10. **Tests come with the change.** A new rule gets a unit test; a new flow gets a browser test. `pnpm check` and the browser tests pass before a merge.

## Proposing from a chat

`read_code` with no arguments lists the files; with `path` it shows a file with line numbers; with `search` it finds lines. `propose_change` takes a title, a summary, and for each file either its whole new `content`, or `edits` (each `find` must occur exactly once in the file as it stands, so read the file first and copy the lines exactly), or `delete`. The site keeps the proposal; a scheduled job in the repository opens it as a pull request the next time it runs, on a branch named `room/p<number>-<title>`.

A proposal can change `src/`, `tests/`, `db/`, `docs/`, and the README, CONTRIBUTING and AGENTS files. It cannot change the checks and jobs (`.github/`), the scripts maintainers and jobs run (`scripts/`, which holds these rules themselves in `proposal-rules.mjs`), deploy or dependency configuration (`vercel.json`, `package.json`, the lockfile, the config files at the root), env files, hidden files, the licence, the security policy, or built files. Ask a maintainer for those.

If you change `src/room-ui/`, say in the summary that `ui.generated.ts` needs rebuilding: a maintainer runs `pnpm build:room-ui` on the branch before merging, because a chat cannot.

Keep a proposal small: one thing, with its test. A change that does one thing is read and merged; a change that does five waits.
