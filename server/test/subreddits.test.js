import assert from 'node:assert/strict';
import test from 'node:test';
import { concentration, mergeSubredditSummaries, summarizeSubreddits } from '../src/subreddits.js';
import { withServer } from './harness.js';
import { DAY, NOW, createMemoryRepo } from './helpers.js';

const iso = (ms) => new Date(ms).toISOString();
let counter = 0;
const item = (over = {}) => ({
  id: `t3_${(counter++).toString(36)}`,
  kind: 'post',
  subreddit: 'cooking',
  created_at: iso(NOW - DAY),
  removal_status: 'visible',
  score: 1,
  ...over,
});

test('items are grouped by subreddit and split by kind', () => {
  const rows = summarizeSubreddits(
    [item(), item({ kind: 'comment' }), item({ subreddit: 'gardening' })],
    { now: NOW },
  );
  assert.equal(rows.length, 2);
  const cooking = rows.find((r) => r.subreddit === 'cooking');
  assert.equal(cooking.items, 2);
  assert.equal(cooking.posts, 1);
  assert.equal(cooking.comments, 1);
});

test('subreddit names are normalised so r/X, /r/x and X are one community', () => {
  const rows = summarizeSubreddits([item({ subreddit: 'r/Cooking' }), item({ subreddit: '/r/cooking' }), item({ subreddit: 'COOKING' })], { now: NOW });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subreddit, 'cooking');
  assert.equal(rows[0].items, 3);
});

test('an item with no subreddit is counted as unknown, never dropped', () => {
  const rows = summarizeSubreddits([item({ subreddit: null }), item({ subreddit: '  ' })], { now: NOW });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subreddit, 'unknown');
  assert.equal(rows[0].items, 2, 'the totals have to add up');
});

test('removals are split by who removed them', () => {
  const rows = summarizeSubreddits(
    [
      item({ removal_status: 'removed_by_mod' }),
      item({ removal_status: 'spam_filtered' }),
      item({ removal_status: 'removed_by_admin' }),
      item({ removal_status: 'deleted_by_author' }),
      item(),
    ],
    { now: NOW },
  );
  const row = rows[0];
  assert.equal(row.items, 5);
  assert.equal(row.removed, 3, 'the author deleting their own post is not a removal');
  assert.equal(row.removed_by_mod, 1);
  assert.equal(row.removed_sitewide, 2, 'spam filter and admin: the ones that precede a shadowban');
});

test('a removal rate needs a sample, and says so when it has none', () => {
  // One removal out of two posts is one removal, not a 50% removal rate.
  const thin = summarizeSubreddits([item({ removal_status: 'removed_by_mod' }), item()], { now: NOW });
  assert.equal(thin[0].removal_rate, null);
  assert.equal(thin[0].thin_sample, true);

  const enough = summarizeSubreddits([item({ removal_status: 'removed_by_mod' }), item(), item(), item()], { now: NOW });
  assert.equal(enough[0].removal_rate, 0.25);
  assert.equal(enough[0].thin_sample, false);
});

test('the window excludes older items but keeps undated ones', () => {
  const rows = summarizeSubreddits(
    [item(), item({ created_at: iso(NOW - 200 * DAY) }), item({ created_at: null })],
    { now: NOW, windowDays: 90 },
  );
  assert.equal(rows[0].items, 2, 'the 200-day-old item is outside the window');
  assert.equal(rows[0].undated, 1, 'an undated item cannot be placed, so it is counted and flagged');
});

test('the window falls back to the default when it is nonsense', () => {
  const old = [item({ created_at: iso(NOW - 120 * DAY) })];
  for (const windowDays of [undefined, 0, NaN, 'soon', null]) {
    assert.equal(summarizeSubreddits(old, { now: NOW, windowDays }).length, 0, String(windowDays));
  }
  assert.equal(summarizeSubreddits(old, { now: NOW, windowDays: 365 }).length, 1);
});

test('rows open on the community that needs reading about', () => {
  const rows = summarizeSubreddits(
    [
      ...Array.from({ length: 10 }, () => item({ subreddit: 'quiet' })),
      ...Array.from({ length: 5 }, () => item({ subreddit: 'hostile', removal_status: 'removed_by_mod' })),
      item({ subreddit: 'mild', removal_status: 'spam_filtered' }),
      ...Array.from({ length: 4 }, () => item({ subreddit: 'mild' })),
    ],
    { now: NOW },
  );
  assert.deepEqual(rows.map((r) => r.subreddit), ['hostile', 'mild', 'quiet']);
});

test('the last removal is dated from detection, falling back to the post date', () => {
  const rows = summarizeSubreddits(
    [
      item({ removal_status: 'removed_by_mod', created_at: iso(NOW - 10 * DAY), removal_detected_at: iso(NOW - 2 * DAY) }),
      item({ removal_status: 'removed_by_mod', created_at: iso(NOW - 5 * DAY) }),
    ],
    { now: NOW },
  );
  assert.equal(rows[0].last_removal_at, iso(NOW - 2 * DAY));
});

test('concentration separates one subreddit rule from an account-wide problem', () => {
  const oneBadSub = summarizeSubreddits(
    [
      ...Array.from({ length: 5 }, () => item({ subreddit: 'hostile', removal_status: 'removed_by_mod' })),
      ...Array.from({ length: 20 }, () => item({ subreddit: 'fine' })),
    ],
    { now: NOW },
  );
  const focused = concentration(oneBadSub);
  assert.equal(focused.removed, 5);
  assert.equal(focused.worst, 'hostile');
  assert.equal(focused.share, 1, 'every removal came from one community: read its rules');

  const everywhere = summarizeSubreddits(
    ['a', 'b', 'c', 'd'].flatMap((sub) => [item({ subreddit: sub, removal_status: 'spam_filtered' }), item({ subreddit: sub })]),
    { now: NOW },
  );
  assert.equal(concentration(everywhere).share, 0.25, 'spread evenly: the account, not a subreddit');
});

test('concentration of a clean account names no worst community', () => {
  assert.deepEqual(concentration(summarizeSubreddits([item(), item()], { now: NOW })), {
    removed: 0,
    items: 2,
    subreddits: 1,
    worst: null,
    share: null,
  });
  assert.deepEqual(concentration([]), { removed: 0, items: 0, subreddits: 0, worst: null, share: null });
});

test('the workspace view puts subreddits hitting several accounts first', () => {
  const merged = mergeSubredditSummaries([
    {
      account: { id: '1', username: 'one' },
      rows: summarizeSubreddits([item({ subreddit: 'shared', removal_status: 'removed_by_mod' }), item({ subreddit: 'solo', removal_status: 'removed_by_mod' }), item({ subreddit: 'solo', removal_status: 'spam_filtered' })], { now: NOW }),
    },
    {
      account: { id: '2', username: 'two' },
      rows: summarizeSubreddits([item({ subreddit: 'shared', removal_status: 'spam_filtered' }), item({ subreddit: 'quiet' })], { now: NOW }),
    },
  ]);
  assert.equal(merged[0].subreddit, 'shared');
  assert.equal(merged[0].accounts_with_removals, 2);
  assert.equal(merged[0].account_count, 2);
  assert.deepEqual(merged[0].accounts.map((a) => a.username), ['one', 'two']);
  assert.equal(merged.find((r) => r.subreddit === 'solo').removed, 2);
  assert.equal(merged.find((r) => r.subreddit === 'quiet').removed, 0);
});

// ---------------------------------------------------------------- the routes


test('GET account subreddits reports the breakdown and the window used', async () => {
  const repo = createMemoryRepo();
  const account = await repo.createAccount({ username: 'tester' });
  const now = Date.now();
  await repo.upsertContentItems([
    { id: 't3_1', account_id: account.id, kind: 'post', subreddit: 'hostile', created_at: new Date(now - DAY).toISOString(), removal_status: 'removed_by_mod' },
    { id: 't3_2', account_id: account.id, kind: 'post', subreddit: 'hostile', created_at: new Date(now - 2 * DAY).toISOString(), removal_status: 'spam_filtered' },
    { id: 't3_3', account_id: account.id, kind: 'comment', subreddit: 'fine', created_at: new Date(now - DAY).toISOString(), removal_status: 'visible' },
  ]);
  await withServer({ repo }, async (call) => {
    const res = await call('GET', `/api/accounts/${account.id}/subreddits`);
    assert.equal(res.status, 200);
    assert.equal(res.body.window_days, 90);
    assert.equal(res.body.username, 'tester');
    assert.equal(res.body.subreddits[0].subreddit, 'hostile');
    assert.equal(res.body.summary.worst, 'hostile');
    assert.equal(res.body.summary.share, 1);

    const narrowed = await call('GET', `/api/accounts/${account.id}/subreddits?days=30`);
    assert.equal(narrowed.body.window_days, 30);
    // Out-of-range and unparseable windows fall back to the default.
    assert.equal((await call('GET', `/api/accounts/${account.id}/subreddits?days=9999`)).body.window_days, 90);
    assert.equal((await call('GET', `/api/accounts/${account.id}/subreddits?days=abc`)).body.window_days, 90);

    assert.equal((await call('GET', '/api/accounts/00000000-0000-4000-8000-000000000000/subreddits')).status, 404);
  });
});

test('GET subreddits aggregates every account', async () => {
  const repo = createMemoryRepo();
  const one = await repo.createAccount({ username: 'one' });
  const two = await repo.createAccount({ username: 'two' });
  const now = Date.now();
  await repo.upsertContentItems([
    { id: 't3_a', account_id: one.id, kind: 'post', subreddit: 'shared', created_at: new Date(now - DAY).toISOString(), removal_status: 'removed_by_mod' },
    { id: 't3_b', account_id: two.id, kind: 'post', subreddit: 'shared', created_at: new Date(now - DAY).toISOString(), removal_status: 'spam_filtered' },
  ]);
  await withServer({ repo }, async (call) => {
    const res = await call('GET', '/api/subreddits');
    assert.equal(res.status, 200);
    assert.equal(res.body.accounts, 2);
    assert.equal(res.body.subreddits[0].subreddit, 'shared');
    assert.equal(res.body.subreddits[0].accounts_with_removals, 2);
  });
});

test('a workspace with no accounts answers with an empty breakdown', async () => {
  await withServer({ repo: createMemoryRepo() }, async (call) => {
    const res = await call('GET', '/api/subreddits');
    assert.deepEqual(res.body, { window_days: 90, accounts: 0, subreddits: [] });
  });
});
