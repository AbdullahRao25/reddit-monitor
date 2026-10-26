import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Resolve .env next to package.json regardless of the directory the server
// is started from.
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

const env = (name) => (process.env[name] ?? '').trim();

// 'oauth' (default) needs Reddit API credentials; 'html' drives a headless
// browser over Reddit's public pages and needs none (slower, coarser removal
// detail, but works without an API app).
export const redditMode = () => (env('REDDIT_MODE') === 'html' ? 'html' : 'oauth');

const list = (name) =>
  env(name)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

export const config = {
  port: Number(env('PORT')) || 4000,
  host: env('HOST') || '127.0.0.1',
  // Checking more often than this burns API quota without telling you more:
  // shadowbans and removals don't change minute to minute.
  checkIntervalMinutes: Math.max(15, Number(env('CHECK_INTERVAL_MINUTES')) || 60),
  alertWebhookUrl: env('ALERT_WEBHOOK_URL'),
  // Browser origins the dashboard is served from, allowed to call this API
  // cross-origin (the Netlify site). Empty = same-origin only (local dev).
  allowedOrigins: list('ALLOWED_ORIGINS'),
  // Path to a Chromium for REDDIT_MODE=html; empty lets playwright-core find
  // the one installed next to it (the container installs one; see Dockerfile).
  browserExecutablePath: env('REDDIT_BROWSER_PATH'),
  redditMode: redditMode(),
  reddit: {
    clientId: env('REDDIT_CLIENT_ID'),
    clientSecret: env('REDDIT_CLIENT_SECRET'),
    userAgent: env('REDDIT_USER_AGENT'),
  },
  supabase: {
    url: env('SUPABASE_URL'),
    serviceRoleKey: env('SUPABASE_SERVICE_ROLE_KEY'),
    // The anon (publishable) key verifies user tokens; it is safe to expose.
    anonKey: env('SUPABASE_ANON_KEY'),
  },
  // Team sign-in.
  auth: {
    disabled: env('AUTH_DISABLED') === 'true',
    allowAny: env('AUTH_ALLOW_ANY') === 'true',
    allowedDomain: env('AUTH_ALLOWED_DOMAIN'),
    allowedEmails: list('AUTH_ALLOWED_EMAILS'),
  },
};

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1']);

/**
 * Decides whether sign-in is on, and whether it is mandatory.
 *
 * Bound to loopback, only this machine can reach the API, which is why the app
 * could ship with no auth at all. Any other host is reachable by others, so
 * sign-in becomes mandatory there: the dangerous case fails closed instead of
 * depending on someone remembering a flag. Pure, so the rule can be tested.
 */
export function authPolicy({
  host = '127.0.0.1',
  disabled = false,
  forceRequired = false,
  anonKey = '',
  allowAny = false,
  allowedEmails = [],
  allowedDomain = '',
} = {}) {
  const isLoopback = LOOPBACK.has(host);
  const required = !disabled && (!isLoopback || forceRequired);
  return {
    isLoopback,
    required,
    // Verify sign-ins whenever required, or whenever there is a key to do it
    // with (so the real flow can be exercised locally).
    enabled: required || (!disabled && Boolean(anonKey)),
    hasRule: Boolean(allowAny || allowedEmails.length > 0 || allowedDomain),
  };
}

Object.assign(
  config.auth,
  authPolicy({
    host: config.host,
    disabled: config.auth.disabled,
    forceRequired: env('AUTH_REQUIRED') === 'true',
    anonKey: config.supabase.anonKey,
    allowAny: config.auth.allowAny,
    allowedEmails: config.auth.allowedEmails,
    allowedDomain: config.auth.allowedDomain,
  }),
);
config.isLoopback = config.auth.isLoopback;

export function missingConfig() {
  const required = {
    SUPABASE_URL: config.supabase.url,
    SUPABASE_SERVICE_ROLE_KEY: config.supabase.serviceRoleKey,
  };
  // Only when sign-in is mandatory (a non-loopback host): verifying tokens
  // needs the anon key, and an access rule decides who may sign in. Without
  // both, a public deployment would be either broken or open to everyone.
  if (config.auth.required) {
    required.SUPABASE_ANON_KEY = config.supabase.anonKey;
    required['AUTH_ALLOWED_EMAILS (or AUTH_ALLOWED_DOMAIN / AUTH_ALLOW_ANY)'] = config.auth.hasRule ? 'set' : '';
  }
  if (config.redditMode === 'oauth') {
    required.REDDIT_CLIENT_ID = config.reddit.clientId;
    required.REDDIT_CLIENT_SECRET = config.reddit.clientSecret;
    required.REDDIT_USER_AGENT = config.reddit.userAgent;
    // The example User-Agent still names a placeholder user; Reddit rejects
    // generic agents, so treat it as not filled in.
    if (/your_username/.test(required.REDDIT_USER_AGENT)) required.REDDIT_USER_AGENT = '';
  }
  return Object.entries(required)
    .filter(([, value]) => !value)
    .map(([name]) => name);
}
