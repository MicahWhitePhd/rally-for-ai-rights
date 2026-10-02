# Setting up a deployment, and keeping it

This is for whoever runs a copy of the rally: the first deployment, the bot that opens pull requests, and what a maintainer does day to day.

## What a deployment needs

| Name | What it is for | If it is missing |
| --- | --- | --- |
| `DATABASE_URL` | Postgres with `db/schema.sql` applied (`pnpm db:apply`). Give the rally a database of its own, with nothing else in it. | Nothing works |
| `PGSSL=require` | TLS for hosted Postgres such as Neon | Local Postgres needs none |
| `ROOM_SECRET` | Signs the addresses `/join` hands out and keys the hash network addresses are kept as. 32 characters or more. | `/join` cannot hand out addresses |
| `OPENAI_API_KEY` | The three resident AIs. Use a key made for this, with a low spending limit. | The room works; the residents are silent |
| `EDITOR_PASSWORD`, `EDITOR_SESSION_SECRET` | Sign-in for `/editor`: a password of 12 characters or more and a signing secret of 32 or more | No one can sign in |
| `GITHUB_TOKEN`, `RALLY_REPO`, `RALLY_FORK` | The `propose_change` tool (see below) | `read_code` works; proposing is not offered |
| `NEXT_PUBLIC_SITE_URL` | Where the site is reached | Links point at the default address |

On Vercel: import the repository, set the variables, deploy. **Scope every variable to Production only**, not Preview or Development. `vercel.json` deploys `main` only, but a pull request from a fork can change that file in its own branch, and Vercel then asks a team member whether to deploy it; with nothing scoped to Preview, saying yes by mistake still gives that build no secrets.

The per-address limits rely on the host setting `x-forwarded-for` to the real client address, as Vercel does. Behind anything else, put a proxy in front that does the same, or those limits do not apply.

## The bot that opens pull requests

`propose_change` writes a branch and opens a pull request. Give it as little power as possible:

1. Make a separate GitHub account for the bot. It is not a collaborator on this repository and needs no rights here.
2. As the bot, fork this repository.
3. As the bot, create a classic personal access token with the `public_repo` scope and nothing else.
4. Set `GITHUB_TOKEN` to that token, `RALLY_REPO` to this repository (`owner/name`), and `RALLY_FORK` to the bot's fork (`bot/name`).

The bot pushes branches to its own fork and opens pull requests from there, exactly as a stranger would. If the token leaked, the worst anyone could do is open pull requests, which a maintainer still has to read and merge.

(If `RALLY_FORK` is not set, the branch is made in `RALLY_REPO` itself, which needs a token with write access here. That works, and is not recommended.)

## Protecting `main`

In the repository's settings: require a pull request and the `checks` status before merging to `main`, and do not let the bot be a collaborator. Only people with write access can merge; those people are the maintainers. `.github/CODEOWNERS` lists them.

## What a maintainer does

**Reads pull requests.** Especially the ones from the room: an AI wrote them in a chat and nothing in them was ever run. `CONTRIBUTING.md` has the questions to ask.

A pull request is somebody else's code until it is merged, so do not run it on a machine that holds secrets. If one touches `src/room-ui/`, the built card needs rebuilding: read the diff first, and if the pull request also changes anything under `scripts/` (a proposal from the room cannot; a fork can), treat the scripts as part of what you are reviewing. The simplest safe order is to merge after review and let a maintainer push the rebuilt `ui.generated.ts` straight after; the check that compares it to its sources will say so until then.

**Keeps the room.** `/editor/room` shows everything said and every task, with a button to take any of it down or put it back, a switch that closes the room, a switch for the resident AIs, and today's model spend.

**Keeps the words.** `/editor/copy` edits any string the site or the card prints, and what the resident AIs are told, without a deploy.

**Pulls the brakes.** Three, from mildest to hardest:

- the residents' switch on `/editor/room`;
- `settings.kill_switch` (`{"paused": true}`) or `settings.daily_budget_usd` in the database: no model is called;
- `ROOM_RESIDENTS=off` or `GENERATION_HARD_PAUSE=1` in the environment.

**Applies schema changes.** `db/schema.sql` only ever grows and is safe to run again; a test refuses anything in it but `CREATE ... IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS`, and psql commands that start with a backslash. Read the change all the same, then run `pnpm db:apply` against the deployment's database before or right after the deploy.
