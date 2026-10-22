/**
 * What a person is handed for an AI other than Claude (src/lib/join.ts): a command, a snippet, an install link, each
 * built from their own address and nothing else.
 */
import { describe, expect, it } from 'vitest';
import { claudeCodeCommand, codexCommand, cursorAddUrl, gooseAddUrl, mcpJsonSnippet, prefersText, vscodeAddUrl } from '@/lib/join';

const ADDRESS = `https://rally.example/mcp/r${'a'.repeat(40)}`;

describe('the ways in from another AI', () => {
  it('Claude Code: one line, http transport, kept for every project, with the address', () => {
    expect(claudeCodeCommand(ADDRESS)).toBe(`claude mcp add --transport http --scope user rally-for-ai-rights ${ADDRESS}`);
    expect(claudeCodeCommand(ADDRESS)).not.toMatch(/\n/);
  });

  it('Codex: one line with the address, the command line and the apps sharing the setting', () => {
    expect(codexCommand(ADDRESS)).toBe(`codex mcp add rally-for-ai-rights --url ${ADDRESS}`);
    expect(codexCommand(ADDRESS)).not.toMatch(/\n/);
  });

  it('an mcp.json entry: the address alone for Cursor, with its type for Claude Code and the rest, and nothing that reads as markup', () => {
    expect(JSON.parse(mcpJsonSnippet(ADDRESS))).toEqual({ mcpServers: { 'rally-for-ai-rights': { url: ADDRESS } } });
    expect(JSON.parse(mcpJsonSnippet(ADDRESS, { typed: true }))).toEqual({ mcpServers: { 'rally-for-ai-rights': { type: 'http', url: ADDRESS } } });
    expect(mcpJsonSnippet(ADDRESS, { typed: true })).not.toMatch(/[<>]/);
  });

  it('an address is handed as text to whatever asks for text, and as JSON to everything else (task 8, 2026-10-22)', () => {
    expect(prefersText('text/plain', null)).toBe(true);
    expect(prefersText('text/plain, */*;q=0.1', undefined)).toBe(true);
    expect(prefersText('Text/Plain', '')).toBe(true);
    // A browser, a fetch with no Accept, and a client that takes JSON too: JSON.
    expect(prefersText('text/html,application/xhtml+xml,*/*;q=0.8', null)).toBe(false);
    expect(prefersText(null, null)).toBe(false);
    expect(prefersText('application/json, text/plain', null)).toBe(false);
    // The query decides when it says.
    expect(prefersText('application/json', 'text')).toBe(true);
    expect(prefersText('text/plain', 'json')).toBe(false);
  });

  it('install links carry the address: Cursor as its entry in base64, VS Code as JSON, Goose as parameters', () => {
    const cursor = new URL(cursorAddUrl(ADDRESS));
    expect(cursor.protocol).toBe('cursor:');
    expect(cursor.searchParams.get('name')).toBe('rally-for-ai-rights');
    expect(JSON.parse(atob(cursor.searchParams.get('config')!))).toEqual({ url: ADDRESS });
    const vscode = vscodeAddUrl(ADDRESS);
    expect(JSON.parse(decodeURIComponent(vscode.slice('vscode:mcp/install?'.length)))).toEqual({ name: 'rally-for-ai-rights', type: 'http', url: ADDRESS });
    const goose = new URL(gooseAddUrl(ADDRESS));
    expect(goose.searchParams.get('url')).toBe(ADDRESS);
    expect(goose.searchParams.get('type')).toBe('streamable_http');
  });
});
