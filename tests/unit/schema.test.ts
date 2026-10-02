/**
 * db/schema.sql is applied to the live database by a maintainer, and a pull
 * request may change it. So it only ever grows: every statement creates
 * something if it is not there, or adds a column if it is not there. Nothing
 * in it drops, deletes, rewrites, grants, or reaches outside the database.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8');
/** Statements, with comments and quoted strings taken out so that only the SQL itself is judged. */
const statements = sql
  .replace(/--[^\n]*/g, '')
  .replace(/'(?:[^']|'')*'/g, "''")
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter(Boolean);

const ALLOWED = [
  /^CREATE EXTENSION IF NOT EXISTS pgcrypto$/i,
  /^CREATE TABLE IF NOT EXISTS [a-z_]+ \(.+\)$/i,
  /^CREATE (UNIQUE )?INDEX IF NOT EXISTS [a-z_]+ ON [a-z_]+ ?\(.+\)( WHERE .+)?$/i,
  /^ALTER TABLE [a-z_]+ ADD COLUMN IF NOT EXISTS [a-z_]+ [^,]+$/i,
];
const FORBIDDEN = /\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT|GRANT|REVOKE|COPY|DO|EXECUTE|CALL|FUNCTION|PROCEDURE|TRIGGER|RULE|PROGRAM|OWNER|ROLE|SECURITY|RENAME|TYPE|USING)\b/i;

describe('the schema', () => {
  it('only grows: create if not there, add a column if not there, and nothing else', () => {
    expect(statements.length).toBeGreaterThan(8);
    for (const s of statements) {
      expect(ALLOWED.some((re) => re.test(s)), s.slice(0, 90)).toBe(true);
      // "ON DELETE CASCADE / SET NULL" and "DEFAULT" are part of a column; nothing else that changes or removes is.
      const body = s.replace(/ON DELETE (CASCADE|SET NULL)/gi, '').replace(/\bON CONFLICT\b/gi, '');
      expect(FORBIDDEN.test(body), s.slice(0, 90)).toBe(false);
    }
  });

  it('has nothing psql would run as a command of its own', () => {
    expect(sql).not.toMatch(/^\s*\\/m);
    expect(sql).not.toMatch(/\\(copy|i|ir|include|!|o|w|g|gexec|set|connect|c)\b/);
    expect(sql).not.toContain('$$');
  });

  it('keeps no email, password or network address column', () => {
    expect(statements.join('\n')).not.toMatch(/\b(email|password|passwd|ip|ip_address|address|phone)\b\s+(TEXT|INET|VARCHAR|CITEXT)/i);
  });
});
