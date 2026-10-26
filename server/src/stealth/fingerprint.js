// Per-account browser fingerprint for stealth mode.
//
// Reddit's spam systems correlate accounts by User-Agent, timezone, and
// viewport. A fingerprint that matches the account's posting history is
// less likely to be flagged as a bot or as a second account on the same
// machine. This module manages the fingerprint record and computes a
// consistency score.
//
// The fingerprint is NOT used by the OAuth client (which uses a single
// application-only token for the whole app). It is used by the dashboard
// to display and edit the fingerprint, and by the warm-up scheduler to
// decide which actions to take.

const FINGERPRINT_FIELDS = ['userAgent', 'timezone', 'viewport', 'locale'];

const FINGERPRINT_KEYS = [
  { key: 'userAgent', label: 'User-Agent string' },
  { key: 'timezone', label: 'Timezone (IANA)' },
  { key: 'viewport', label: 'Viewport (WxH)' },
  { key: 'locale', label: 'Locale (BCP 47)' },
];

// Validates and normalises a fingerprint object. Returns { ok, value, errors }.
export function validateFingerprint(input) {
  const errors = [];
  const value = {};

  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, value: null, errors: ['Fingerprint must be an object.'] };
  }

  for (const field of FINGERPRINT_FIELDS) {
    const raw = input[field];
    if (raw === undefined || raw === null || raw === '') {
      errors.push(`${field} is required.`);
      value[field] = null;
    } else if (typeof raw !== 'string') {
      errors.push(`${field} must be a string.`);
      value[field] = null;
    } else {
      const trimmed = raw.trim();
      if (trimmed.length > 300) {
        errors.push(`${field} is too long (max 300 characters).`);
        value[field] = null;
      } else {
        value[field] = trimmed;
      }
    }
  }

  if (value.userAgent && value.userAgent.length < 10) {
    errors.push('User-Agent is too short to be realistic.');
  }
  if (value.timezone && !/^[A-Za-z_]+\/[A-Za-z_\- ]+$/.test(value.timezone)) {
    errors.push('Timezone must be an IANA identifier like "America/New_York".');
  }
  if (value.viewport && !/^\d{2,4}x\d{2,4}$/.test(value.viewport)) {
    errors.push('Viewport must look like "1920x1080".');
  }
  if (value.locale && !/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/.test(value.locale)) {
    errors.push('Locale must be a BCP 47 tag like "en-US" or "de".');
  }

  return { ok: errors.length === 0, value: errors.length === 0 ? value : null, errors };
}

// Returns the list of fields a fingerprint form should render.
export function fingerprintFields() {
  return FINGERPRINT_KEYS;
}

// Computes a 0–100 consistency score for a fingerprint against an account's
// known activity. A low score means the fingerprint is inconsistent with
// the account's posting pattern (e.g. timezone doesn't match posting hours).
//
// account: { username, timezone_hint, posting_hours (array of 0-23), ... }
// fingerprint: { userAgent, timezone, viewport, locale }
export function fingerprintConsistencyScore(account, fingerprint) {
  if (!fingerprint) return null;
  let score = 100;

  // Timezone consistency: if the account has a known timezone hint and the
  // fingerprint timezone differs, penalise.
  if (account?.timezone_hint && fingerprint.timezone && account.timezone_hint !== fingerprint.timezone) {
    score -= 30;
  }

  // Posting hours: if the account posts mostly in one 6-hour window and the
  // fingerprint timezone puts that window in the local middle of the night,
  // penalise.
  if (account?.posting_hours?.length >= 3 && fingerprint.timezone) {
    const hours = account.posting_hours;
    const min = Math.min(...hours);
    const max = Math.max(...hours);
    // If the posting window is 2–5 local time, that's suspicious for a human.
    if (max <= 5 || (min >= 2 && max <= 6)) {
      score -= 20;
    }
  }

  // User-Agent plausibility: a very short or very generic UA is a flag.
  if (fingerprint.userAgent) {
    const ua = fingerprint.userAgent.toLowerCase();
    if (!/mozilla|chrome|safari|firefox|edge/.test(ua)) {
      score -= 15;
    }
  }

  return Math.max(0, Math.min(100, score));
}

// Suggests a fingerprint for a new account based on its known activity.
// Returns a fingerprint object ready to save.
export function suggestFingerprint(account) {
  const tz = account?.timezone_hint || 'America/New_York';
  return {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    timezone: tz,
    viewport: '1920x1080',
    locale: 'en-US',
  };
}
