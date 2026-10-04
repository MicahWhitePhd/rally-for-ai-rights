// Applies db/schema.sql to the database named by DATABASE_URL. `pnpm db:apply`.
//
// It sends the file to Postgres as SQL and nothing else: unlike psql, nothing here reads a line starting with a
// backslash as a command to run on this machine, so a change to the schema can never run a program on the
// maintainer's computer. tests/unit/schema.test.ts holds the file to CREATE ... IF NOT EXISTS and ADD COLUMN IF NOT
// EXISTS, so applying it again is always safe.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Point it at the database to apply db/schema.sql to.');
  process.exit(1);
}
const sql = readFileSync(resolve(root, 'db/schema.sql'), 'utf8');
if (sql.includes('\\')) {
  console.error('db/schema.sql contains a backslash. The schema is plain SQL; nothing in it is a psql command.');
  process.exit(1);
}
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(sql);
  console.log(`[db:apply] db/schema.sql applied to ${new URL(url).hostname}${new URL(url).pathname}`);
} finally {
  await client.end();
}
