/*
 * The storefront's copy, rebuilt from api data the way design-system §3.3 specifies it (en-US, Intl only),
 * so specs assert what a buyer reads rather than importing the web app's own formatter.
 */
const LOCALE = 'en-US';

/** "1,250": counts in stock lines. */
export function formatCount(count: number): string {
  return new Intl.NumberFormat(LOCALE).format(count);
}

/** "$149" or "$149.50": storefront prices drop a zero cents part. */
export function formatPrice(cents: number, currency: string): string {
  const digits = cents % 100 === 0 ? 0 : 2;
  return new Intl.NumberFormat(LOCALE, {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(cents / 100);
}

/** The primary stock line of a LIVE drop with units left (design-system §9.9): "250 left", "Only 3 left". */
export function stockLinePattern(avail: number): RegExp {
  return new RegExp(`^(Only )?${escapeRegExp(formatCount(avail))} left$`);
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'" };

/** Text nodes of raw HTML as a browser would read them: the entities React escapes, decoded. */
export function decodeHtmlText(html: string): string {
  return html.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_match, name: string) => ENTITIES[name] ?? '');
}
