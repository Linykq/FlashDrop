import type { Metadata, Viewport } from 'next';
import { type ReactNode, Suspense } from 'react';
import { RouteFocusReset } from '../components/layout/route-focus-reset';
import { ThemeScript } from '../components/theme/theme-script';
import { Providers } from '../components/ui/providers';
import { SITE_DESCRIPTION, SITE_NAME } from '../lib/site';
import { inter } from './fonts';
import './globals.css';

export const metadata: Metadata = {
  title: { default: SITE_NAME, template: `%s · ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbfbfd' },
    { media: '(prefers-color-scheme: dark)', color: '#161617' },
  ],
};

/**
 * The document shell (design-system §8.4). No navigation here: each area's layout brings its own chrome,
 * starting with the skip link, whose label names the area's content ("Skip to checkout" in checkout).
 * `inter.variable` must sit on <html>, where `--font-sans` resolves. The theme script adds attributes to
 * <html> before React hydrates, hence `suppressHydrationWarning`.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body>
        {/* Reading the pathname suspends while prerendering routes with unknown params. */}
        <Suspense fallback={null}>
          <RouteFocusReset />
        </Suspense>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
