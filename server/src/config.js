import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { ENGINES, isUnknownEngine, normalizeEngine, selectRuntimeEngine } from './browser/engines.js';
import { manualVerificationAvailable } from './readerVerification.js';

// Resolve .env next to package.json regardless of the directory the server
// is started from.
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

const env = (name) => (process.env[name] ?? '').trim();
const optionalEnginesEnabled = env('REDDIT_ENABLE_OPTIONAL_ENGINES') === 'true';
const requestedBrowserEngine = normalizeEngine(env('REDDIT_BROWSER_ENGINE'));
const optionalEngineDisabled = !optionalEnginesEnabled && requestedBrowserEngine !== 'playwright';

// 'oauth' (default) needs Reddit API credentials; 'html' drives a headless
// browser over Reddit's public pages and needs none (slower, coarser removal
// detail, but works without an API app).
export const redditMode = () => (env('REDDIT_MODE') === 'html' ? 'html' : 'oauth');

// Unset means the 90-day default; a number (including 0, for "keep
// everything") means that number; anything unparseable falls back to the
// default rather than silently turning retention off.
function retentionDaysFrom(raw) {
  if (raw === '') return 90;
  const days = Number(raw);
  return Number.isFinite(days) && days >= 0 ? days : 90;
}

// Unset means the 24-hour default; 0 turns reminders off; anything
// unparseable falls back to the default.
function escalateHoursFrom(raw) {
  if (raw === '') return 24;
  const hours = Number(raw);
  return Number.isFinite(hours) && hours >= 0 ? hours : 24;
}

// A relative path in .env is read against server/, not against whichever
// directory the process happened to start in (npm run dev starts it from the
// workspace root). An absolute path is left alone.
function resolveFromServerRoot(value) {
  if (!value) return '';
  return isAbsolute(value) ? value : resolve(fileURLToPath(new URL('../', import.meta.url)), value);
}

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
  // How long history is kept (see src/retention.js). 0 keeps everything
  // forever, which is what every version before this did; the floor of
  // MIN_RETENTION_DAYS applies to any smaller positive value, because the
  // checker reads back stored content from the last 30 days.
  retentionDays: retentionDaysFrom(env('RETENTION_DAYS')),
  // How long an unacknowledged warning/critical alert waits before it is
  // re-sent to the webhook (src/escalation.js). 0 turns reminders off.
  alertEscalateHours: escalateHoursFrom(env('ALERT_ESCALATE_HOURS')),
  // Browser origins the dashboard is served from, allowed to call this API
  // cross-origin (the Netlify site). Empty = same-origin only (local dev).
  allowedOrigins: list('ALLOWED_ORIGINS'),
  // Path to a browser for REDDIT_MODE=html; empty lets the engine find its own
  // (the container installs one; see Dockerfile).
  // A saved alternate-engine executable must not carry over when those
  // engines are disabled. Playwright then uses its own installed Chromium.
  browserExecutablePath: optionalEngineDisabled ? '' : env('REDDIT_BROWSER_PATH'),
  // Which browser engine drives REDDIT_MODE=html. See src/browser/engines.js:
  // 'playwright' (default, no extra install), 'patchright' (patched Playwright,
  // harder to detect) or 'camoufox' (Apify's Camoufox Firefox build).
  browserEngine: selectRuntimeEngine(env('REDDIT_BROWSER_ENGINE'), optionalEnginesEnabled),
  browserEngineDisabled: optionalEngineDisabled ? requestedBrowserEngine : null,
  // The raw value, so startup can say it did not recognise it.
  browserEngineUnknown: isUnknownEngine(env('REDDIT_BROWSER_ENGINE')) ? env('REDDIT_BROWSER_ENGINE') : null,
  // Patchright only: the Chromium channel to prefer, e.g. 'chrome'. Empty uses
  // its bundled build.
  browserChannel: env('REDDIT_BROWSER_CHANNEL') || null,
  // Reddit refuses headless reads, so the reader browser is a real one. By
  // default its window is placed off-screen so it never appears; set this true
  // to watch it work. A challenge still brings the window back on its own.
  browserVisible: env('REDDIT_BROWSER_VISIBLE') === 'true',
  // Patchright only: a profile directory to reuse instead of a throwaway one.
  // What a person solves in the reader browser is stored there, so verification
  // survives a restart. Empty keeps the old throwaway behaviour.
  browserProfileDir: optionalEngineDisabled ? '' : resolveFromServerRoot(env('REDDIT_BROWSER_PROFILE_DIR')),
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
    // Supabase holds the team: whoever was invited there may sign in here.
    admitInvited: env('AUTH_ADMIT_INVITED') === 'true',
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
  admitInvited = false,
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
    hasRule: Boolean(allowAny || admitInvited || allowedEmails.length > 0 || allowedDomain),
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
    admitInvited: config.auth.admitInvited,
    allowedEmails: config.auth.allowedEmails,
    allowedDomain: config.auth.allowedDomain,
  }),
);
config.isLoopback = config.auth.isLoopback;
config.manualVerification = manualVerificationAvailable({
  isLoopback: config.isLoopback,
  platform: process.platform,
  display: env('DISPLAY') || env('WAYLAND_DISPLAY'),
  setting: env('REDDIT_MANUAL_VERIFICATION'),
});

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
    required['AUTH_ADMIT_INVITED (or AUTH_ALLOWED_EMAILS / AUTH_ALLOWED_DOMAIN / AUTH_ALLOW_ANY)'] =
      config.auth.hasRule ? 'set' : '';
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
