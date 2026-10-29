// Recovering the history of an account that has gone dark.
//
// A shadowbanned profile 404s to logged-out visitors and a banned one answers
// with a ban notice; either way the posts and comments are no longer in any
// public listing, so the monitor's own reader cannot reach them. That is the
// definition of those states, not a gap in the reader.
//
// What can still be read is a third-party archive that copied the content
// while it was public. This module talks to one (Arctic Shift) and normalises
// what comes back. Two properties matter and are deliberate:
//
//   - Everything here is PUBLIC Reddit content about an account the operator
//     already monitors. Nothing is authenticated, nothing is private, and no
//     Reddit account is used.
//   - The result is a third party's copy. It is not Reddit's records and not
//     this monitor's observations, it can be incomplete, and callers say so
//     rather than presenting it as authoritative. `source` travels with every
//     row so the distinction survives into the database and the UI.
//
// The parsing is pure and exported for tests; the network call is injectable
// so the suite needs no network, like the rest of the server.

export const ARCHIVE_SOURCE = 'arctic-shift';
export const ARCHIVE_BASE = 'https://arctic-shift.photon-reddit.com';

// What the archive is, in one line, for any response that carries these rows.
export const ARCHIVE_DISCLAIMER =
  'Recovered from a third-party public Reddit archive, not from Reddit and not from this monitor\'s own checks. ' +
  'It may be incomplete, and an item missing here is not evidence that it never existed.';

const KINDS = { post: 't3_', comment: 't1_' };

// The archive refuses a larger page: "'limit' must be between 1 and 100".
// More than this is collected by paging, never by asking for more at once.
const PAGE_LIMIT = 100;

// Reddit timestamps are unix seconds; the archive passes them through.
function toIso(createdUtc) {
  const seconds = Number(createdUtc);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const ms = seconds * 1000;
  return Number.isFinite(ms) && ms <= 8.64e15 ? new Date(ms).toISOString() : null;
}

const text = (value) => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed === '' ? null : trimmed;
};

// "/r/X/comments/..." -> an absolute URL; the archive returns site-relative paths.
function permalinkOf(raw) {
  const path = text(raw?.permalink);
  if (!path) return null;
  return path.startsWith('http') ? path : `https://www.reddit.com${path.startsWith('/') ? '' : '/'}${path}`;
}

// A fullname identifies the item the same way content_items does, so the two
// can be compared by eye even though they are never merged.
function fullnameOf(raw, kind) {
  const name = text(raw?.name);
  if (name && /^t[135]_[a-z0-9]+$/i.test(name)) return name;
  const id = text(raw?.id);
  return id ? `${KINDS[kind]}${id}` : null;
}

/**
 * One archive record -> one archived_items row, or null if it cannot be
 * identified. A row with no usable id is dropped rather than invented, the
 * same way the vote import skips rows it cannot read.
 */
export function toArchivedItem(raw, { accountId, kind, fetchedAt, source = ARCHIVE_SOURCE }) {
  const itemId = fullnameOf(raw, kind);
  if (!itemId) return null;
  const body = text(kind === 'post' ? raw?.selftext : raw?.body);
  return {
    account_id: accountId,
    item_id: itemId,
    kind,
    subreddit: text(raw?.subreddit),
    permalink: permalinkOf(raw),
    title: kind === 'post' ? text(raw?.title) : null,
    // "[removed]" / "[deleted]" is what the archive saw, not the original text.
    // It is kept as-is: pretending it is empty would hide that the archive's
    // own copy was taken after the item was already gone.
    body,
    score: Number.isFinite(Number(raw?.score)) ? Number(raw.score) : null,
    removed_by_category: text(raw?.removed_by_category),
    created_at: toIso(raw?.created_utc),
    source,
    fetched_at: fetchedAt,
  };
}

/** Newest first, de-duplicated by item id (the archive can repeat a row). */
export function normalizeArchiveItems(records, options) {
  const byId = new Map();
  for (const raw of Array.isArray(records) ? records : []) {
    const row = toArchivedItem(raw, options);
    if (row && !byId.has(row.item_id)) byId.set(row.item_id, row);
  }
  return [...byId.values()].sort((a, b) => Date.parse(b.created_at ?? 0) - Date.parse(a.created_at ?? 0));
}

/**
 * What the recovered history says, as a summary the UI can lead with.
 *
 * `removed_by_category: 'reddit'` is the one worth surfacing on its own: it is
 * a site-wide removal by Reddit itself rather than a subreddit moderator, and
 * on a suspended account it is usually the step before the account went.
 */
export function summarizeArchive(rows) {
  const items = Array.isArray(rows) ? rows : [];
  const bySubreddit = new Map();
  let siteRemoved = 0;
  let modRemoved = 0;
  for (const row of items) {
    const name = row.subreddit ?? 'unknown';
    bySubreddit.set(name, (bySubreddit.get(name) ?? 0) + 1);
    if (row.removed_by_category === 'reddit') siteRemoved++;
    else if (row.removed_by_category) modRemoved++;
  }
  const dated = items.map((row) => Date.parse(row.created_at ?? '')).filter(Number.isFinite);
  return {
    items: items.length,
    posts: items.filter((row) => row.kind === 'post').length,
    comments: items.filter((row) => row.kind === 'comment').length,
    site_removed: siteRemoved,
    mod_removed: modRemoved,
    subreddits: [...bySubreddit.entries()]
      .map(([subreddit, count]) => ({ subreddit, count }))
      .sort((a, b) => b.count - a.count || a.subreddit.localeCompare(b.subreddit)),
    first_at: dated.length ? new Date(Math.min(...dated)).toISOString() : null,
    last_at: dated.length ? new Date(Math.max(...dated)).toISOString() : null,
  };
}

export class ArchiveError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'ArchiveError';
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Client for the archive. `fetchImpl` and `now` are injected so tests drive it
 * without a network, the same arrangement as createRedditClient.
 */
export function createArchiveClient({
  fetchImpl = (...args) => fetch(...args),
  baseUrl = ARCHIVE_BASE,
  source = ARCHIVE_SOURCE,
  now = () => Date.now(),
  // One request at a time, spaced out. This is someone else's free service and
  // a recovery is two requests per account; there is no reason to rush it.
  minIntervalMs = 1000,
  timeoutMs = 60_000,
  maxItems = 500,
} = {}) {
  let queue = Promise.resolve();
  let nextAllowedAt = 0;

  async function get(path) {
    const run = queue.then(async () => {
      const wait = nextAllowedAt - now();
      if (wait > 0) await sleep(wait);
      let response;
      try {
        response = await fetchImpl(`${baseUrl}${path}`, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new ArchiveError(
          /abort|timeout/i.test(String(err?.message))
            ? 'The history archive did not respond in time. Nothing was changed; try again later.'
            : 'The history archive could not be reached. Nothing was changed; check the connection and try again.',
        );
      } finally {
        nextAllowedAt = now() + minIntervalMs;
      }
      if (response.status === 429) {
        throw new ArchiveError('The history archive is rate-limiting this workspace. Wait a few minutes and try again.', { status: 429 });
      }
      if (!response.ok) {
        // The archive explains itself in the body ("'limit' must be between 1
        // and 100"). Passing that through turns an opaque status into
        // something an operator can act on.
        let detail = null;
        try {
          const body = await response.json();
          detail = typeof body?.error === 'string' && body.error.trim() ? body.error.trim() : null;
        } catch { /* a body is optional; the status still stands */ }
        throw new ArchiveError(
          `The history archive answered ${response.status}${detail ? `: ${detail}` : ''}. Nothing was changed.`,
          { status: response.status },
        );
      }
      let payload;
      try { payload = await response.json(); } catch {
        throw new ArchiveError('The history archive returned a response this server could not read.');
      }
      // The service wraps results in { data: [...] }; anything else is a shape
      // change, and guessing at it would invent history.
      if (!payload || !Array.isArray(payload.data)) {
        throw new ArchiveError('The history archive returned an unexpected format. Nothing was changed.');
      }
      return payload.data;
    });
    queue = run.then(() => {}, () => {});
    return run;
  }

  // Walk backwards through one kind, newest first, a page at a time.
  // `before` is the oldest timestamp already seen, so each page continues
  // where the last stopped.
  async function collect(path, user, want) {
    const out = [];
    let before = null;
    while (out.length < want) {
      const size = Math.min(PAGE_LIMIT, want - out.length);
      const query = `author=${user}&limit=${size}&sort=desc${before === null ? '' : `&before=${before}`}`;
      const batch = await get(`${path}?${query}`);
      if (!batch.length) break;
      out.push(...batch);
      // A short page is the end of the history.
      if (batch.length < size) break;
      const oldest = Number(batch[batch.length - 1]?.created_utc);
      // Without a strictly older cursor the next page would repeat this one
      // forever, so stop rather than loop.
      if (!Number.isFinite(oldest) || (before !== null && oldest >= before)) break;
      before = oldest;
    }
    return out;
  }

  return {
    source,
    /** Recovered posts and comments for a username, newest first. */
    async fetchHistory(username, { accountId, limit = maxItems } = {}) {
      const capped = Math.max(1, Math.min(maxItems, Number(limit) || maxItems));
      const user = encodeURIComponent(username);
      const fetchedAt = new Date(now()).toISOString();
      const [posts, comments] = await Promise.all([
        collect('/api/posts/search', user, capped),
        collect('/api/comments/search', user, capped),
      ]);
      return [
        ...normalizeArchiveItems(posts, { accountId, kind: 'post', fetchedAt, source }),
        ...normalizeArchiveItems(comments, { accountId, kind: 'comment', fetchedAt, source }),
      ].sort((a, b) => Date.parse(b.created_at ?? 0) - Date.parse(a.created_at ?? 0));
    },
  };
}
