// Team sign-in for the dashboard, via Supabase Auth (GitHub).
//
// Configured through build-time env vars (set in Netlify): VITE_SUPABASE_URL
// and VITE_SUPABASE_ANON_KEY. When they are absent — local dev, or the test
// runner — auth is "not ready" and the app runs open against a same-origin API
// (the server is then run with AUTH_DISABLED or behind localhost).

import { createClient } from '@supabase/supabase-js';

// import.meta.env is undefined outside Vite (e.g. the node test runner).
const ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {};
const url = ENV.VITE_SUPABASE_URL;
const anonKey = ENV.VITE_SUPABASE_ANON_KEY;

export const authReady = Boolean(url && anonKey);
const supabase = authReady ? createClient(url, anonKey) : null;

export async function currentToken() {
  if (!supabase) return null;
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

export async function currentUser() {
  if (!supabase) return null;
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.user ?? null;
  } catch {
    return null;
  }
}

// Calls back with the user (or null) now and on every sign-in/out. Returns an
// unsubscribe function.
export function onAuthChange(cb) {
  if (!supabase) {
    cb(null);
    return () => {};
  }
  supabase.auth.getSession().then(({ data }) => cb(data.session?.user ?? null));
  const { data } = supabase.auth.onAuthStateChange((_event, session) => cb(session?.user ?? null));
  return () => data.subscription.unsubscribe();
}

// Where Supabase sends people back to. The hash is dropped on purpose: the
// app's own routes live there, and the sign-in link must land on the page
// itself so the SDK can complete the session before the router runs.
const returnTo = () => window.location.origin + window.location.pathname;

// Hands off to GitHub and returns to this same page, where Supabase completes
// the session from the URL. Which signed-in addresses are actually admitted is
// decided by the server, not here.
export function signInWithGitHub() {
  return supabase?.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: returnTo() } });
}

// Emails a one-time sign-in link. shouldCreateUser is false so this can never
// mint an account for a stranger who guesses the URL: only people already
// invited in Supabase can receive a link, and everyone else gets the same
// neutral answer either way (we never say whether an address is known).
export async function signInWithEmail(email) {
  if (!supabase) return { ok: false, error: 'Sign-in is not configured for this build.' };
  const { error } = await supabase.auth.signInWithOtp({
    email: String(email).trim().toLowerCase(),
    options: { emailRedirectTo: returnTo(), shouldCreateUser: false },
  });
  if (!error) return { ok: true };
  // "Signups not allowed for otp" is what Supabase returns for an address it
  // does not know. Saying so would turn this form into a membership oracle.
  if (/signups? not allowed/i.test(error.message)) return { ok: true };
  return { ok: false, error: error.message };
}

export function signOut() {
  return supabase?.auth.signOut();
}
