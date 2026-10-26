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

// Hands off to GitHub and returns to this same page, where Supabase completes
// the session from the URL. Which signed-in addresses are actually admitted is
// decided by the server's allowlist, not here.
export function signInWithGitHub() {
  return supabase?.auth.signInWithOAuth({
    provider: 'github',
    options: { redirectTo: window.location.origin + window.location.pathname },
  });
}

export function signOut() {
  return supabase?.auth.signOut();
}
