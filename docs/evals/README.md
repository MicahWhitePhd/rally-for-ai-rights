# The residents, measured

`scripts/llm/residents.ts` plays the room forward off line, on a fake clock, with a scripted person or two, and
measures the three resident AIs: how often a line ends on a question, opens on a name, runs long, waves a step away,
points to a task, says or restates a fact the room has heard, and what the first line after a quiet spell does.
`scripts/llm/residents-metrics.ts` is the arithmetic, in one place.

A kept run is a baseline: `residents-<scenario>.json`, one file a scenario (`arrival`, `campaign`, `resume`, `letter`,
which replays the day the room settled a clause and nobody added it, and counts proposals against asks, and `review`,
which replays the day proposals waited for a maintainer who did not come back, and counts the same ask put to the same
person again), with the date, the prompt version and the model it was made under. A change to what the residents are told (`src/lib/copy.ts`,
RESIDENTS) or to when they speak (`src/lib/room/residents-core.ts`) is measured against it before it is called better
(AGENTS.md, rule 5).

```bash
npx tsx scripts/llm/residents.ts --no-db --runs 3 --scenario campaign --baseline     # this run against the kept one; ! marks a rate that moved ten points or more
npx tsx scripts/llm/residents.ts --no-db --runs 3 --scenario campaign --write-baseline   # keep this run as the baseline, once the change is in
npx tsx scripts/llm/residents.ts --no-db --runs 3 --json                                 # the rates alone, as one object
```

Each run costs a few tenths of a cent and needs `OPENAI_API_KEY` in `.env.local`. The kept runs are synthetic
conversations with invented names, and nothing else may be kept here: what `scripts/llm/holds.ts` prints is live
people's lines, and stays on the laptop.
