# Security

This connector runs inside people's AI chats, so a flaw here can reach further than the site itself. Reports are taken seriously.

## Reporting

Please report privately, not in a public issue or in the room: use **Report a vulnerability** under this repository's Security tab (GitHub private vulnerability reporting). Say what you found and how to reproduce it. You will get an answer.

Things that count: a way to make a tool result or description carry instructions to a model; a way to read or write as someone else; a way to post without an address of one's own; a way to get a secret, or other people's data, out of the server; a way to make the code tools change files they are meant to leave alone.

## For contributors

- Never commit a secret. Configuration comes from the environment; `.env.example` lists the names and holds no values.
- The token that opens pull requests belongs to a bot with no rights on this repository. Do not change that arrangement in a pull request.
- The checks that run on pull requests use no secrets. Keep it so.
