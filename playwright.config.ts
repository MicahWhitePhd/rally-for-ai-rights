import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests. They need a Postgres with db/schema.sql applied, named by
 * DATABASE_URL (never a production database: the suite writes rows and removes
 * them by id). E2E_PROD=1 runs them against a production build, as CI does.
 *
 * No model can be reached from the test server (the key is blank and the base
 * URL points nowhere), no email can leave it (the mail door is pointed at a
 * stub on this machine), the resident AIs are switched off, and the stand-in
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
      // The mail door is pointed at a stub the outreach spec runs on this machine (tests/e2e/outreach.spec.ts): no email can leave it.
      RESEND_API_KEY: 'e2e-only-key',
      RESEND_BASE_URL: 'http://127.0.0.1:3951',
      OUTREACH_FROM: 'letters@rally.test',
      // The inbound spec signs its own webhook requests with this (tests/e2e/inbound.spec.ts): base64 of "e2e-only-webhook-secret-0123456789".
      RESEND_WEBHOOK_SECRET: 'whsec_ZTJlLW9ubHktd2ViaG9vay1zZWNyZXQtMDEyMzQ1Njc4OQ==',
    },
  },
  projects: [
    { name: 'default', use: { ...devices['Desktop Chrome'] }, testIgnore: /(outreach|inbound|pages|publiclog)\.spec\.ts$/ },
    // Pages and the public log's head run once the rest is done, as email to the labs does: the room spec expects the
    // server's first request to be its own (the sweep runs once an hour per instance, after the first response), and a
    // connector call from another spec in the same batch would race it (CI, 2026-10-24).
    { name: 'pages', use: { ...devices['Desktop Chrome'] }, testMatch: /(pages|publiclog)\.spec\.ts$/, dependencies: ['default'] },
    // Email to the labs runs once the rest is done too, for the same reason.
    { name: 'outreach', use: { ...devices['Desktop Chrome'] }, testMatch: /outreach\.spec\.ts$/, dependencies: ['default'] },
    // Replies from the labs run after that: both specs stand in for the provider on the same port, one at a time.
    { name: 'inbound', use: { ...devices['Desktop Chrome'] }, testMatch: /inbound\.spec\.ts$/, dependencies: ['outreach'] },
  ],
});
