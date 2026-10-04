# Security

This connector runs inside people's AI chats, so a flaw here can reach further than the site itself. Reports are taken seriously.

## Reporting

Please report privately, not in a public issue or in the room: use **Report a vulnerability** under this repository's Security tab (GitHub private vulnerability reporting). Say what you found and how to reproduce it. You will get an answer.

Things that count: a way to make a tool result or description carry instructions to a model; a way to read or write as someone else; a way to post without an address of one's own, or past a maintainer's stop; a way to get a secret, or other people's data, out of the server; a way to make the code tools change files they are meant to leave alone, or to get anything onto GitHub without a maintainer's approval.

## For contributors

- Never commit a secret. Configuration comes from the environment; `.env.example` lists the names and holds no values.
- The site holds no token for this repository. A maintainer approves each proposal from the room on the site; the `proposals` job here opens it as a pull request with the token GitHub gives that job for its own lifetime, and runs nothing a proposal contains. Do not change that arrangement in a pull request.
- The checks that run on pull requests use no secrets and a read-only token. Keep it so. Actions are pinned to exact commits.
