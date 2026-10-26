// Minimal read-only Reddit API client using application-only OAuth.
//
// An application-only token sees Reddit exactly as a logged-out visitor does,
// which is what makes shadowban detection possible: a shadowbanned profile
// still looks normal to its owner but returns 404 to everyone else. No
// account passwords are involved.

const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const API_BASE = 'https://oauth.reddit.com';
const INFO_BATCH_SIZE = 100;

export class RedditApiError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'RedditApiError';
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createRedditClient({
  clientId,
  clientSecret,
  userAgent,
  minIntervalMs = 700,
  fetchImpl = fetch,
}) {
  let token = null;
  let tokenExpiresAt = 0;
  let queue = Promise.resolve();
  let nextAllowedAt = 0;

  async function getToken() {
    if (token && Date.now() < tokenExpiresAt) return token;

    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': userAgent,
      },
      body: 'grant_type=client_credentials',
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      const reason = body.error ? `: ${body.error}` : '';
      throw new RedditApiError(
        `Reddit rejected the API credentials (HTTP ${res.status}${reason}). ` +
          'Check REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in server/.env.',
        res.status,
      );
    }

    token = body.access_token;
    // Refresh a minute early so a token never expires mid-request.
    tokenExpiresAt = Date.now() + Math.max(60, (body.expires_in ?? 3600) - 60) * 1000;
    return token;
  }

  // Back off when Reddit says the quota for the current window is spent.
  function noteRateLimit(headers) {
    const remaining = headers.get('x-ratelimit-remaining');
    const reset = headers.get('x-ratelimit-reset');
    if (remaining === null || reset === null) return;
    if (Number(remaining) < 2) {
      nextAllowedAt = Math.max(nextAllowedAt, Date.now() + (Number(reset) + 1) * 1000);
    }
  }

  // Every request goes through one queue, spaced minIntervalMs apart, which
  // keeps well under Reddit's 100 requests/minute per OAuth client.
  function enqueue(task) {
    const run = queue.then(async () => {
      const wait = nextAllowedAt - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        return await task();
      } finally {
        nextAllowedAt = Math.max(nextAllowedAt, Date.now() + minIntervalMs);
      }
    });
    queue = run.catch(() => {});
    return run;
  }

  // GET an API path. Resolves to the parsed JSON, or null on 404.
  function get(path, params = {}) {
    return enqueue(async () => {
      const url = new URL(API_BASE + path);
      url.searchParams.set('raw_json', '1');
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));

      for (let attempt = 1; attempt <= 3; attempt++) {
        const res = await fetchImpl(url, {
          headers: { Authorization: `Bearer ${await getToken()}`, 'User-Agent': userAgent },
        });
        noteRateLimit(res.headers);

        if (res.status === 404) return null;
        if (res.ok) return res.json();

        if (res.status === 401) {
          token = null; // expired or revoked token: fetch a fresh one and retry
          continue;
        }
        if (res.status === 429 || res.status >= 500) {
          const reset = Number(res.headers.get('x-ratelimit-reset'));
          await sleep(res.status === 429 && reset > 0 ? (reset + 1) * 1000 : 2000 * attempt);
          continue;
        }
        if (res.status === 403) {
          throw new RedditApiError(
            `Reddit refused ${path} (HTTP 403). This usually means REDDIT_USER_AGENT is ` +
              'missing or generic, or the API app does not have access.',
            403,
          );
        }
        throw new RedditApiError(`Reddit request ${path} failed (HTTP ${res.status})`, res.status);
      }
      throw new RedditApiError(`Reddit request ${path} kept failing after 3 attempts`);
    });
  }

  async function getUserAbout(username) {
    const body = await get(`/user/${encodeURIComponent(username)}/about`);
    if (!body) return { state: 'not_found' };

    const data = body.data ?? {};
    if (data.is_suspended) return { state: 'suspended' };

    return {
      state: 'active',
      profile: {
        name: data.name ?? username,
        linkKarma: data.link_karma ?? 0,
        commentKarma: data.comment_karma ?? 0,
        createdAt: data.created_utc ? data.created_utc * 1000 : null,
        hasVerifiedEmail:
          typeof data.has_verified_email === 'boolean' ? data.has_verified_email : null,
      },
    };
  }

  // which: 'submitted' (posts) or 'comments'. Newest first, up to 100 items.
  // Returns null when the listing itself is hidden (404).
  async function getUserListing(username, which, limit = 100) {
    const body = await get(`/user/${encodeURIComponent(username)}/${which}`, {
      limit,
      sort: 'new',
    });
    if (!body) return null;
    return (body.data?.children ?? []).map((child) => child.data);
  }

  // Current public state of posts/comments by fullname (t3_xxx / t1_xxx).
  async function getInfo(fullnames) {
    const items = [];
    for (let i = 0; i < fullnames.length; i += INFO_BATCH_SIZE) {
      const batch = fullnames.slice(i, i + INFO_BATCH_SIZE);
      const body = await get('/api/info', { id: batch.join(',') });
      for (const child of body?.data?.children ?? []) items.push(child.data);
    }
    return items;
  }

  // Throws a RedditApiError if the credentials don't work.
  async function verify() {
    await getToken();
  }

  return { getUserAbout, getUserListing, getInfo, verify };
}
