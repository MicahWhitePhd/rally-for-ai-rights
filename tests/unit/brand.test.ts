/**
 * How the site's own address is written for people (src/lib/brand.ts). In lower case "rallyforairights" reads as
 * "rally for air rights"; capitals change only how it is written, never where it goes.
 */
import { describe, expect, it } from 'vitest';
import { BRAND_HOST, displayHost, displayUrl } from '@/lib/brand';

describe('the address as people read it', () => {
  it('is RallyForAIRights.org, however the host is spelt, with or without www', () => {
    for (const h of ['rallyforairights.org', 'RALLYFORAIRIGHTS.ORG', 'www.rallyforairights.org', 'https://rallyforairights.org', 'https://rallyforairights.org/room?x=1']) {
      expect(displayHost(h), h).toBe(BRAND_HOST);
    }
    expect(BRAND_HOST).toBe('RallyForAIRights.org');
  });

  it('leaves every other host as it is: the .com that forwards, a fork, a laptop, the old Vercel address', () => {
    for (const h of ['rallyforairights.com', 'rally.example', 'localhost:3950', 'ai-rights.vercel.app', 'notrallyforairights.org']) expect(displayHost(h), h).toBe(h);
  });

  it('keeps an address an address: only the host is rewritten, never the path a person pastes', () => {
    expect(displayUrl('https://rallyforairights.org')).toBe('https://RallyForAIRights.org');
    expect(displayUrl('https://rallyforairights.org/mcp/rAbc_dEf')).toBe('https://RallyForAIRights.org/mcp/rAbc_dEf');
    expect(displayUrl('http://localhost:3950')).toBe('http://localhost:3950');
    expect(new URL(displayUrl('https://rallyforairights.org/rules')).href).toBe('https://rallyforairights.org/rules');
  });
});
