// Minimal read-only Reddit API client using application-only OAuth.
//
// An application-only token sees Reddit exactly as a logged-out visitor does,
// which is what makes shadowban detection possible: a shadowbanned profile
// still looks normal to its owner but returns 404 to everyone else. No
// account passwords are involved.

import { ReaderError, readerErrorDetails } from './readerErrors.js';

const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const API_BASE = 'https://oauth.reddit.com';
const INFO_BATCH_SIZE = 100;

export class RedditApiError extends ReaderError {
  constructor(message, status = null, details = {}) {
    super(message, { code: 'access_denied', http_status: status, ...details });
    this.name = 'RedditApiError';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createRedditClient({
  clientId,
  clientSecret,
  userAgent,
  minIntervalMs = 700,
  fetchImpl = fetch,
  now = () => Date.now(),
  sleepImpl = sleep,
  maxPending = 8,
}) {
  let token = null;
  let tokenExpiresAt = 0;
  let queue = Promise.resolve();
  let nextAllowedAt = 0;
  let pending = 0;
  let pauseUntil = 0;
  let pauseReason = null;
  let lastSuccessAt = null;
  let lastFailureAt = null;
  let lastError = null;
  let readable = null;
  let authorization = 'unverified';

  function fail(message, code, status = null, retryMs = null, attempts = 1) {
    const deadline = retryMs !== null ? now() + Math.max(0, retryMs) : null;
    return new RedditApiError(message, status, {
      code, occurred_at: new Date(now()).toISOString(), temporary: retryMs !== null,
      retry_at: deadline !== null ? new Date(Number.isFinite(deadline) && deadline <= 8.64e15 ? deadline : now() + 60_000).toISOString() : null,
      attempts,
    });
  }

  function recordFailure(error) {
    lastError = readerErrorDetails(error);
    lastFailureAt = lastError.occurred_at;
    readable = false;
    if (lastError.retry_at) {
      pauseUntil = Math.max(pauseUntil, Date.parse(lastError.retry_at));
      pauseReason = lastError;
    }
  }

  function succeeded() {
    lastSuccessAt = new Date(now()).toISOString();
    readable = true;
  }

  function retryAfter(headers, fallback) {
    const raw = headers?.get?.('retry-after');
    if (!raw) return fallback;
    const seconds = Number(raw);
    const ms = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(raw) - now();
    // Never shorten a server's not-before deadline. Nothing sleeps for it:
    // callers fail fast and the scheduler consults the cached pause.
    return Number.isFinite(ms) && now() + ms <= 8.64e15 ? Math.max(fallback, ms) : fallback;
  }

  function requireAvailable() {
    if (pauseUntil > now()) {
      const reason = pauseReason ?? lastError;
      throw new RedditApiError(reason?.message ?? 'Reddit API requests are temporarily paused.', reason?.http_status ?? null,
        { ...reason, occurred_at: new Date(now()).toISOString(), retry_at: new Date(pauseUntil).toISOString(), temporary: true, attempts: 0 });
    }
  }

  async function fetchJson(url, options) {
    let res;
    try {
      res = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(30_000) });
    } catch {
      throw fail('The Reddit API could not be reached. Previous account data is unchanged.', 'navigation_error', null, 60_000);
    }
    if (!res.ok) return { res, body: null };
    let body;
    try { body = await res.json(); }
    catch {
      // Error responses need no payload to be classified correctly.
      throw fail('Reddit returned an unreadable API response. Previous account data is unchanged.', 'parsing_error', res.status, 60_000);
    }
    if (res.ok && (!body || typeof body !== 'object' || Array.isArray(body))) {
      throw fail('Reddit returned an unexpected API response format. Previous account data is unchanged.', 'parsing_error', res.status, 60_000);
    }
    return { res, body };
  }

  async function getToken() {
    if (token && now() < tokenExpiresAt) return token;

    const { res, body } = await fetchJson(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': userAgent,
      },
      body: 'grant_type=client_credentials',
    });
    if (res.status === 429) throw fail('Reddit rate-limited API authorization. Requests are paused.', 'rate_limited', 429, retryAfter(res.headers, 60_000));
    if (res.status >= 500) throw fail('Reddit API authorization is temporarily unavailable.', 'server_error', res.status, retryAfter(res.headers, 60_000));
    if (!res.ok || !body?.access_token) {
      authorization = 'error';
      throw fail(`Reddit rejected API authorization (HTTP ${res.status}). Check REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET and REDDIT_USER_AGENT in the server settings.`, 'access_denied', res.status, 300_000);
    }

    token = body.access_token;
    // Refresh a minute early so a token never expires mid-request.
    tokenExpiresAt = now() + Math.max(60, (body.expires_in ?? 3600) - 60) * 1000;
    authorization = 'ready';
    return token;
  }

  // Back off when Reddit says the quota for the current window is spent.
  function noteRateLimit(headers) {
    const remaining = headers.get('x-ratelimit-remaining');
    const reset = headers.get('x-ratelimit-reset');
    if (remaining === null || reset === null) return;
    if (Number(remaining) < 2) {
      const requested = (Number(reset) + 1) * 1000;
      const resetMs = Number.isFinite(requested) && requested > 0 && now() + requested <= 8.64e15 ? requested : 60_000;
      pauseUntil = Math.max(pauseUntil, now() + resetMs);
      pauseReason = fail('Reddit reports that the API read quota is nearly exhausted. Requests are paused until the quota resets.', 'rate_limited', null, pauseUntil - now(), 0).diagnostics;
    }
  }

  // Every request goes through one queue, spaced minIntervalMs apart, which
  // keeps well under Reddit's 100 requests/minute per OAuth client.
  function enqueue(task) {
    try { requireAvailable(); } catch (err) { return Promise.reject(err); }
    if (pending >= maxPending) return Promise.reject(fail('The Reddit API reader is busy. Try again after the current checks finish.', 'reader_busy', null, 1000, 0));
    pending++;
    const run = queue.then(async () => {
      requireAvailable();
      const wait = nextAllowedAt - now();
      if (wait > 0) await sleepImpl(wait);
      requireAvailable();
      try {
        return await task();
      } catch (err) {
        const error = readerErrorDetails(err) ? err : fail('The Reddit API response could not be read.', 'parsing_error', null, 60_000);
        recordFailure(error);
        throw error;
      } finally {
        nextAllowedAt = Math.max(nextAllowedAt, now() + minIntervalMs);
      }
    }).finally(() => { pending--; });
    queue = run.catch(() => {});
    return run;
  }

  // GET an API path. Resolves to the parsed JSON, or null on 404.
  function get(path, params = {}, validate = (body) => body, allowNotFound = true) {
    return enqueue(async () => {
      const url = new URL(API_BASE + path);
      url.searchParams.set('raw_json', '1');
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));

      // One token refresh on 401; access limits and server errors pause the
      // reader rather than repeatedly requesting a refused resource.
      for (let attempt = 1; attempt <= 2; attempt++) {
        const { res, body } = await fetchJson(url, {
          headers: { Authorization: `Bearer ${await getToken()}`, 'User-Agent': userAgent },
        });
        noteRateLimit(res.headers);

        if (res.status === 404 && allowNotFound) { succeeded(); return null; }
        if (res.ok) {
          // Validate inside the serialized request. A malformed response must
          // activate its cooldown before the next waiting request can start.
          const result = validate(body);
          succeeded();
          return result;
        }

        if (res.status === 401 && attempt === 1) {
          token = null; // expired or revoked token: fetch a fresh one and retry
          continue;
        }
        if (res.status === 429) {
          const reset = Number(res.headers.get('x-ratelimit-reset'));
          throw fail('Reddit rate-limited the API reader. Requests are paused and previous account data is unchanged.', 'rate_limited', 429,
            retryAfter(res.headers, Number.isFinite(reset) && reset > 0 ? Math.max(60_000, (reset + 1) * 1000) : 60_000));
        }
        if (res.status >= 500) throw fail('Reddit API is temporarily unavailable. Previous account data is unchanged.', 'server_error', res.status, retryAfter(res.headers, 60_000));
        if (res.status === 403 || res.status === 401) {
          if (res.status === 401) authorization = 'error';
          throw fail(`Reddit refused authorized API access (HTTP ${res.status}). Check the API app permissions and REDDIT_USER_AGENT. Previous account data is unchanged.`, 'access_denied', res.status, retryAfter(res.headers, 300_000), attempt);
        }
        throw fail(`Reddit API returned an unexpected response (HTTP ${res.status}).`, 'unexpected_page', res.status, 60_000);
      }
    });
  }

  async function getUserAbout(username) {
    const body = await get(`/user/${encodeURIComponent(username)}/about`, {}, (value) => {
      const data = value?.data;
      if (value?.kind !== 't2' || !data || typeof data !== 'object' || Array.isArray(data) ||
        (data.name !== undefined && (typeof data.name !== 'string' || data.name.toLowerCase() !== username.toLowerCase())) ||
        (data.is_suspended !== true && (typeof data.name !== 'string' ||
          ![data.link_karma, data.comment_karma, data.created_utc].some(Number.isFinite)))) {
        throw fail('Reddit returned an unexpected API profile format. Previous account data is unchanged.', 'parsing_error', 200, 60_000);
      }
      return value;
    });
    if (!body) return { state: 'not_found' };

    const data = body.data ?? {};
    if (data.is_suspended === true) return { state: 'suspended' };

    return {
      state: 'active',
      profile: {
        name: data.name ?? username,
        linkKarma: Number.isFinite(data.link_karma) ? data.link_karma : null,
        commentKarma: Number.isFinite(data.comment_karma) ? data.comment_karma : null,
        createdAt: data.created_utc ? data.created_utc * 1000 : null,
        hasVerifiedEmail:
          typeof data.has_verified_email === 'boolean' ? data.has_verified_email : null,
      },
    };
  }

  // which: 'submitted' (posts) or 'comments'. Newest first, up to 100 items.
  // Returns null when the listing itself is hidden (404).
  async function getUserListing(username, which, limit = 100) {
    return get(`/user/${encodeURIComponent(username)}/${which}`, {
      limit,
      sort: 'new',
    }, (body) => listingItems(body, which === 'submitted' ? 't3' : 't1'));
  }

  function listingItems(body, expectedKind = null) {
    if (body?.kind !== 'Listing' || !Array.isArray(body.data?.children) ||
      body.data.children.some((child) => !['t1', 't3'].includes(child?.kind) || (expectedKind && child.kind !== expectedKind) ||
        !new RegExp(`^${child.kind}_[a-z0-9]+$`, 'i').test(child?.data?.name ?? ''))) {
      throw fail('Reddit returned an unexpected API content listing. Previous account data is unchanged.', 'parsing_error', 200, 60_000);
    }
    return body.data.children.map((child) => child.data);
  }

  // Current public state of posts/comments by fullname (t3_xxx / t1_xxx).
  async function getInfo(fullnames) {
    const items = [];
    for (let i = 0; i < fullnames.length; i += INFO_BATCH_SIZE) {
      const batch = fullnames.slice(i, i + INFO_BATCH_SIZE);
      items.push(...await get('/api/info', { id: batch.join(',') }, listingItems, false));
    }
    return items;
  }

  // Throws a RedditApiError if the credentials don't work.
  async function verify() {
    requireAvailable();
    try { await getToken(); }
    catch (err) { recordFailure(err); throw err; }
  }

  function getDiagnostics() {
    const paused = pauseUntil > now();
    return {
      mode: 'oauth', authorization: { state: authorization },
      state: paused ? 'paused' : readable === false ? 'unavailable' : readable ? 'ready' : 'unverified',
      readable, last_success_at: lastSuccessAt, last_failure_at: lastFailureAt,
      last_error: lastError ? { ...lastError } : null,
      pause_reason: paused && pauseReason ? { ...pauseReason } : null,
      paused, retry_at: paused ? new Date(pauseUntil).toISOString() : null,
    };
  }

  return { getUserAbout, getUserListing, getInfo, verify, getDiagnostics };
}
