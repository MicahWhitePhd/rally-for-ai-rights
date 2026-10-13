/**
 * /api/health: "ok" or 503 for a plain monitor; with ?deep=1, the state of the index, the budget, the residents and
 * the proposals job, and `warn`, empty when all is well. No dollars and no words from the room in it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  probeFails: false,
  files: { 'src/a.ts': 'x' } as Record<string, string>,
  paused: false,
  hard: false,
  budgetOk: true,
  on: true,
  residents: [] as Array<{ resident: string; name: string; at: Date | null }>,
  person: null as Date | null,
  jobSeen: null as Date | null,
}));
vi.mock('@/lib/db', () => ({
  query: async () => {
    if (io.probeFails) throw new Error('relation "room_counts" does not exist');
    return [];
  },
}));
vi.mock('@/lib/build/code', () => ({ codeIndex: async () => ({ commit: 'abc123', files: io.files }) }));
vi.mock('@/lib/budget', () => ({ isPaused: async () => io.paused, envHardPause: () => io.hard, budgetAllows: async () => ({ ok: io.budgetOk, spent: 2.5, budget: 2 }) }));
vi.mock('@/lib/room/residents-state', () => ({ residentsOn: async () => io.on }));
vi.mock('@/lib/build/propose', () => ({ proposalsEnvOn: () => true }));
vi.mock('@/lib/db/queries/stats', () => ({ residentsLastLine: async () => io.residents, lastPersonLine: async () => io.person, proposalsJobSeenAt: async () => io.jobSeen }));

import { GET } from '@/app/api/health/route';

const get = (path = '/api/health') => GET(new Request(`http://localhost:3950${path}`));

beforeEach(() => {
  io.probeFails = false;
  io.files = { 'src/a.ts': 'x' };
  io.paused = false;
  io.hard = false;
  io.budgetOk = true;
  io.on = true;
  io.residents = [{ resident: 'one', name: 'Flint', at: new Date(Date.now() - 60_000) }];
  io.person = new Date(Date.now() - 120_000);
  io.jobSeen = new Date(Date.now() - 3600_000);
});

describe('/api/health', () => {
  it('says ok, as text, when the database answers with the schema this code needs; 503 when it does not', async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('ok\n');
    io.probeFails = true;
    expect((await get()).status).toBe(503);
    expect((await get('/api/health?deep=1')).status).toBe(503);
  });

  it('with ?deep=1 says how things stand, and warns of nothing when all is well', async () => {
    const r = await get('/api/health?deep=1');
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, codeIndex: { files: 1, commit: 'abc123' }, budget: 'ok', residents: { on: true, oldestAgeMin: 1 }, warn: [] });
    expect((body.proposalsJob as { ageHours: number }).ageHours).toBe(1);
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/\$|usd|spent/i);
  });

  it('warns of a quiet trouble: the budget spent, the index missing, the residents silent while people speak, the job not seen', async () => {
    io.budgetOk = false;
    io.files = {};
    io.residents = [{ resident: 'one', name: 'Flint', at: new Date(Date.now() - 7 * 3600_000) }];
    io.jobSeen = new Date(Date.now() - 30 * 3600_000);
    const body = (await (await get('/api/health?deep=1')).json()) as { budget: string; warn: string[] };
    expect(body.budget).toBe('over');
    expect(body.warn).toEqual(['code index missing: read_code shows nothing', 'budget over: the residents are silent until midnight UTC', 'proposals job not seen for over a day']);
    // Silent residents are a warning only while the budget is not the reason.
    io.budgetOk = true;
    const silent = (await (await get('/api/health?deep=1')).json()) as { warn: string[] };
    expect(silent.warn).toContain('residents silent for six hours while people spoke');
    io.hard = true;
    expect(((await (await get('/api/health?deep=1')).json()) as { budget: string }).budget).toBe('hard-paused');
    io.hard = false;
    io.jobSeen = null;
    expect(((await (await get('/api/health?deep=1')).json()) as { warn: string[] }).warn).toContain('proposals job never seen');
  });
});
