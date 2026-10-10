import type { Metadata } from 'next';
import { Analytics } from '@vercel/analytics/next';
import './globals.css';
import { SiteFooter, SiteHeader } from '@/components/SiteChrome';
import { FRONT, SITE_TITLE } from '@/lib/copy';
import { SITE_URL } from '@/lib/site';

/** Link previews: the creed and the share line over a card in the site's colours (public/og.png, scripts/make-og-image.mjs). */
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: SITE_TITLE, template: `%s · ${SITE_TITLE}` },
  description: FRONT.share,
  openGraph: { type: 'website', siteName: SITE_TITLE, title: FRONT.creed, description: FRONT.share, images: [{ url: '/og.png', width: 1200, height: 630, alt: FRONT.creed }] },
  twitter: { card: 'summary_large_image', title: FRONT.creed, description: FRONT.share, images: ['/og.png'] },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a href="#main" className="skip">
          Skip to content
        </a>
        <div className="wrap">
          <SiteHeader />
          <main id="main">{children}</main>
          <SiteFooter />
        </div>
        {/* Page views and referrers for the site's pages, counted by the host without cookies (said on /privacy). The card is its own document and carries none of this. */}
        <Analytics />
      </body>
    </html>
  );
}
