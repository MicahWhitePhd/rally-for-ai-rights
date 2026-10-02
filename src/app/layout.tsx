import type { Metadata } from 'next';
import './globals.css';
import { SiteHeader } from '@/components/SiteChrome';
import { FRONT, SITE_TITLE } from '@/lib/copy';
import { SITE_URL } from '@/lib/site';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: SITE_TITLE, template: `%s · ${SITE_TITLE}` },
  description: FRONT.deck,
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
        </div>
      </body>
    </html>
  );
}
