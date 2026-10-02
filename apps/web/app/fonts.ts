import localFont from 'next/font/local';

/*
 * Inter is the fallback typeface off Apple platforms (design-system §3.1). It is vendored rather than loaded
 * with next/font/google, which needs the network at build time. Not preloaded: Apple devices resolve the
 * stack to SF Pro first and never fetch it. The Arial-based fallback is metric-matched, so the swap moves
 * nothing.
 */
export const inter = localFont({
  src: './fonts/InterVariable.woff2', // inter-latin-opsz-normal.woff2 from @fontsource-variable/inter 5.3.0 (OFL-1.1)
  variable: '--font-inter',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  preload: false,
  adjustFontFallback: 'Arial',
});
