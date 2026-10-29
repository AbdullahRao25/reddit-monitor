import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARCHIVE_SOURCE,
  createArchiveClient,
  normalizeArchiveItems,
  summarizeArchive,
  toArchivedItem,
} from '../src/archive.js';

const FETCHED = '2026-10-30T12:00:00.000Z';
const opts = { accountId: 'acc-1', kind: 'post', fetchedAt: FETCHED };

// Shapes taken from a real Arctic Shift response for a suspended account.
const POST = {
  id: '1xgjr5w',
  name: 't3_1xgjr5w',
  created_utc: 1793077552,
  subreddit: 'ThreadVerdict',
  title: 'K-beauty sunscreen lovers',
  selftext: '[removed]',
  permalink: '/r/ThreadVerdict/comments/1xgjr5w/kbeauty/',
  removed_by_category: 'reddit',
  score: 1,
};
const COMMENT = {
  id: '19rgy6t3rqeck',
  name: 't1_19rgy6t3rqeck',
  created_utc: 1792649331,
  subreddit: 'ProductHunters',
  body: 'I would make the page yourself.',
  permalink: '/r/ProductHunters/comments/1xan1mz/question/19rgy6t3rqeck/',
  score: 1,
};

test('an archive record becomes a row that says where it came from', () => {
  const row = toArchivedItem(POST, opts);
  assert.equal(row.item_id, 't3_1xgjr5w');
  assert.equal(row.kind, 'post');
  assert.equal(row.subreddit, 'ThreadVerdict');
  assert.equal(row.title, 'K-beauty sunscreen lovers');
  assert.equal(row.created_at, new Date(1793077552 * 1000).toISOString());
  assert.equal(row.permalink, 'https://www.reddit.com/r/ThreadVerdict/comments/1xgjr5w/kbeauty/');
  // The whole point of recovering a dead account: who removed it.
  assert.equal(row.removed_by_category, 'reddit');
  assert.equal(row.source, ARCHIVE_SOURCE, 'a third party copy is labelled as one');
  // "[removed]" is kept rather than blanked: it records that the archive's own
  // copy was taken after the item was already gone.
  assert.equal(row.body, '[removed]');
});

test('a comment keeps its body and carries no title', () => {
  const row = toArchivedItem(COMMENT, { ...opts, kind: 'comment' });
  assert.equal(row.item_id, 't1_19rgy6t3rqeck');
  assert.equal(row.title, null);
  assert.equal(row.body, 'I would make the page yourself.');
});

test('an id is derived when absent, and a record without one is dropped', () => {
  // A fullname is preferred, but the bare id plus the kind reconstructs it.
  assert.equal(toArchivedItem({ id: 'abc', created_utc: 1 }, opts).item_id, 't3_abc');
  assert.equal(toArchivedItem({ id: 'abc', created_utc: 1 }, { ...opts, kind: 'comment' }).item_id, 't1_abc');
  // Never invented: an unidentifiable record is skipped, not guessed at.
  assert.equal(toArchivedItem({ created_utc: 1 }, opts), null);
  assert.equal(toArchivedItem({}, opts), null);
});

test('an unusable timestamp becomes null rather than a made-up date', () => {
  for (const created of [undefined, null, 0, -1, 'nonsense', Number.NaN, 1e18]) {
    assert.equal(toArchivedItem({ id: 'x', created_utc: created }, opts).created_at, null);
  }
});

test('records are de-duplicated and returned newest first', () => {
  const rows = normalizeArchiveItems(
    [
      { id: 'old', created_utc: 1000 },
      { id: 'new', created_utc: 2000 },
      { id: 'old', created_utc: 1000 },
      { nothing: true },
    ],
    opts,
  );
  assert.deepEqual(rows.map((row) => row.item_id), ['t3_new', 't3_old']);
});

test('the summary separates a site-wide removal from a moderator one', () => {
  // This is the distinction that matters on a dead account: Reddit itself
  // removing something is the step before the account goes, a subreddit
  // moderator removing something is an ordinary rule problem.
  const rows = [
    { kind: 'post', subreddit: 'A', removed_by_category: 'reddit', created_at: '2026-10-27T00:00:00.000Z' },
    { kind: 'post', subreddit: 'A', removed_by_category: 'moderator', created_at: '2026-10-21T00:00:00.000Z' },
    { kind: 'comment', subreddit: 'B', removed_by_category: null, created_at: '2026-10-22T00:00:00.000Z' },
    { kind: 'comment', subreddit: null, removed_by_category: null, created_at: null },
  ];
  const summary = summarizeArchive(rows);
  assert.equal(summary.items, 4);
  assert.equal(summary.posts, 2);
  assert.equal(summary.comments, 2);
  assert.equal(summary.site_removed, 1);
  assert.equal(summary.mod_removed, 1);
  assert.equal(summary.first_at, '2026-10-21T00:00:00.000Z');
  assert.equal(summary.last_at, '2026-10-27T00:00:00.000Z');
  // An item with no subreddit is counted, not dropped, so the totals add up.
  assert.deepEqual(summary.subreddits, [
    { subreddit: 'A', count: 2 },
    { subreddit: 'B', count: 1 },
    { subreddit: 'unknown', count: 1 },
  ]);
});

function clientWith(handler, options = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return handler(url);
  };
  return { calls, client: createArchiveClient({ fetchImpl, minIntervalMs: 0, now: () => Date.parse(FETCHED), ...options }) };
}

const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });

test('a recovery asks for posts and comments and merges them newest first', async () => {
  const { calls, client } = clientWith(async (url) => ok(url.includes('/posts/') ? [POST] : [COMMENT]));
  const rows = await client.fetchHistory('Team_ThreadVerdict', { accountId: 'acc-1' });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.kind), ['post', 'comment'], 'the newer post leads');
  assert.ok(calls.some((url) => url.includes('/api/posts/search?author=Team_ThreadVerdict')));
  assert.ok(calls.some((url) => url.includes('/api/comments/search?author=Team_ThreadVerdict')));
  // Each row knows which account it was recovered for.
  for (const row of rows) assert.equal(row.account_id, 'acc-1');
});

test('a username is escaped into the query, never concatenated raw', async () => {
  const { calls, client } = clientWith(async () => ok([]));
  await client.fetchHistory('a b&c=d', { accountId: 'acc-1' });
  for (const url of calls) {
    assert.ok(url.includes('author=a%20b%26c%3Dd'), `expected an escaped author in ${url}`);
  }
});

test('an unreachable or unreadable archive reports, and never invents history', async () => {
  const cases = [
    [async () => { throw new Error('getaddrinfo ENOTFOUND'); }, /could not be reached/i, null],
    [async () => { throw new Error('The operation was aborted due to timeout'); }, /did not respond in time/i, null],
    [async () => ({ ok: false, status: 429, json: async () => ({}) }), /rate-limiting/i, 429],
    [async () => ({ ok: false, status: 503, json: async () => ({}) }), /answered 503/i, 503],
    [async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }), /could not read/i, null],
    [async () => ({ ok: true, status: 200, json: async () => ({ unexpected: true }) }), /unexpected format/i, null],
  ];
  for (const [handler, message, status] of cases) {
    const { client } = clientWith(handler);
    await assert.rejects(client.fetchHistory('x', { accountId: 'acc-1' }), (err) => {
      assert.equal(err.name, 'ArchiveError');
      assert.match(err.message, message);
      assert.equal(err.status, status);
      return true;
    });
  }
});

// ---------- paging ----------
//
// The archive refuses limit > 100 with a 400, which is how this first shipped
// broken: the default asked for 500 and every recovery failed.

test('no request ever asks for more than the archive allows', async () => {
  const { calls, client } = clientWith(async () => ok([]));
  await client.fetchHistory('x', { accountId: 'a', limit: 500 });
  for (const url of calls) {
    const limit = Number(new URL(url).searchParams.get('limit'));
    assert.ok(limit >= 1 && limit <= 100, `limit ${limit} is outside 1..100 in ${url}`);
  }
});

test('more than one page is collected by walking backwards', async () => {
  // A full page means there may be more; the next request continues from the
  // oldest item seen rather than asking for a bigger page.
  const page = (from, n) => Array.from({ length: n }, (_, i) => ({ id: `c${from - i}`, created_utc: from - i }));
  const seen = [];
  const { client } = clientWith(async (url) => {
    const params = new URL(url).searchParams;
    const before = params.get('before');
    seen.push(before);
    if (!url.includes('/comments/')) return ok([]);
    if (before === null) return ok(page(1000, 100));
    if (Number(before) === 901) return ok(page(900, 5));
    return ok([]);
  }, { maxItems: 200 });

  const rows = await client.fetchHistory('x', { accountId: 'a' });
  assert.equal(rows.length, 105, 'both pages are kept');
  assert.ok(seen.includes('901'), 'the second page continues from the oldest item of the first');
  // Newest first, across the page boundary.
  assert.equal(rows[0].item_id, 't1_c1000');
  assert.equal(rows.at(-1).item_id, 't1_c896');
});

test('a short page ends the walk without another request', async () => {
  let requests = 0;
  const { client } = clientWith(async (url) => {
    requests++;
    return ok(url.includes('/comments/') ? [{ id: 'only', created_utc: 10 }] : []);
  }, { maxItems: 200 });
  await client.fetchHistory('x', { accountId: 'a' });
  assert.equal(requests, 2, 'one request per kind, because neither filled a page');
});

test('a cursor that does not move stops the walk instead of looping', async () => {
  // A page whose oldest item is not older than the cursor would repeat for
  // ever. Bounded regardless of what the archive returns.
  let requests = 0;
  const { client } = clientWith(async (url) => {
    requests++;
    if (!url.includes('/comments/')) return ok([]);
    return ok(Array.from({ length: 100 }, (_, i) => ({ id: `x${i}`, created_utc: 500 })));
  }, { maxItems: 1000 });
  const rows = await client.fetchHistory('x', { accountId: 'a' });
  assert.ok(requests < 10, `expected the walk to stop quickly, made ${requests} requests`);
  assert.ok(rows.length > 0);
});

test("the archive's own explanation is passed through, not swallowed", async () => {
  const { client } = clientWith(async () => ({
    ok: false, status: 400, json: async () => ({ data: null, error: "'limit' must be between 1 and 100" }),
  }));
  await assert.rejects(client.fetchHistory('x', { accountId: 'a' }), (err) => {
    assert.match(err.message, /between 1 and 100/, 'the reason reaches the operator');
    assert.equal(err.status, 400);
    return true;
  });
});
