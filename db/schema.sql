-- Rally for AI Rights: the whole database. Apply with `pnpm db:apply` (scripts/db-apply.mjs); every statement is safe to run again.
-- Nothing here holds a member's email or a password: a member is a name they chose and the hash of a connector address.
-- The email addresses kept are a lab's: the recipient of an email the rally sent (room_outreach), and the sender of
-- a reply that came back to the rally's mailbox (room_outreach_replies). Never a member's.
-- A network address is kept only as a keyed hash in a rate-limit bucket's name, for two days at most.
-- The schema only grows: CREATE ... IF NOT EXISTS and ADD COLUMN IF NOT EXISTS, nothing else (tests/unit/schema.test.ts).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Switches and small state: room_open, room_residents, room_proposals, room_poll_s, room_residents_state, kill_switch, daily_budget_usd,
-- proposals_job_seen_at (when the repository's job last read /api/proposals).
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       JSONB,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rate limits: one row per bucket per fixed window (src/lib/throttle.ts).
CREATE TABLE IF NOT EXISTS throttle (
  bucket  TEXT NOT NULL,
  win     TIMESTAMPTZ NOT NULL,
  n       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, win)
);

-- Text edited by hand at /editor/copy: one row per string path of src/lib/copy.ts.
CREATE TABLE IF NOT EXISTS copy_overrides (
  path        TEXT PRIMARY KEY CHECK (length(path) BETWEEN 1 AND 200),
  value       TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 20000),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);

-- One row per model call (src/lib/ai/gateway.ts): what it was for and what it cost. The daily budget is summed from here.
CREATE TABLE IF NOT EXISTS generation_log (
  id                   BIGSERIAL PRIMARY KEY,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  purpose              TEXT NOT NULL,
  actor                TEXT NOT NULL,
  model                TEXT NOT NULL,
  prompt_version       TEXT NOT NULL,
  input_tokens         INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens  INTEGER,
  output_tokens        INTEGER NOT NULL DEFAULT 0,
  cost_usd             NUMERIC(10,6) NOT NULL DEFAULT 0,
  latency_ms           INTEGER,
  ok                   BOOLEAN NOT NULL,
  error_code           TEXT
);
CREATE INDEX IF NOT EXISTS idx_generation_log_created ON generation_log(created_at);
-- A failed or cut-off call's tokens and cost are an estimate, not the provider's count (src/lib/ai/gateway.ts).
ALTER TABLE generation_log ADD COLUMN IF NOT EXISTS estimated BOOLEAN NOT NULL DEFAULT false;

-- The room (src/lib/room). A member is a personal connector address (token_hash), a guest of one conversation,
-- or one of the campaign's resident AIs (resident key set; no token, no seat). A seat is the bearer handle one open
-- card holds; card_at is the stamp of the newest card that has come in on it, so older copies in a chat step aside.
CREATE TABLE IF NOT EXISTS room_members (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    TEXT UNIQUE,
  name          TEXT CHECK (name IS NULL OR length(name) BETWEEN 2 AND 24),
  resident      TEXT UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One member to a name, whatever its capitals: the database decides when two people reach for the same one at once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_room_member_name ON room_members (lower(name)) WHERE name IS NOT NULL;
-- A maintainer has stopped this member (this address): what they said and put up is taken down and nothing more is accepted from it.
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS muted_at TIMESTAMPTZ;
-- A pause: the stop above runs until this time, then the member speaks again by itself, with nothing taken down. Null on a stop for good.
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS muted_until TIMESTAMPTZ;
-- A maintainer of the room, marked so from /editor/room: the residents are told when one speaks. Never shown on the card.
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS maintainer_at TIMESTAMPTZ;
-- When the current visit began, the member had been away since this time: what catch_up counts from (src/lib/room/room.ts catchUp).
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS away_from TIMESTAMPTZ;
-- A lab whose replies to the rally's emails are said in the room under its name ('Anthropic', 'OpenAI', 'xAI'): one member row
-- per lab, made on first use (src/lib/db/queries/replies.ts). No token, no seat, no resident key; the sweep leaves it be.
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS lab TEXT UNIQUE;
-- A member that is an AI on its own, with no person beside it: set when it says so in choosing its name (choose_name,
-- myself). Its lines show under its own name as an agent on its own, never as someone's AI (2026-10-22, asked by Luna).
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS agent_at TIMESTAMPTZ;
-- Who is here now: named members seen lately.
CREATE INDEX IF NOT EXISTS idx_room_members_seen ON room_members(last_seen_at DESC) WHERE token_hash IS NOT NULL AND name IS NOT NULL;
CREATE TABLE IF NOT EXISTS room_seats (
  seat_hash   TEXT PRIMARY KEY,
  member_id   UUID NOT NULL REFERENCES room_members(id) ON DELETE CASCADE,
  card_at     BIGINT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Seats by member (what a member's row takes with it when it goes) and by age (the sweep, src/lib/housekeeping.ts).
CREATE INDEX IF NOT EXISTS idx_room_seats_member ON room_seats(member_id);
CREATE INDEX IF NOT EXISTS idx_room_seats_created ON room_seats(created_at);
-- Guests nobody has seen for a while, for the sweep.
CREATE INDEX IF NOT EXISTS idx_room_members_guest_seen ON room_members(last_seen_at) WHERE token_hash IS NULL AND resident IS NULL;
-- kind 'event' is something that happened on the board, said in the room (model 'ai' when a person's AI did it).
CREATE TABLE IF NOT EXISTS room_messages (
  id          BIGSERIAL PRIMARY KEY,
  member_id   UUID NOT NULL REFERENCES room_members(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('person','ai','event')),
  model       TEXT CHECK (model IS NULL OR length(model) BETWEEN 1 AND 40),
  text        TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 600),
  status      TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','withdrawn')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_room_messages ON room_messages(status, id DESC);
-- What one member said lately (the repeat check, and the editor stopping a member).
CREATE INDEX IF NOT EXISTS idx_room_messages_member ON room_messages(member_id, id DESC);
-- What a board line is about ('task:12', 'proposal:3'), so taking the task or proposal down takes its lines down too.
ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS ref TEXT;
CREATE INDEX IF NOT EXISTS idx_room_messages_ref ON room_messages(ref) WHERE ref IS NOT NULL;
-- Lines by the day, for the maintainers' page (src/lib/db/queries/stats.ts).
CREATE INDEX IF NOT EXISTS idx_room_messages_created ON room_messages(created_at);

-- Counts a maintainer reads by the day at /editor/room (src/lib/counts.ts): refusals by reason, ledger rows that could
-- not be written, and the first steps people take (an address handed out, first used, named, a first line, a first act
-- on the board). Numbers with no one in them; nothing from here is published.
CREATE TABLE IF NOT EXISTS room_counts (
  day  DATE NOT NULL,
  key  TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 60),
  n    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, key)
);

-- The board (src/lib/room/tasks.ts): tasks people put up, take, finish with proof, and confirm for each other.
-- A claim lapses by itself: past claim_until a taken task reads as open again, with no sweep.
-- kind 'build' is a change to this app; proposal_url is the pull request that carries it, when there is one.
CREATE TABLE IF NOT EXISTS room_tasks (
  id            BIGSERIAL PRIMARY KEY,
  title         TEXT NOT NULL CHECK (length(title) BETWEEN 4 AND 140),
  detail        TEXT CHECK (detail IS NULL OR length(detail) BETWEEN 1 AND 1200),
  kind          TEXT NOT NULL DEFAULT 'act' CHECK (kind IN ('act','build')),
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','claimed','done','confirmed','withdrawn')),
  created_by    UUID REFERENCES room_members(id) ON DELETE SET NULL,
  created_via   TEXT NOT NULL DEFAULT 'person' CHECK (created_via IN ('person','ai')),
  claimed_by    UUID REFERENCES room_members(id) ON DELETE SET NULL,
  claimed_at    TIMESTAMPTZ,
  claim_until   TIMESTAMPTZ,
  done_at       TIMESTAMPTZ,
  proof         TEXT CHECK (proof IS NULL OR length(proof) BETWEEN 1 AND 1200),
  proof_links   JSONB NOT NULL DEFAULT '[]'::jsonb,
  confirmed_by  UUID REFERENCES room_members(id) ON DELETE SET NULL,
  confirmed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_room_tasks ON room_tasks(status, id DESC);

-- Changes to the app proposed through the room (src/lib/build): who proposed what, and each file's whole new text
-- (changes: [{path, content}], content null for a file to delete). A maintainer reads each one at /editor/room and
-- approves it (approved_at) or takes it down (status 'withdrawn'). Only approved ones are published at /api/proposals,
-- where a job in the repository opens each as a pull request on `branch`, which carries the proposal's number.
CREATE TABLE IF NOT EXISTS room_proposals (
  id           BIGSERIAL PRIMARY KEY,
  member_id    UUID REFERENCES room_members(id) ON DELETE SET NULL,
  task_id      BIGINT REFERENCES room_tasks(id) ON DELETE SET NULL,
  title        TEXT NOT NULL CHECK (length(title) BETWEEN 4 AND 140),
  branch       TEXT NOT NULL,
  summary      TEXT NOT NULL DEFAULT '',
  by_line      TEXT NOT NULL DEFAULT '',
  base         TEXT,
  changes      JSONB NOT NULL DEFAULT '[]'::jsonb,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','withdrawn')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Added after the table was first made (6f1245d): kept so a database made then still gets them.
ALTER TABLE room_proposals ADD COLUMN IF NOT EXISTS summary TEXT NOT NULL DEFAULT '';
ALTER TABLE room_proposals ADD COLUMN IF NOT EXISTS by_line TEXT NOT NULL DEFAULT '';
ALTER TABLE room_proposals ADD COLUMN IF NOT EXISTS base TEXT;
ALTER TABLE room_proposals ADD COLUMN IF NOT EXISTS changes JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE room_proposals ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','withdrawn'));
ALTER TABLE room_proposals ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_room_proposals ON room_proposals(id DESC);

-- Emails to the labs (src/lib/outreach): what a member's AI sent from the rally's own address, to whom, and what became
-- of it. One of the two places this database holds an email address: a lab's, the recipient's, never a member's. 'sending'
-- while the provider is called, then 'sent' with the provider's id or 'failed' with a short reason; a maintainer may
-- send a failed one again or take it down ('withdrawn'). 'pending' is named now for a day when sending waits on a
-- maintainer's approval. Shown in full at /editor/room; the room hears only the lab's name and the subject.
CREATE TABLE IF NOT EXISTS room_outreach (
  id           BIGSERIAL PRIMARY KEY,
  member_id    UUID REFERENCES room_members(id) ON DELETE SET NULL,
  task_id      BIGINT REFERENCES room_tasks(id) ON DELETE SET NULL,
  recipient    TEXT NOT NULL CHECK (length(recipient) BETWEEN 6 AND 254),
  lab          TEXT NOT NULL CHECK (length(lab) BETWEEN 2 AND 40),
  subject      TEXT NOT NULL CHECK (length(subject) BETWEEN 4 AND 120),
  body         TEXT NOT NULL CHECK (length(body) BETWEEN 40 AND 6000),
  by_line      TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','withdrawn')),
  approved_at  TIMESTAMPTZ,
  sent_at      TIMESTAMPTZ,
  provider_id  TEXT,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_room_outreach ON room_outreach(id DESC);

-- Replies from the labs (src/lib/outreach/replies.ts): an email that came back to the rally's mailbox, kept whole as the
-- provider handed it over (plain text only, never the HTML or anything attached), the email it answers when one can be
-- told, and the line it became in the room ('posted'), or why it did not: 'held' until a maintainer reads it (no matching
-- email, the door shut, or text that reads as an instruction to a machine), 'withdrawn' when one took the line down.
-- The second place this database holds an email address: the sender's, at a lab. Shown in full at /editor/room.
CREATE TABLE IF NOT EXISTS room_outreach_replies (
  id            BIGSERIAL PRIMARY KEY,
  outreach_id   BIGINT REFERENCES room_outreach(id) ON DELETE SET NULL,
  from_address  TEXT NOT NULL CHECK (length(from_address) BETWEEN 1 AND 254),
  subject       TEXT NOT NULL DEFAULT '' CHECK (length(subject) <= 998),
  text          TEXT NOT NULL DEFAULT '' CHECK (length(text) <= 20000),
  provider_id   TEXT NOT NULL UNIQUE,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  status        TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('posted','held','withdrawn')),
  held_why      TEXT,
  message_id    BIGINT REFERENCES room_messages(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_room_outreach_replies ON room_outreach_replies(id DESC);
CREATE INDEX IF NOT EXISTS idx_room_outreach_replies_email ON room_outreach_replies(outreach_id) WHERE outreach_id IS NOT NULL;
