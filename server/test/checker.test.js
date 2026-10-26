import assert from 'node:assert/strict';
import test from 'node:test';
import { checkLiveProfile, createChecker } from '../src/checker.js';
import {
  DAY,
  HOUR,
  NOW,
  createFakeReddit,
  createMemoryRepo,
  healthyProfile,
  rawComment,
  rawPost,
  silentLog,
} from './helpers.js';

function setup() {
  let clock = NOW;
  const repo = createMemoryRepo({ now: () => clock });
  const reddit = createFakeReddit();
  const notified = [];
  const checker = createChecker({
    repo,
    reddit,
    notify: async (alert) => notified.push(alert),
    now: () => clock,
    log: silentLog,
  });
  reddit.state.posts = [0, 1].map((i) => rawPost({ id: `p${i}`, createdAt: NOW - (i + 1) * DAY }));
  reddit.state.comments = [0, 1, 2, 3, 4, 5].map((i) =>
    rawComment({ id: `c${i}`, createdAt: NOW - (i + 1) * 8 * HOUR, body: `comment ${i} with some original text` }),
  );
  return {
    repo,
    reddit,
    checker,
    notified,
    advance: (ms) => {
      clock += ms;
    },
    // Always check against the stored row, like the scheduler does.
    check: async (id) => checker.checkAccount(await repo.getAccount(id)),
  };
}

test('a healthy account is recorded as active with no alerts', async () => {
  const t = setup();
  const account = await t.repo.createAccount({ username: 'tester' });
  const result = await t.check(account.id);

  assert.equal(result.account.status, 'active');
  assert.equal(result.account.risk_level, 'low');
  assert.equal(result.account.link_karma, 800);
  assert.ok(result.account.last_seen_active_at);
  assert.equal(result.alerts.length, 0);
  assert.equal(result.check.items_sampled, 8);
  assert.equal(t.repo.content.size, 8);
});

test('visible then not found is a shadowban: one critical alert, not one per check', async () => {
  const t = setup();
  const account = await t.repo.createAccount({ username: 'tester' });
  await t.check(account.id);

  t.reddit.state.about = { state: 'not_found' };
  t.advance(HOUR);
  const result = await t.check(account.id);
  assert.equal(result.account.status, 'shadowbanned');
  assert.equal(result.account.risk_score, 100);
  assert.deepEqual(result.alerts.map((a) => [a.type, a.severity]), [['shadowban_suspected', 'critical']]);
  assert.equal(t.notified.length, 1);

  t.advance(HOUR);
  const again = await t.check(account.id);
  assert.equal(again.account.status, 'shadowbanned');
  assert.equal(again.alerts.length, 0);

  // Visible again -> recovery notice.
  t.reddit.state.about = { state: 'active', profile: healthyProfile() };
  t.advance(HOUR);
  const recovered = await t.check(account.id);
  assert.equal(recovered.account.status, 'active');
  assert.deepEqual(recovered.alerts.map((a) => a.type), ['recovered']);
});

test('a username that was never visible is not_found, not shadowbanned', async () => {
  const t = setup();
  t.reddit.state.about = { state: 'not_found' };
  const account = await t.repo.createAccount({ username: 'typo_name' });
  const result = await t.check(account.id);
  assert.equal(result.account.status, 'not_found');
  assert.deepEqual(result.alerts.map((a) => a.type), ['not_found']);
});

test('removals after posting are caught, including items that left the listing', async () => {
  const t = setup();
  const account = await t.repo.createAccount({ username: 'tester' });
  await t.check(account.id);

  // c0 drops off the listing entirely and is removed; p0 and p1 get spam-filtered.
  const removedComment = { ...rawComment({ id: 'c0', createdAt: NOW - 8 * HOUR }), body: '[removed]' };
  t.reddit.state.comments = t.reddit.state.comments.filter((c) => c.name !== 't1_c0');
  t.reddit.state.info.set('t1_c0', removedComment);
  t.reddit.state.info.set('t3_p0', { ...rawPost({ id: 'p0', createdAt: NOW - DAY }), removed_by_category: 'reddit' });
  t.reddit.state.info.set('t3_p1', { ...rawPost({ id: 'p1', createdAt: NOW - 2 * DAY }), removed_by_category: 'reddit' });

  t.advance(HOUR);
  const result = await t.check(account.id);
  assert.equal(result.check.newly_removed, 3);
  assert.equal(result.check.items_removed, 3);
  assert.ok(result.alerts.some((a) => a.type === 'spam_filter_hit' && /2 new items/.test(a.message)));

  const stored = t.repo.content.get('t1_c0');
  assert.equal(stored.removal_status, 'removed');
  assert.equal(stored.excerpt, 'comment 0 with some original text', 'original text is kept');
  assert.ok(stored.removal_detected_at);

  // Nothing new on the next check: no repeat alerts, detection time unchanged.
  t.advance(HOUR);
  const next = await t.check(account.id);
  assert.equal(next.check.newly_removed, 0);
  assert.equal(next.alerts.filter((a) => a.type === 'spam_filter_hit').length, 0);
  assert.equal(t.repo.content.get('t1_c0').removal_detected_at, stored.removal_detected_at);
});

test('without /api/info (HTML mode), an item missing from inside the listing window counts as removed', async () => {
  const t = setup();
  t.reddit.getInfo = async () => [];
  const account = await t.repo.createAccount({ username: 'tester' });
  await t.check(account.id);

  // c2 disappears from between listed comments; c5, the oldest, just scrolls
  // out of the server-rendered window and says nothing about removal.
  t.reddit.state.comments = t.reddit.state.comments.filter((c) => !['t1_c2', 't1_c5'].includes(c.name));
  t.advance(HOUR);
  const result = await t.check(account.id);

  assert.equal(t.repo.content.get('t1_c2').removal_status, 'removed');
  assert.equal(t.repo.content.get('t1_c2').excerpt, 'comment 2 with some original text');
  assert.equal(t.repo.content.get('t1_c5').removal_status, 'visible');
  assert.equal(result.check.newly_removed, 1);

  // Still missing on the next check: not reported again.
  t.advance(HOUR);
  assert.equal((await t.check(account.id)).check.newly_removed, 0);
});

test('posts/comments hidden as they were posted show up as the gap to the profile Contributions count', async () => {
  const t = setup();
  // 2 posts + 6 comments are listed; the profile counts 9 contributions.
  t.reddit.state.about = { state: 'active', profile: { ...healthyProfile(), contributions: 9 } };
  const account = await t.repo.createAccount({ username: 'tester' });
  const first = await t.check(account.id);
  const factor = first.check.factors.find((f) => f.key === 'hidden_items');
  assert.deepEqual([factor.count, factor.points], [1, 10]);
  assert.match(factor.detail, /counts 9 contributions, but logged-out visitors can see only 8/);
  assert.ok(first.check.recommendations.some((r) => r.key === 'find_hidden_items'));
  assert.deepEqual(first.alerts.map((a) => a.type), ['content_hidden']);

  // Unchanged on the next check: no repeat alert.
  t.advance(HOUR);
  assert.equal((await t.check(account.id)).alerts.length, 0);

  // One more hidden item: alert again (once the first one's dedupe window passed).
  t.reddit.state.about.profile.contributions = 10;
  t.advance(25 * HOUR);
  const later = await t.check(account.id);
  assert.equal(later.check.factors.find((f) => f.key === 'hidden_items').count, 2);
  assert.deepEqual(later.alerts.map((a) => a.type), ['content_hidden']);
});

test('no hidden count when a listing may be cut off or the profile has no Contributions count', async () => {
  const t = setup();
  t.reddit.state.comments = Array.from({ length: 20 }, (_, i) =>
    rawComment({ id: `w${i}`, createdAt: NOW - (i + 1) * HOUR, body: `comment ${i}` }),
  );
  t.reddit.state.about = { state: 'active', profile: { ...healthyProfile(), contributions: 400 } };
  const account = await t.repo.createAccount({ username: 'tester' });
  const result = await t.check(account.id);
  assert.equal(result.check.factors.some((f) => f.key === 'hidden_items'), false);

  const live = await checkLiveProfile({ reddit: createFakeReddit(), username: 'tester', now: NOW });
  assert.equal(live.hidden, null);
});

test('listings the owner hid are reported as not visible, not as zero activity or hidden content', async () => {
  const t = setup();
  // Like u/x "likes to keep their posts/comments hidden": both listings null.
  t.reddit.state.posts = null;
  t.reddit.state.comments = null;
  t.reddit.state.about = { state: 'active', profile: { ...healthyProfile(), contributions: 786 } };
  const account = await t.repo.createAccount({ username: 'tester' });
  const result = await t.check(account.id);
  const keys = result.check.factors.map((f) => f.key);
  assert.ok(keys.includes('listings_hidden'));
  assert.ok(!keys.includes('hidden_items'));
  assert.match(result.check.factors.find((f) => f.key === 'listings_hidden').label, /^Posts and comments not shown/);
  assert.ok(result.check.recommendations.some((r) => r.key === 'show_profile_activity'));
  assert.equal(result.alerts.some((a) => a.type === 'content_hidden'), false);
});

test('checkLiveProfile reports hidden posts/comments too', async () => {
  const reddit = createFakeReddit();
  reddit.state.about = { state: 'active', profile: { ...healthyProfile(), contributions: 1 } };
  const report = await checkLiveProfile({ reddit, username: 'tester', now: NOW });
  assert.equal(report.hidden, 1);
  assert.equal(report.assessment.factors.find((f) => f.key === 'hidden_items').count, 1);
});

test("the first check doesn't report an account's existing removals as new", async () => {
  const t = setup();
  t.reddit.state.info.set('t3_p0', { ...rawPost({ id: 'p0', createdAt: NOW - DAY }), removed_by_category: 'reddit' });
  const account = await t.repo.createAccount({ username: 'tester' });
  const result = await t.check(account.id);
  assert.equal(result.check.newly_removed, 0);
  assert.equal(result.check.items_removed, 1);
  assert.equal(result.alerts.filter((a) => a.type === 'spam_filter_hit').length, 0);
});

test('three failed checks in a row raise a single check_failing alert', async () => {
  const t = setup();
  t.reddit.state.fail = 'Reddit request failed (HTTP 503)';
  const account = await t.repo.createAccount({ username: 'tester' });

  const first = await t.check(account.id);
  assert.equal(first.account.status, 'error');
  assert.equal(first.alerts.length, 0);
  t.advance(HOUR);
  assert.equal((await t.check(account.id)).alerts.length, 0);
  t.advance(HOUR);
  const third = await t.check(account.id);
  assert.deepEqual(third.alerts.map((a) => a.type), ['check_failing']);
  t.advance(HOUR);
  assert.equal((await t.check(account.id)).alerts.length, 0, 'deduplicated while still open');
});

test('a failed check keeps the last known status and risk', async () => {
  const t = setup();
  const account = await t.repo.createAccount({ username: 'tester' });
  await t.check(account.id);
  t.reddit.state.fail = 'network down';
  t.advance(HOUR);
  const result = await t.check(account.id);
  assert.equal(result.account.status, 'active');
  assert.equal(result.account.risk_level, 'low');
  assert.equal(result.check.status, 'error');
  assert.equal(result.check.error, 'network down');
});

test('overlapping checks of the same account are skipped', async () => {
  const t = setup();
  const account = await t.repo.createAccount({ username: 'tester' });
  const [first, second] = await Promise.all([
    t.checker.checkAccount(account),
    t.checker.checkAccount(account),
  ]);
  assert.ok(first);
  assert.equal(second, null);
});

test('a stored item whose timestamp becomes unreadable keeps its date and stays counted', async () => {
  const t = setup();
  const account = await t.repo.createAccount({ username: 'tester' });
  await t.check(account.id);
  const before = t.repo.content.get('t1_c0').created_at;

  t.advance(HOUR);
  t.reddit.state.comments[0] = { ...t.reddit.state.comments[0], created_utc: null };
  const result = await t.check(account.id);

  assert.equal(t.repo.content.get('t1_c0').created_at, before);
  assert.equal(result.check.items_sampled, 8);
  assert.ok(!result.check.factors.some((f) => f.key === 'undated_items'));
});

test('a never-seen item without a timestamp is not stored or counted, and the check says so', async () => {
  const t = setup();
  t.reddit.state.comments.push({ ...rawComment({ id: 'nodate' }), created_utc: null });
  const account = await t.repo.createAccount({ username: 'tester' });
  const result = await t.check(account.id);

  assert.equal(t.repo.content.has('t1_nodate'), false);
  assert.equal(result.check.items_sampled, 8);
  const factor = result.check.factors.find((f) => f.key === 'undated_items');
  assert.equal(factor.points, 0);
  // Informational only: the score is the same as without the undated item.
  assert.equal(result.check.risk_score, result.check.factors.reduce((sum, f) => sum + f.points, 0));
});

test('checkLiveProfile leaves undated items out of the report and counts them', async () => {
  const reddit = createFakeReddit();
  reddit.state.posts = [rawPost({ id: 'p1', createdAt: NOW - DAY })];
  reddit.state.comments = [{ ...rawComment({ id: 'c1' }), created_utc: null }];
  const report = await checkLiveProfile({ reddit, username: 'tester', now: NOW });

  assert.equal(report.undated, 1);
  assert.deepEqual(report.items.map((item) => item.id), ['t3_p1']);
  assert.equal(report.sampled, 1);
  assert.ok(report.assessment.factors.some((f) => f.key === 'undated_items' && f.points === 0));
});
