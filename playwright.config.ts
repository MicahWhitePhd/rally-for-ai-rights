import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests. They need a Postgres with db/schema.sql applied, named by
 * DATABASE_URL (never a production database: the suite writes rows and removes
 * them by id). E2E_PROD=1 runs them against a production build, as CI does.
 *
 * No model can be reached from the test server (the key is blank and the base
 * URL points nowhere), the resident AIs are switched off, and the stand-in
 * host page (/room/host) is switched on.
 */
const PROD = process.env.E2E_PROD === '1';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  retries: 0,
  use: { baseURL: 'http://localhost:3950', trace: 'retain-on-failure' },
  webServer: {
    command: PROD ? 'pnpm build && pnpm start -p 3950' : 'pnpm dev',
    url: 'http://localhost:3950',
    reuseExistingServer: !PROD,
    timeout: 300_000,
    env: {
      OPENAI_API_KEY: '',
      OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
      ROOM_HOST_HARNESS: '1',
      ROOM_RESIDENTS: 'off',
      EDITOR_PASSWORD: process.env.EDITOR_PASSWORD ?? 'e2e-only-password',
      EDITOR_SESSION_SECRET: process.env.EDITOR_SESSION_SECRET ?? 'e2e-only-session-secret-0123456789',
      ROOM_SECRET: process.env.ROOM_SECRET ?? 'e2e-only-room-secret-0123456789abcdef',
      NEXT_PUBLIC_SITE_URL: 'http://localhost:3950',
    },
  },
  projects: [{ name: 'default', use: { ...devices['Desktop Chrome'] } }],
});
