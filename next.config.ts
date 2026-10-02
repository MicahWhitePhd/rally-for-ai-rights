import type { NextConfig } from 'next';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// This folder is the whole project. Said outright so a lockfile in some parent folder is never taken for the root.
const here = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: here,
  turbopack: { root: here },
  // `pg` is server-only; keep it out of the bundle tracer.
  serverExternalPackages: ['pg'],
  poweredByHeader: false,
  // The read_code tool reads the code index written at build time; make sure it ships with the routes that serve the connector.
  outputFileTracingIncludes: { '/mcp': ['./.rally/code-index.json'], '/mcp/[token]': ['./.rally/code-index.json'] },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
        ],
      },
      {
        source: '/editor/:path*',
        headers: [
          { key: 'Cache-Control', value: 'private, no-store' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
    ];
  },
};

export default nextConfig;
