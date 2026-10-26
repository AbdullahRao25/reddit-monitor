const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const UNITS = [
  ['year', 365 * 864e5],
  ['month', 30 * 864e5],
  ['week', 7 * 864e5],
  ['day', 864e5],
  ['hour', 36e5],
  ['minute', 6e4],
];

export function timeAgo(iso, now = Date.now()) {
  if (!iso) return 'never';
  const diff = Date.parse(iso) - now;
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return relative.format(Math.round(diff / ms), unit);
  }
  return diff <= 0 ? 'just now' : 'in under a minute';
}

export const formatDateTime = (value) =>
  new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

export const formatDate = (value) =>
  new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

const compactFormat = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
export const compact = (n) => compactFormat.format(n);

export const formatNumber = (n) => (n === null || n === undefined ? '—' : n.toLocaleString());

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
