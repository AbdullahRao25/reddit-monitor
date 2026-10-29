// Authentication for a public (team) deployment.
//
// With no auth the API trusts every caller, which is only safe on localhost.
// Once it is reachable on the internet, every /api route must prove the
// caller is a signed-in user, or anyone could add/remove accounts and read
// everything. The dashboard signs in with Supabase Auth (a magic link, or
// GitHub) and sends the user's access token as `Authorization: Bearer
// <token>`; this verifies it and checks the user may enter this workspace.
//
// Verification goes through Supabase (auth.getUser), which validates the token
// whatever algorithm the project signs with, so this needs no JWT secret and
// no new dependency. Results are cached briefly so the dashboard's 30s poll
// doesn't call Supabase on every request.

import { HttpError } from './errors.js';

const CACHE_MS = 5 * 60 * 1000;
const CACHE_MAX = 2000;

/**
 * deps:
 *   verifyToken(token) -> { id, email, invitedAt } | null   (injectable; see supabaseVerifier)
 *   allowedEmails: string[]   exact addresses admitted
 *   allowedDomain: string     everyone at this email domain is admitted
 *   admitInvited: boolean     admit anyone invited from Supabase -> Authentication -> Users
 *   allowAny: boolean         admit any validly signed-in user (open sign-up)
 * Returns an Express middleware.
 */
export function createAuth({
  verifyToken,
  allowedEmails = [],
  allowedDomain = '',
  admitInvited = false,
  allowAny = false,
  log = console,
}) {
  const emails = new Set(allowedEmails.map((email) => String(email).trim().toLowerCase()).filter(Boolean));
  const domain = String(allowedDomain).trim().toLowerCase().replace(/^@/, '');
  const cache = new Map(); // token -> { user, at }

  if (allowAny) {
    log.warn?.(
      'AUTH_ALLOW_ANY is on: any account that can sign in gets full access. ' +
        'Set AUTH_ADMIT_INVITED, AUTH_ALLOWED_EMAILS or AUTH_ALLOWED_DOMAIN to restrict it to your team.',
    );
  } else if (emails.size === 0 && !domain && !admitInvited) {
    log.warn?.(
      'No access rule set (AUTH_ADMIT_INVITED / AUTH_ALLOWED_EMAILS / AUTH_ALLOWED_DOMAIN) and ' +
        'AUTH_ALLOW_ANY is off, so no one can sign in. Add at least your own email.',
    );
  }

  function admitted(user) {
    if (allowAny) return true;
    const value = String(user?.email ?? '').toLowerCase();
    if (emails.has(value)) return true;
    if (domain && value.endsWith(`@${domain}`)) return true;
    // Invited from Supabase -> Authentication -> Users -> Invite user, which
    // is how a teammate is added: no redeploy, and revoking is deleting the
    // user there. invited_at is set only by an invite, never by a self-signup,
    // so this stays closed even if the project has public sign-ups left on.
    if (admitInvited && user?.invitedAt) return true;
    return false;
  }

  return async function auth(req, res, next) {
    try {
      const header = req.get('authorization') ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      if (!token) throw new HttpError(401, 'Sign in to use this workspace.');

      let entry = cache.get(token);
      if (!entry || Date.now() - entry.at > CACHE_MS) {
        const user = await verifyToken(token);
        if (!user?.email) {
          cache.delete(token);
          throw new HttpError(401, 'Your session is invalid or has expired. Sign in again.');
        }
        if (cache.size >= CACHE_MAX) cache.clear();
        entry = { user, at: Date.now() };
        cache.set(token, entry);
      }

      if (!admitted(entry.user)) {
        throw new HttpError(403, `${entry.user.email} does not have access to this workspace.`);
      }
      req.user = entry.user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

// Builds a verifyToken backed by Supabase Auth. `createClient` is injected so
// this module never imports the SDK directly (and tests can fake it).
export function supabaseVerifier(createClient, { url, anonKey }) {
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return async function verifyToken(token) {
    const { data, error } = await client.auth.getUser(token);
    if (error || !data?.user?.email) return null;
    // invited_at is absent for anyone who signed themselves up; admitInvited
    // leans on that, so pass it through rather than just the identity.
    return { id: data.user.id, email: data.user.email, invitedAt: data.user.invited_at ?? null };
  };
}
