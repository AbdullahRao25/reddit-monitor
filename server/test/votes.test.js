import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { parseCsv, parsePermalink, parseVoteCsv, sharedVotesFor, summarizeVotes } from '../src/votes.js';
import { createMemoryRepo, silentLog } from './helpers.js';

// Shaped like the files in Reddit's data export.
const POST_VOTES = [
  'id,permalink,direction',
  'abc123,https://www.reddit.com/r/pics/comments/abc123/a_sunset_over_the_bay/,up',
  'abc124,https://www.reddit.com/r/pics/comments/abc124/second_post/,down',
  'zz9,https://www.reddit.com/r/AskReddit/comments/zz9/what_is_your_favourite_book/,up',
].join('\n');
const COMMENT_VOTES = [
  'id,permalink,direction',
  'c1,https://www.reddit.com/r/pics/comments/abc123/a_sunset_over_the_bay/c1/,up',
  'c2,https://www.reddit.com/r/books/comments/b55/comment/c2/,up',
].join('\n');

test('parseCsv handles quotes, doubled quotes, embedded commas/newlines, CRLF and a BOM', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","say ""hi""\nthere"\r\n'), [
    ['a', 'b'],
    ['x, y', 'say "hi"\nthere'],
  ]);
});

test('parsePermalink reads posts, comments, profile posts and rejects other sites', () => {
  assert.deepEqual(parsePermalink('https://www.reddit.com/r/pics/comments/ABC123/a_title/'), {
    subreddit: 'pics', postId: 'abc123', commentId: null, slug: 'a_title',
    url: 'https://www.reddit.com/r/pics/comments/ABC123/a_title/',
  });
  assert.equal(parsePermalink('https://old.reddit.com/r/pics/comments/abc/t/def456/').commentId, 'def456');
  assert.equal(parsePermalink('/user/spez/comments/abc/hello/').subreddit, 'u_spez');
  assert.equal(parsePermalink('https://www.reddit.com/r/books/comments/b55/comment/c2/').slug, null);
  assert.equal(parsePermalink('https://evil.example/r/pics/comments/abc/t/'), null);
  assert.equal(parsePermalink('not a link'), null);
});

test('legacy and compact Reddit links are recognized without misclassifying votes', () => {
  const short = parsePermalink('https://reddit.com/comments/abc123/title/');
  assert.equal(short.postId, 'abc123');
  assert.equal(short.subreddit, null);
  assert.equal(parsePermalink('https://redd.it/ABC123').postId, 'abc123');
  const legacy = parseVoteCsv('id,permalink,direction\nc1,https://www.reddit.com/r/pics/comments/p1/c1/,up', 'comment');
  assert.equal(legacy.error, null);
  assert.equal(legacy.votes[0]?.item_id, 't1_c1');
  assert.equal(legacy.votes[0]?.kind, 'comment');
  assert.equal(legacy.skipped['a post link in the comment-votes file'] ?? 0, 0);
});

test('a mismatched ID and permalink is skipped instead of recording an incorrect vote', () => {
  const result = parseVoteCsv('id,permalink,direction\naaa,https://www.reddit.com/r/pics/comments/bbb/a_post/,up', 'post');
  assert.equal(result.votes.length, 0);
  assert.equal(result.skipped['the vote id does not match its Reddit link'], 1);
});

test('a post-votes file becomes one row per vote with fullname, community and title', () => {
  const { votes, skipped, error } = parseVoteCsv(POST_VOTES, 'post');
  assert.equal(error, null);
  assert.deepEqual(skipped, {});
  assert.deepEqual(votes[0], {
    item_id: 't3_abc123',
    kind: 'post',
    direction: 'up',
    subreddit: 'pics',
    permalink: 'https://www.reddit.com/r/pics/comments/abc123/a_sunset_over_the_bay/',
    title: 'a sunset over the bay',
  });
  assert.deepEqual(votes.map((v) => v.direction), ['up', 'down', 'up']);
});

test('unusable rows are skipped and counted, never guessed', () => {
  const csv = [
    'permalink,direction,id',
    'https://www.reddit.com/r/pics/comments/p1/t/,none,p1',
    'https://www.reddit.com/r/pics/comments/p2/t/c9/,up,c9',
    ',up,',
    'https://www.reddit.com/r/pics/comments/p3/t/,UP,',
    'https://www.reddit.com/r/pics/comments/p3/t/,down,p3',
  ].join('\n');
  const { votes, skipped } = parseVoteCsv(csv, 'post');
  // Columns are found by name, an id can come from the permalink, and a
  // repeated item keeps its last row.
  assert.deepEqual(votes.map((v) => [v.item_id, v.direction]), [['t3_p3', 'down']]);
  assert.deepEqual(skipped, {
    'not an up or down vote ("none")': 1,
    'a comment link in the post-votes file': 1,
    'no readable id or permalink': 1,
  });
});

test('a file that is not a vote export is rejected with what was found', () => {
  assert.match(parseVoteCsv('id,permalink\nabc,x', 'post').error, /expected the columns id, permalink and direction, found id, permalink/);
  assert.equal(parseVoteCsv('  \n', 'post').error, 'The file is empty.');
});

test('summary counts directions, kinds and the busiest communities', () => {
  const votes = [...parseVoteCsv(POST_VOTES, 'post').votes, ...parseVoteCsv(COMMENT_VOTES, 'comment').votes];
  const summary = summarizeVotes(votes);
  assert.deepEqual({ ...summary, by_subreddit: undefined }, { total: 5, up: 4, down: 1, posts: 3, comments: 2, by_subreddit: undefined });
  assert.deepEqual(summary.by_subreddit[0], { name: 'pics', up: 2, down: 1 });
});

test('sharedVotesFor lists only items this account and another account both voted on', () => {
  const rows = [
    { account_id: 'a', item_id: 't3_x', kind: 'post', direction: 'up', first_seen_at: '1' },
    { account_id: 'b', item_id: 't3_x', kind: 'post', direction: 'up', first_seen_at: '1' },
    { account_id: 'b', item_id: 't3_y', kind: 'post', direction: 'up', first_seen_at: '1' },
    { account_id: 'c', item_id: 't3_y', kind: 'post', direction: 'down', first_seen_at: '1' },
  ];
  const shared = sharedVotesFor('a', rows, new Map([['b', 'second_acct']]));
  assert.deepEqual(shared.map((s) => s.item_id), ['t3_x']);
  assert.deepEqual(shared[0].others, [{ account_id: 'b', username: 'second_acct', direction: 'up' }]);
});

async function withServer(repo, fn) {
  const app = createApp({
    repo,
    reddit: { verify: async () => {} },
    checker: { isChecking: () => false, checkAccount: async () => null },
    scheduler: { status: () => ({}), trigger: () => true },
    log: silentLog,
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, path, { csv } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: csv === undefined ? {} : { 'Content-Type': 'text/csv' },
      body: csv,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  try {
    await fn(call);
  } finally {
    server.close();
  }
}

test('votes API: import both files, list, filter, re-import, shared votes and clearing', async () => {
  const repo = createMemoryRepo();
  const one = await repo.createAccount({ username: 'first_acct' });
  const two = await repo.createAccount({ username: 'second_acct' });
  await withServer(repo, async (call) => {
    const empty = await call('GET', `/accounts/${one.id}/votes`);
    assert.equal(empty.status, 200);
    assert.equal(empty.body.summary.total, 0);
    assert.equal(empty.body.last_imported_at, null);

    const posts = await call('POST', `/accounts/${one.id}/votes/import?kind=post`, { csv: POST_VOTES });
    assert.equal(posts.status, 200);
    assert.deepEqual([posts.body.imported, posts.body.removed], [3, 0]);
    const comments = await call('POST', `/accounts/${one.id}/votes/import?kind=comment`, { csv: COMMENT_VOTES });
    assert.equal(comments.body.summary.total, 5);

    const all = await call('GET', `/accounts/${one.id}/votes`);
    assert.deepEqual({ up: all.body.summary.up, down: all.body.summary.down }, { up: 4, down: 1 });
    assert.ok(all.body.last_imported_at);
    const downs = await call('GET', `/accounts/${one.id}/votes?direction=down`);
    assert.deepEqual(downs.body.votes.map((v) => v.item_id), ['t3_abc124']);
    assert.equal(downs.body.matching, 1);
    const onComments = await call('GET', `/accounts/${one.id}/votes?kind=comment`);
    assert.deepEqual(onComments.body.votes.map((v) => v.item_id).sort(), ['t1_c1', 't1_c2']);

    // A newer export without a vote means it was taken back; other kinds stay.
    const reimport = await call('POST', `/accounts/${one.id}/votes/import?kind=post`, {
      csv: POST_VOTES.split('\n').slice(0, 2).join('\n'),
    });
    assert.deepEqual([reimport.body.imported, reimport.body.removed], [1, 2]);
    assert.deepEqual({ posts: reimport.body.summary.posts, comments: reimport.body.summary.comments }, { posts: 1, comments: 2 });

    // Another monitored account voting on the same post is flagged on both.
    await call('POST', `/accounts/${two.id}/votes/import?kind=post`, { csv: POST_VOTES });
    const shared = await call('GET', `/accounts/${one.id}/votes`);
    assert.deepEqual(shared.body.shared.map((s) => [s.item_id, s.others[0].username]), [['t3_abc123', 'second_acct']]);

    assert.equal((await call('DELETE', `/accounts/${one.id}/votes`)).status, 204);
    assert.equal((await call('GET', `/accounts/${one.id}/votes`)).body.summary.total, 0);
    assert.equal((await call('GET', `/accounts/${two.id}/votes`)).body.shared.length, 0);
  });
});

test('votes API refuses files that would silently wipe stored votes', async () => {
  const repo = createMemoryRepo();
  const account = await repo.createAccount({ username: 'first_acct' });
  await withServer(repo, async (call) => {
    await call('POST', `/accounts/${account.id}/votes/import?kind=post`, { csv: POST_VOTES });

    // The comment file uploaded as posts: every row mismatches, nothing is replaced.
    const wrongKind = await call('POST', `/accounts/${account.id}/votes/import?kind=post`, { csv: COMMENT_VOTES });
    assert.equal(wrongKind.status, 400);
    assert.match(wrongKind.body.error, /None of the 2 rows could be imported \(2 × a comment link in the post-votes file\)/);
    assert.equal(repo.votes.size, 3);

    assert.equal((await call('POST', `/accounts/${account.id}/votes/import`, { csv: POST_VOTES })).status, 400);
    assert.equal((await call('POST', `/accounts/${account.id}/votes/import?kind=post`, { csv: 'a,b\n1,2' })).status, 400);
    assert.equal((await call('GET', '/accounts/00000000-0000-4000-8000-000000000000/votes')).status, 404);

    // Deleting the account takes its votes with it.
    await repo.deleteAccount(account.id);
    assert.equal(repo.votes.size, 0);
  });
});
