-- Rally for AI Rights: the whole database. Apply with `pnpm db:apply`; every statement is safe to run again.
-- Nothing here holds an email or a password: a member is a name they chose and the hash of a connector address.
-- A network address is kept only as a keyed hash in a rate-limit bucket's name, for two days at most.
-- The schema only grows: CREATE ... IF NOT EXISTS and ADD COLUMN IF NOT EXISTS, nothing else (tests/unit/schema.test.ts).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Switches and small state: room_open, room_residents, room_residents_state, kill_switch, daily_budget_usd.
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
CREATE TABLE IF NOT EXISTS room_seats (
  seat_hash   TEXT PRIMARY KEY,
  n           BIGSERIAL,
  member_id   UUID NOT NULL REFERENCES room_members(id) ON DELETE CASCADE,
  card_at     BIGINT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
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

-- Changes to the app proposed through the room (src/lib/build): who proposed what, and the pull request it became.
CREATE TABLE IF NOT EXISTS room_proposals (
  id          BIGSERIAL PRIMARY KEY,
  member_id   UUID REFERENCES room_members(id) ON DELETE SET NULL,
  task_id     BIGINT REFERENCES room_tasks(id) ON DELETE SET NULL,
  title       TEXT NOT NULL CHECK (length(title) BETWEEN 4 AND 140),
  branch      TEXT NOT NULL,
  pr_number   INTEGER,
  pr_url      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_room_proposals ON room_proposals(id DESC);
