// The small guards every route module needs.
//
// These lived in three places — app.js had `UUID_RE` and `cleanText`,
// shield/routes.js had its own `isPlain` and UUID pattern, prevention/routes.js
// had a third spelling of the same regex — which is two ways for the same rule
// to drift apart. Each module keeps its own *error* behaviour, though: the
// Shield answers 400 on a malformed id and the prevention queue answers 404,
// and that difference is deliberate, so only the predicates are shared.

import { HttpError } from './errors.js';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A real object, as against null, an array or a primitive. */
export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Trimmed text capped at `max`, or null when there is nothing left — so an
 * empty form field clears the column instead of storing "".
 */
export function cleanText(value, max) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

/**
 * Builds the `requireAccount(id)` every account-scoped route starts with: a
 * 404 for an id that is not a UUID or names no account, so a malformed id and
 * an unknown one are indistinguishable from outside.
 */
export function accountRequirer(repo) {
  return async function requireAccount(id) {
    const account = UUID_RE.test(String(id ?? '')) ? await repo.getAccount(id) : null;
    if (!account) throw new HttpError(404, 'Account not found');
    return account;
  };
}
