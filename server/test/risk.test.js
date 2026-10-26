import assert from 'node:assert/strict';
import test from 'node:test';
import { assessRisk, maxInWindow, normalizeUrl, riskLevel } from '../src/risk.js';
import { DAY, HOUR, NOW, healthyProfile } from './helpers.js';

const item = (overrides = {}) => ({
  kind: 'comment',
  subreddit: 'test',
  createdAt: NOW - DAY,
  score: 3,
  domain: null,
  url: null,
  text: 'an ordinary comment about the topic at hand',
  removalStatus: 'visible',
  ...overrides,
});

// n distinct, well-spaced comments: a baseline that triggers nothing.
const ordinaryComments = (n, offset = 0) =>
  Array.from({ length: n }, (_, i) =>
    item({ createdAt: NOW - (i + offset) * 6 * HOUR, text: `distinct comment number ${i + offset} on the topic` }),
  );

const active = (items, profile = healthyProfile()) =>
  assessRisk({ username: 'tester', status: 'active', profile, items, now: NOW });

const factor = (result, key) => result.factors.find((f) => f.key === key);

test('risk level boundaries', () => {
  assert.equal(riskLevel(0), 'low');
  assert.equal(riskLevel(24), 'low');
  assert.equal(riskLevel(25), 'elevated');
  assert.equal(riskLevel(49), 'elevated');
  assert.equal(riskLevel(50), 'high');
  assert.equal(riskLevel(74), 'high');
  assert.equal(riskLevel(75), 'critical');
  assert.equal(riskLevel(100), 'critical');
});

test('a healthy, established account scores zero with nothing to do', () => {
  const result = active(ordinaryComments(20));
  assert.equal(result.score, 0);
  assert.equal(result.level, 'low');
  assert.deepEqual(result.recommendations, []);
});

test('shadowbanned accounts are critical and point to confirm + appeal, not evasion', () => {
  const result = assessRisk({
    username: 'tester',
    status: 'shadowbanned',
    lastSeenActiveAt: new Date(NOW - DAY).toISOString(),
    now: NOW,
  });
  assert.equal(result.score, 100);
  assert.equal(result.level, 'critical');
  assert.equal(result.recommendations[0].priority, 'urgent');
  const keys = result.recommendations.map((r) => r.key);
  assert.ok(keys.includes('confirm_shadowban'));
  assert.ok(keys.includes('appeal'));
  assert.ok(keys.includes('no_ban_evasion'));
  assert.match(factor(result, 'shadowban').detail, /2026-10-18/);
});

test('suspended and not-found accounts', () => {
  const suspended = assessRisk({ username: 'tester', status: 'suspended', now: NOW });
  assert.equal(suspended.level, 'critical');
  const notFound = assessRisk({ username: 'tester', status: 'not_found', now: NOW });
  assert.equal(notFound.score, 80);
  assert.ok(notFound.recommendations.some((r) => r.key === 'check_username'));
});

test('spam-filter removals are weighted heavily', () => {
  const items = [
    ...ordinaryComments(7),
    ...[0, 1, 2].map((i) =>
      item({
        createdAt: NOW - (10 + i) * HOUR,
        removalStatus: 'spam_filtered',
        subreddit: 'askreddit',
        text: `filtered comment ${i} with its own wording`,
      }),
    ),
  ];
  const result = active(items);
  assert.equal(factor(result, 'sitewide_removals').points, 30);
  assert.equal(factor(result, 'removal_rate').points, 20); // 3 of 10
  assert.equal(result.score, 50);
  assert.equal(result.level, 'high');
  assert.equal(result.recommendations[0].key, 'review_filtered');
  assert.equal(result.recommendations[0].priority, 'urgent');
  assert.match(result.recommendations.find((r) => r.key === 'subreddit_rules').body, /r\/askreddit \(3\)/);
});

test('author-deleted items do not count as removals', () => {
  const items = [
    ...ordinaryComments(6),
    ...[0, 1, 2, 3].map((i) => item({ createdAt: NOW - (40 + i) * HOUR, removalStatus: 'deleted_by_author', text: '[deleted]' })),
  ];
  assert.equal(active(items).score, 0);
});

test('an account dominated by one website is flagged', () => {
  const posts = Array.from({ length: 6 }, (_, i) =>
    item({
      kind: 'post',
      createdAt: NOW - (i + 1) * DAY,
      domain: 'example.com',
      url: `https://example.com/article-${i}`,
      subreddit: `sub${i}`,
      text: '',
    }),
  );
  const result = active([...posts, ...ordinaryComments(4)]);
  const promo = factor(result, 'self_promotion');
  assert.equal(promo.points, 25); // 6 of 10 items
  assert.match(promo.label, /example\.com/);
  assert.ok(result.recommendations.some((r) => r.key === 'self_promotion'));
});

test('the same link in many subreddits is flagged, ignoring tracking params', () => {
  const posts = Array.from({ length: 5 }, (_, i) =>
    item({
      kind: 'post',
      createdAt: NOW - (i + 1) * 5 * HOUR,
      domain: 'example.com',
      url: `https://www.example.com/launch/?utm_source=reddit&utm_campaign=${i}`,
      subreddit: `sub${i}`,
      text: '',
    }),
  );
  const result = active([...posts, ...ordinaryComments(15)]);
  const crossposted = factor(result, 'crossposted_link');
  assert.equal(crossposted.points, 25);
  assert.match(crossposted.detail, /example\.com\/launch was posted to 5 subreddits/);
});

test('copy-pasted comments are flagged regardless of case and punctuation', () => {
  const copies = ['Check out my profile for more!', 'check out my profile for more', 'CHECK OUT MY PROFILE FOR MORE!!', 'Check out my profile, for more.', 'check out my profile for more'].map(
    (text, i) => item({ createdAt: NOW - (i + 1) * 7 * HOUR, text }),
  );
  const result = active([...copies, ...ordinaryComments(10, 20)]);
  assert.equal(factor(result, 'duplicate_comments').points, 20);
});

test('bursts of activity are flagged', () => {
  const burst = Array.from({ length: 22 }, (_, i) =>
    item({ createdAt: NOW - 2 * HOUR + i * 2 * 60 * 1000, text: `burst comment number ${i} here` }),
  );
  const result = active(burst);
  assert.equal(factor(result, 'activity_burst').points, 15);
});

test('new, low-karma accounts get the posting-requirements advice', () => {
  const profile = { ...healthyProfile(), createdAt: NOW - 3 * DAY, linkKarma: 1, commentKarma: 1 };
  const result = active(ordinaryComments(6), profile);
  assert.equal(factor(result, 'new_account').points, 15);
  assert.equal(factor(result, 'low_karma').points, 8);
  assert.ok(result.recommendations.some((r) => r.key === 'posting_requirements'));
});

test('negative comment karma outranks low karma', () => {
  const profile = { ...healthyProfile(), linkKarma: 3, commentKarma: -12 };
  const result = active(ordinaryComments(6), profile);
  assert.equal(factor(result, 'negative_karma').points, 15);
  assert.equal(factor(result, 'low_karma'), undefined);
});

test('karma dropping between checks', () => {
  const result = assessRisk({
    username: 'tester',
    status: 'active',
    profile: healthyProfile(),
    items: ordinaryComments(10),
    previous: { link_karma: 800, comment_karma: 2440 },
    now: NOW,
  });
  assert.equal(factor(result, 'karma_drop').points, 5);
});

test('unknown karma (the HTML client could not read it) is not scored as zero', () => {
  const profile = { ...healthyProfile(), linkKarma: null, commentKarma: null };
  const result = assessRisk({
    username: 'tester',
    status: 'active',
    profile,
    items: ordinaryComments(10),
    previous: { link_karma: 800, comment_karma: 2400 },
    now: NOW,
  });
  assert.equal(factor(result, 'low_karma'), undefined);
  assert.equal(factor(result, 'karma_drop'), undefined);
  assert.equal(result.score, 0);
});

test('posts/comments hidden from the public score by how many there are', () => {
  const hidden = (n) =>
    assessRisk({
      username: 'tester',
      status: 'active',
      profile: { ...healthyProfile(), contributions: n },
      items: [],
      hiddenItems: n,
      now: NOW,
    });
  assert.deepEqual([1, 2, 3].map((n) => factor(hidden(n), 'hidden_items').points), [10, 15, 25]);
  assert.equal(hidden(1).recommendations[0].key, 'find_hidden_items');
  assert.equal(factor(active(ordinaryComments(6)), 'hidden_items'), undefined);
});

test('a tiny sample explains itself without adding points', () => {
  const result = active(ordinaryComments(2));
  assert.equal(factor(result, 'small_sample').points, 0);
  assert.equal(result.score, 0);
});

test('the score is capped at 100', () => {
  const profile = { ...healthyProfile(), createdAt: NOW - DAY, linkKarma: 0, commentKarma: -5, hasVerifiedEmail: false };
  const items = Array.from({ length: 12 }, (_, i) =>
    item({
      kind: 'post',
      createdAt: NOW - HOUR + i * 60 * 1000,
      domain: 'spam.example',
      url: 'https://spam.example/buy',
      subreddit: `sub${i}`,
      removalStatus: 'spam_filtered',
    }),
  );
  const result = active(items, profile);
  assert.equal(result.score, 100);
  assert.equal(result.level, 'critical');
});

test('maxInWindow counts the densest window', () => {
  assert.equal(maxInWindow([], HOUR), 0);
  assert.equal(maxInWindow([0, 10, 20, HOUR * 5], HOUR), 3);
  assert.equal(maxInWindow([HOUR * 3, 0, HOUR, HOUR * 2], HOUR), 2);
});

test('normalizeUrl drops www, trailing slash and tracking params', () => {
  assert.equal(normalizeUrl('https://www.Example.com/a/?utm_source=x&id=7&ref=y'), 'example.com/a?id=7');
  assert.equal(normalizeUrl('not a url'), 'not a url');
});
