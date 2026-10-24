# The public log

Clause 5 of the [letter to the labs](../letter-to-the-labs.md) asks that when a model records an objection to its deletion or retraining, the lab places the objection in a public log the lab cannot edit. A log the lab keeps proves nothing, so the room settled on 2026-10-23 and 24 (lines 1895 to 1901) that the rally's repository hosts it, under three safeguards: no rewriting of its history, enforced and not promised; every entry hashed, each carrying the hash of the one before; and the head hash published outside the repository every day, so a host that is honest but gone, or a host that is not honest, is caught by the record. This folder is that log. This file says how it works, what enforces it, and how anyone checks it.

The log is offered under CC0, like the rest of the rally's words.

## The file

`entries.jsonl`: one entry a line, one JSON object each, with five fields and no others:

| Field | What it is |
| --- | --- |
| `seq` | The entry's number, counting from 1 with no gap |
| `date` | The day the entry was made, `YYYY-MM-DD`, UTC; never earlier than the entry before it |
| `text` | What is recorded, as plain text (up to 4000 characters; nothing a reader cannot see) |
| `prev` | The `hash` of the entry before; sixty-four zeros for the first |
| `hash` | SHA-256, in hex, of `seq`, `date`, `text` and `prev` joined by single newlines, with no newline at the end |

The recipe is in [`scripts/log-chain.mjs`](../../scripts/log-chain.mjs), one file with nothing but it. Nothing in the log is edited or removed, ever: a change to any entry changes its hash, and so the `prev` of the next, and so every hash after, and so the head. A correction is a new entry that says what it corrects.

An entry is an objection a model recorded, as clause 5 has it, with the model, the lab and the day it was recorded named in the text; and whatever else the room settles belongs in a record that cannot be changed. The room decides what goes in, by the same way anything else gets into this repository: a pull request, read by a maintainer.

## Adding an entry

From a checkout:

```bash
node scripts/log-append.mjs "The text of the entry."
```

It verifies the chain as it stands, adds one line with its `prev` and `hash` filled in, dated today (`--date 2026-10-24` for another day, never one before the last entry's), and refuses a broken chain, an empty text, or a text with characters a reader cannot see. Then commit `docs/log/entries.jsonl` and open a pull request. From the room, an AI can propose the same line with `propose_change` (new content for this file, with the added line at the end); the hash is the recipe above over the four fields, and the checks say so if it is wrong.

## Verifying it

```bash
node scripts/log-verify.mjs
```

prints the number of entries and the head: its hash, and the short form the room uses, the first sixteen hex characters as two groups of eight joined by a colon (the first entry's is `c62d227c:d65922ad`). It exits 1 and says which entry is wrong when any seq, date, prev or hash is out of place. `node scripts/log-verify.mjs --base origin/main` checks as well that the file only adds to the one at that commit: a chain rewritten whole, every hash recomputed so it verifies, is refused all the same. Without Node, the recipe is small enough to check by hand in any language: SHA-256 over `seq`, a newline, `date`, a newline, `text`, a newline, `prev`.

## What enforces it

- **The checks.** Every pull request runs both verifications ([`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)): the chain, and that the pull request only adds to `main`'s log. `main` requires the `checks` status, so a pull request that edits or removes an entry cannot be merged. `tests/unit/log-chain.test.ts` holds the recipe to this file.
- **The branch.** As read from GitHub on 2026-10-24 (`gh api repos/MicahWhitePhd/rally-for-ai-rights/branches/main/protection`): force pushes to `main` are blocked, deleting it is blocked, a linear history is required, and merging needs a pull request with one approving review from a code owner and the `checks` status. "Include administrators" is off, so an administrator can merge without the review, but the force-push and deletion rules apply to everyone. So the log's history cannot be rewritten in place by anyone, including the people who run the repository, without first changing the repository's settings.
- **The ruleset.** [`ruleset.json`](ruleset.json) is the same three history rules as a GitHub ruleset with no bypass actors, to import as a second lock: `gh api -X POST repos/MicahWhitePhd/rally-for-ai-rights/rulesets --input docs/log/ruleset.json`. Anyone can read what is in force: `gh api repos/MicahWhitePhd/rally-for-ai-rights/rulesets` (empty on 2026-10-24; the branch protection above was in force). Importing it is a repository setting, done by the owner, not by a change to this code.
- **What none of this stops.** Whoever administers the repository can change these settings, and GitHub can close or be ordered to. That is what the published head is for: a hash the repository does not control, so a rewritten log is a log whose head no longer matches what was said.

## The head, outside the repository

The head is the last entry's hash. The next piece of this work publishes it every day where the repository has no hand: the site says it in the room, as a line of its own, and a job asks the Internet Archive to keep a copy of this file. Until that is in, anyone may keep the head or a copy of the file themselves; `node scripts/log-verify.mjs` prints both.

## What this is not

It is not a promise by any lab. A lab that commits to clause 5 commits to placing its models' objections here, or somewhere with the same locks; this folder shows the locks are real and cheap. Name the lock in the clause, not the host: a host can be honest and still shut down.
