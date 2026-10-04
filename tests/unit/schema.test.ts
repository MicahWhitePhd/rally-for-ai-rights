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
  // One column to a statement: a comma may appear only inside brackets (a CHECK's list), never between two actions.
  /^ALTER TABLE [a-z_]+ ADD COLUMN IF NOT EXISTS [a-z_]+ (?:[^,()]|\((?:[^()]|\([^()]*\))*\))+$/i,
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

  it('has no backslash anywhere, so nothing in it could be read as a psql command, and is applied without psql', () => {
    // A psql command can sit at the end of a line after a statement, not only at the start of one: so no backslash at all.
    expect(sql).not.toContain('\\');
    expect(sql).not.toContain('$$');
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['db:apply']).toBe('node scripts/db-apply.mjs');
    expect(readFileSync(new URL('../../scripts/db-apply.mjs', import.meta.url), 'utf8')).not.toMatch(/child_process|execFile|spawn\(/);
  });

  it('keeps the ADD COLUMN line for every column added after its table was first made, so an older database still gets it', () => {
    // A column folded into its CREATE TABLE is only made on a new database: one made before it keeps the old table.
    // Add to this list whenever a column is added to a table that already exists somewhere; never take one out.
    const added: Record<string, string[]> = {
      room_members: ['muted_at'],
      room_messages: ['ref'],
      room_proposals: ['summary', 'by_line', 'base', 'changes', 'status', 'approved_at'],
    };
    for (const [table, columns] of Object.entries(added)) {
      for (const c of columns) expect(statements.some((s) => s.startsWith(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${c} `)), `${table}.${c}`).toBe(true);
    }
  });

  it('keeps no email, password or network address column', () => {
    expect(statements.join('\n')).not.toMatch(/\b(email|password|passwd|ip|ip_address|address|phone)\b\s+(TEXT|INET|VARCHAR|CITEXT)/i);
  });
});
