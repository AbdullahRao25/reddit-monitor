import test from 'node:test';
import assert from 'node:assert/strict';
import {api, MIN_ITEMS_FOR_RATE, removalRate} from '../src/lib/api.js';
import {demoSubreddits} from '../src/lib/demoData.js';
import {MIN_ITEMS_FOR_RATE as SERVER_MIN, summarizeSubreddits} from '../../server/src/subreddits.js';

const A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const mock = async (impl, run) => {
  const old = globalThis.fetch;
  globalThis.fetch = impl;
  try { await run(); } finally { globalThis.fetch = old; }
};

test('the account breakdown defaults to the server window and can narrow it', () => mock(async (path) => {
  assert.ok(path === `/api/accounts/${A}/subreddits` || path === `/api/accounts/${A}/subreddits?days=30`, path);
  return {ok: true, status: 200, json: async () => ({window_days: 90, summary: {}, subreddits: []})};
}, async () => {
  await api.subreddits(A);
  await api.subreddits(A, {days: 30});
}));

test('the workspace breakdown is its own route', () => mock(async (path) => {
  assert.equal(path, '/api/subreddits?days=180');
  return {ok: true, status: 200, json: async () => ({window_days: 180, accounts: 2, subreddits: []})};
}, async () => assert.equal((await api.allSubreddits({days: 180})).accounts, 2)));

test('demo data has the same shape the panel reads from the API', () => {
  const live = demoSubreddits('demo-a3');
  assert.equal(live.window_days, 90);
  assert.ok(Array.isArray(live.subreddits));
  for (const key of ['subreddit', 'items', 'posts', 'comments', 'removed', 'removed_sitewide', 'removed_by_mod', 'removal_rate', 'thin_sample', 'last_removal_at']) {
    assert.ok(key in live.subreddits[0], `missing ${key}`);
  }
  // The demo account's removals are concentrated, so the panel's verdict has
  // something to say about reading one community's rules.
  assert.equal(live.summary.worst, 'askreddit');
  assert.ok(live.summary.share > 0.5);
  assert.equal(live.summary.removed, live.subreddits.reduce((sum, row) => sum + row.removed, 0));
});

test('rows are worst-first, and a thin sample reports no rate', () => {
  const rows = demoSubreddits('demo-a3').subreddits;
  assert.equal(rows[0].subreddit, 'askreddit');
  const thin = rows.find((row) => row.thin_sample);
  assert.equal(thin.removal_rate, null, 'a rate off two items would invite a wrong conclusion');
});

test('an account with nothing tracked gets an empty, valid breakdown', () => {
  const empty = demoSubreddits('demo-nobody');
  assert.deepEqual(empty.subreddits, []);
  assert.deepEqual(empty.summary, {removed: 0, items: 0, subreddits: 0, worst: null, share: null});
});

// The demo data has to apply the server's thin-sample rule itself, since demo
// mode never calls the API. This pins the client's copy of the rule to the
// server's by behaviour, so the two cannot drift apart unnoticed.
test('the client and the server agree on when a removal rate is reportable', () => {
  assert.equal(MIN_ITEMS_FOR_RATE, SERVER_MIN);
  const item = (removal_status) => ({id: `t3_${Math.random()}`, kind: 'post', subreddit: 'x', created_at: new Date().toISOString(), removal_status});
  for (const items of [2, 3, 4, 8]) {
    const rows = summarizeSubreddits([item('removed_by_mod'), ...Array.from({length: items - 1}, () => item('visible'))]);
    assert.equal(rows[0].items, items);
    assert.equal(rows[0].removal_rate, removalRate(1, items), `${items} items`);
  }
});
