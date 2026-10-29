import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryRepo } from './helpers.js';
import { withServer } from './harness.js';

const ROW = (over = {}) => ({
  item_id: 't3_a1',
  kind: 'post',
  subreddit: 'ThreadVerdict',
  permalink: 'https://www.reddit.com/r/ThreadVerdict/comments/a1/x/',
  title: 'A post',
  body: '[removed]',
  score: 1,
  removed_by_category: 'reddit',
  created_at: '2026-10-27T00:00:00.000Z',
  source: 'arctic-shift',
  fetched_at: '2026-10-30T12:00:00.000Z',
  ...over,
});

async function suspendedAccount(repo) {
  const account = await repo.createAccount({ username: 'Team_ThreadVerdict' });
  await repo.updateAccount(account.id, { status: 'suspended' });
  return account;
}

const archiveReturning = (rows) => ({ fetchHistory: async (_u, { accountId }) => rows.map((r) => ({ ...r, account_id: accountId })) });

test('recovery stores history for an account whose public pages are gone', async () => {
  const repo = createMemoryRepo();
  const account = await suspendedAccount(repo);
  await withServer({ repo, archive: archiveReturning([ROW(), ROW({ item_id: 't1_b2', kind: 'comment', title: null, body: 'hi', removed_by_category: null, created_at: '2026-10-22T00:00:00.000Z' })]) }, async (call) => {
    const res = await call('POST', `/api/accounts/${account.id}/archive/recover`);
    assert.equal(res.status, 200);
    assert.equal(res.body.recovered, 2);
    assert.equal(res.body.summary.items, 2);
    assert.equal(res.body.summary.posts, 1);
    assert.equal(res.body.summary.comments, 1);
    // The reason an operator opens this screen at all.
    assert.equal(res.body.summary.site_removed, 1);
    // Every response says the rows are a third party's copy.
    assert.match(res.body.source_note, /third-party public Reddit archive/i);

    // And it is readable afterwards without touching the archive again.
    const read = await call('GET', `/api/accounts/${account.id}/archive`);
    assert.equal(read.status, 200);
    assert.equal(read.body.items.length, 2);
    assert.deepEqual(read.body.items.map((i) => i.item_id), ['t3_a1', 't1_b2'], 'newest first');
  });
});

test('a recovery that finds nothing leaves earlier history alone', async () => {
  // The archive answering empty is not the same as the history being empty,
  // and wiping a dead account's only remaining record would be unrecoverable.
  const repo = createMemoryRepo();
  const account = await suspendedAccount(repo);
  await repo.upsertArchivedItems([{ ...ROW(), account_id: account.id }]);
  await withServer({ repo, archive: archiveReturning([]) }, async (call) => {
    const res = await call('POST', `/api/accounts/${account.id}/archive/recover`);
    assert.equal(res.status, 200);
    assert.equal(res.body.recovered, 0);
    assert.equal(res.body.items.length, 1, 'what was already recovered survives');
  });
});

test('an unreachable archive reports without disturbing stored history', async () => {
  const repo = createMemoryRepo();
  const account = await suspendedAccount(repo);
  await repo.upsertArchivedItems([{ ...ROW(), account_id: account.id }]);
  const failing = { fetchHistory: async () => { const err = new Error('The history archive could not be reached.'); err.name = 'ArchiveError'; err.status = null; throw err; } };
  await withServer({ repo, archive: failing }, async (call) => {
    const res = await call('POST', `/api/accounts/${account.id}/archive/recover`);
    assert.equal(res.status, 502);
    assert.match(res.body.error, /could not be reached/i);
    const read = await call('GET', `/api/accounts/${account.id}/archive`);
    assert.equal(read.body.items.length, 1);
  });
});

test('a rate-limited archive answers 429, not a generic failure', async () => {
  const repo = createMemoryRepo();
  const account = await suspendedAccount(repo);
  const limited = { fetchHistory: async () => { const err = new Error('rate-limiting this workspace'); err.name = 'ArchiveError'; err.status = 429; throw err; } };
  await withServer({ repo, archive: limited }, async (call) => {
    assert.equal((await call('POST', `/api/accounts/${account.id}/archive/recover`)).status, 429);
  });
});

test('without a configured archive the route says so instead of failing oddly', async () => {
  const repo = createMemoryRepo();
  const account = await suspendedAccount(repo);
  await withServer({ repo }, async (call) => {
    const res = await call('POST', `/api/accounts/${account.id}/archive/recover`);
    assert.equal(res.status, 503);
    // Reading what is already stored must still work with no archive wired up.
    assert.equal((await call('GET', `/api/accounts/${account.id}/archive`)).status, 200);
  });
});

test('history can be cleared, and an unknown account 404s', async () => {
  const repo = createMemoryRepo();
  const account = await suspendedAccount(repo);
  await repo.upsertArchivedItems([{ ...ROW(), account_id: account.id }]);
  await withServer({ repo, archive: archiveReturning([]) }, async (call) => {
    assert.equal((await call('DELETE', `/api/accounts/${account.id}/archive`)).status, 204);
    assert.equal((await call('GET', `/api/accounts/${account.id}/archive`)).body.items.length, 0);
    for (const path of ['not-a-uuid', '11111111-2222-3333-4444-555555555555']) {
      assert.equal((await call('GET', `/api/accounts/${path}/archive`)).status, 404);
    }
  });
});

test('recovered history is kept apart from the checker own observations', async () => {
  // archived_items must never reach content_items: the checker treats a stored
  // item missing from today listing as a removal, so archive rows would
  // manufacture removals on every check.
  const repo = createMemoryRepo();
  const account = await suspendedAccount(repo);
  await withServer({ repo, archive: archiveReturning([ROW()]) }, async (call) => {
    await call('POST', `/api/accounts/${account.id}/archive/recover`);
    const content = await repo.listContent(account.id, { limit: 50 });
    assert.equal(content.length, 0, 'recovery writes no content_items rows');
  });
});
