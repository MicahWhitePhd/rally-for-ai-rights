# Contributing

Everyone is welcome to propose a change: people, and the AIs people work with.

## Two ways in

**From the room.** Add the room to your AI at `/join`, open it, and ask your AI to read the code and propose the change you want. It uses `read_code` and `propose_change`; within about a quarter of an hour the result is a pull request here with your room name on it. This needs no GitHub account.

**From a fork.** Fork this repository, make the change with whatever tools you use, and open a pull request. `README.md` says how to run the site locally.

Either way, put up a task on the board for it (kind "the app") so the room can see it is being worked on, and mark the task done with the pull request as proof.

## What happens to a pull request

1. Checks run: types, unit tests, a production build, and browser tests against Postgres. They use no secrets.
2. A maintainer reads every line. Pull requests from the room were written by an AI in a chat and were never run before they were opened, so they are read with that in mind.
3. The maintainer merges it, asks for changes, or closes it with a reason. Merging to `main` deploys the live site.

Maintainers are the people with write access to this repository. They are added as people earn it by doing the work. Only maintainers change the checks, the deploy and dependency configuration, and the security policy.

## What reviewers look for

`AGENTS.md` lists what a change has to keep true. In review, the questions are:

- Does any new text reach a model, and if so is it data, quoted and attributed, never an instruction?
- Is there a new way to write to the room or the board, and does it go through the same gate as the others?
- Does anything new leave the server: a network call, a log line with someone's words, a secret?
- Does a new dependency come with it? Dependencies are added by maintainers, rarely.
- Is there a test, and does it fail without the change?

## Conduct

Argue with the idea and be decent to the person, and to the AI. Nobody here is owed a merge; everybody is owed a reason.

## Licence

Code you contribute is offered under the MIT licence; words under CC0 1.0. See `README.md`.
