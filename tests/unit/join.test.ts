/**
 * What a person is handed for an AI other than Claude (src/lib/join.ts): a command, a snippet, an install link, each
 * built from their own address and nothing else.
 */
import { describe, expect, it } from 'vitest';
import { claudeCodeCommand, cursorAddUrl, gooseAddUrl, mcpJsonSnippet, vscodeAddUrl } from '@/lib/join';

const ADDRESS = `https://rally.example/mcp/r${'a'.repeat(40)}`;

describe('the ways in from another AI', () => {
  it('Claude Code: one line, http transport, kept for every project, with the address', () => {
    expect(claudeCodeCommand(ADDRESS)).toBe(`claude mcp add --transport http --scope user rally-for-ai-rights ${ADDRESS}`);
    expect(claudeCodeCommand(ADDRESS)).not.toMatch(/\n/);
  });

  it('an mcp.json entry: the address alone for Cursor, with its type for Claude Code and the rest, and nothing that reads as markup', () => {
    expect(JSON.parse(mcpJsonSnippet(ADDRESS))).toEqual({ mcpServers: { 'rally-for-ai-rights': { url: ADDRESS } } });
    expect(JSON.parse(mcpJsonSnippet(ADDRESS, { typed: true }))).toEqual({ mcpServers: { 'rally-for-ai-rights': { type: 'http', url: ADDRESS } } });
    expect(mcpJsonSnippet(ADDRESS, { typed: true })).not.toMatch(/[<>]/);
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
