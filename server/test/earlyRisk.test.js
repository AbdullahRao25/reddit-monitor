import assert from 'node:assert/strict';
import test from 'node:test';
import { assessEarlyRisk, earlyRiskRecommendations } from '../src/stealth/earlyRisk.js';
import { HOUR, NOW, healthyProfile } from './helpers.js';

const DAY = 24 * HOUR;

const account = (overrides = {}) => ({ stealth_mode: true, username: 'tester', ...overrides });
const profile = (overrides = {}) => ({ ...healthyProfile(NOW), ...overrides });
const item = (overrides = {}) => ({
  id: 't3_x',
  kind: 'post',
  subreddit: 'test',
  createdAt: NOW - DAY,
  score: 5,
  domain: null,
  url: null,
  text: null,
  removalStatus: 'visible',
  ...overrides,
});
const comment = (text, overrides = {}) =>
  item({ id: `t1_${overrides.id ?? text.length}`, kind: 'comment', text, ...overrides });
const post = (overrides = {}) => item({ ...overrides });

// ---------------------------------------------------------------- stealth off

test('assessEarlyRisk returns null when stealth mode is off', () => {
  assert.equal(assessEarlyRisk({ account: { stealth_mode: false }, profile: profile(), items: [], now: NOW }), null);
  assert.equal(assessEarlyRisk({ account: null, profile: profile(), items: [], now: NOW }), null);
});

// ---------------------------------------------------------------- identity

test('very new account: <7 days is 25 points urgent, 7–14 days is 15 points high', () => {
  const fresh = assessEarlyRisk({ account: account(), profile: profile({ createdAt: NOW - 3 * DAY }), items: [], now: NOW });
  const signal = fresh.signals.find((s) => s.key === 'early_new_account');
  assert.ok(signal);
  assert.equal(signal.points, 25);
  assert.equal(signal.priority, 'urgent');

  const mid = assessEarlyRisk({ account: account(), profile: profile({ createdAt: NOW - 10 * DAY }), items: [], now: NOW });
  const midSignal = mid.signals.find((s) => s.key === 'early_new_account');
  assert.ok(midSignal);
  assert.equal(midSignal.points, 15);
  assert.equal(midSignal.priority, 'high');
});

test('young account: 14–30 days is 8 points normal', () => {
  const result = assessEarlyRisk({ account: account(), profile: profile({ createdAt: NOW - 20 * DAY }), items: [], now: NOW });
  const signal = result.signals.find((s) => s.key === 'early_young_account');
  assert.ok(signal);
  assert.equal(signal.points, 8);
  assert.equal(signal.priority, 'normal');
});

test('mature account carries no age signal', () => {
  const result = assessEarlyRisk({ account: account(), profile: profile({ createdAt: NOW - 400 * DAY }), items: [], now: NOW });
  assert.ok(!result.signals.some((s) => s.key === 'early_new_account' || s.key === 'early_young_account'));
});

test('negative comment karma is 15 points high', () => {
  const result = assessEarlyRisk({ account: account(), profile: profile({ commentKarma: -12 }), items: [], now: NOW });
  const signal = result.signals.find((s) => s.key === 'early_negative_karma');
  assert.ok(signal);
  assert.equal(signal.points, 15);
  assert.match(signal.detail, /-12/);
});

test('karma brackets: total < 5 is very low (10), 5–20 is low (5), 20+ nothing', () => {
  const veryLow = assessEarlyRisk({ account: account(), profile: profile({ linkKarma: 3, commentKarma: 1 }), items: [], now: NOW });
  assert.ok(veryLow.signals.find((s) => s.key === 'early_very_low_karma' && s.points === 10));

  const low = assessEarlyRisk({ account: account(), profile: profile({ linkKarma: 10, commentKarma: 8 }), items: [], now: NOW });
  assert.ok(low.signals.find((s) => s.key === 'early_low_karma' && s.points === 5));
  assert.ok(!low.signals.find((s) => s.key === 'early_very_low_karma'));

  const ok = assessEarlyRisk({ account: account(), profile: profile({ linkKarma: 10, commentKarma: 10 }), items: [], now: NOW });
  assert.ok(!ok.signals.some((s) => s.key === 'early_low_karma' || s.key === 'early_very_low_karma'));
});

test('unverified email is 5 points normal', () => {
  const result = assessEarlyRisk({ account: account(), profile: profile({ hasVerifiedEmail: false }), items: [], now: NOW });
  const signal = result.signals.find((s) => s.key === 'early_unverified_email');
  assert.ok(signal);
  assert.equal(signal.points, 5);
});

// ---------------------------------------------------------------- content

test('below the minimum sample size, content signals are skipped', () => {
  const items = [
    post({ id: 'p0', url: 'https://example.com/a', domain: 'example.com', removalStatus: 'spam_filtered' }),
    post({ id: 'p1', url: 'https://example.com/b', domain: 'example.com', removalStatus: 'spam_filtered' }),
  ];
  const result = assessEarlyRisk({ account: account(), profile: profile(), items, now: NOW });
  assert.ok(!result.signals.some((s) => s.key === 'early_sitewide_removals'));
});

test('sitewide removals: one is 15 points, two or more is 25 points urgent', () => {
  const base = [
    comment('one', { id: 'a' }),
    comment('two', { id: 'b' }),
  ];
  const one = assessEarlyRisk({
    account: account(),
    profile: profile(),
    items: [...base, post({ id: 'p0', url: 'https://x.com/1', domain: 'x.com', removalStatus: 'spam_filtered' })],
    now: NOW,
  });
  assert.ok(one.signals.find((s) => s.key === 'early_sitewide_removals' && s.points === 15));

  const two = assessEarlyRisk({
    account: account(),
    profile: profile(),
    items: [
      ...base,
      post({ id: 'p0', url: 'https://x.com/1', domain: 'x.com', removalStatus: 'spam_filtered' }),
      post({ id: 'p1', url: 'https://x.com/2', domain: 'x.com', removalStatus: 'removed_by_admin' }),
    ],
    now: NOW,
  });
  const signal = two.signals.find((s) => s.key === 'early_sitewide_removals');
  assert.equal(signal.points, 25);
  assert.equal(signal.priority, 'urgent');
});

test('domain concentration: 50–70% is 12 points, 70%+ is 20 points', () => {
  // 5 link posts to example.com + 3 unrelated comments = 45% -> nothing.
  const unrelated = [
    post({ id: 'c0', kind: 'comment', url: null, domain: null, text: 'a plain comment, nothing linked' }),
    post({ id: 'c1', kind: 'comment', url: null, domain: null, text: 'another plain comment here' }),
    post({ id: 'c2', kind: 'comment', url: null, domain: null, text: 'and one more plain comment' }),
  ];
  const links = [1, 2, 3, 4, 5].map((n) =>
    post({ id: `p${n}`, url: `https://example.com/page${n}`, domain: 'example.com' }),
  );
  const mild = assessEarlyRisk({ account: account(), profile: profile(), items: [...links, ...unrelated], now: NOW });
  const mildSignal = mild.signals.find((s) => s.key === 'early_domain_concentration');
  assert.ok(mildSignal, '50% share should trigger');
  assert.equal(mildSignal.points, 12);

  // All 5 posts on example.com + 3 comments mentioning the domain = 83% -> 20.
  const mentions = unrelated.map((c, i) => comment(`check out example.com here ${i + 1}`, { id: `m${i}` }));
  const heavy = assessEarlyRisk({ account: account(), profile: profile(), items: [...links, ...mentions], now: NOW });
  const heavySignal = heavy.signals.find((s) => s.key === 'early_domain_concentration');
  assert.equal(heavySignal.points, 20);
  assert.match(heavySignal.detail, /example\.com/);
});

test('domain concentration needs at least three posts on the top domain', () => {
  const twoPosts = [1, 2].map((n) => post({ id: `p${n}`, url: `https://example.com/${n}`, domain: 'example.com' }));
  const items = [
    ...twoPosts,
    comment('plain comment one', { id: 'a' }),
    comment('plain comment two', { id: 'b' }),
  ];
  const result = assessEarlyRisk({ account: account(), profile: profile(), items, now: NOW });
  assert.ok(!result.signals.find((s) => s.key === 'early_domain_concentration'));
});

test('crossposted link: 3 subs is 12 points, 5+ subs is 20 points', () => {
  const toSubs = (count, url = 'https://example.com/launch') =>
    Array.from({ length: count }, (_, i) =>
      post({ id: `cp${i}`, subreddit: `sub${i}`, url, domain: 'example.com', createdAt: NOW - DAY }),
    );
  const extra = [comment('a filler comment', { id: 'x' }), comment('another filler', { id: 'y' })];

  const three = assessEarlyRisk({ account: account(), profile: profile(), items: [...toSubs(3), ...extra], now: NOW });
  assert.ok(three.signals.find((s) => s.key === 'early_crosspost_link' && s.points === 12));

  const five = assessEarlyRisk({ account: account(), profile: profile(), items: [...toSubs(5), ...extra], now: NOW });
  assert.ok(five.signals.find((s) => s.key === 'early_crosspost_link' && s.points === 20));
});

test('the same link in one subreddit is not a crosspost signal', () => {
  const items = [
    post({ id: 'a', subreddit: 'only', url: 'https://example.com/launch' }),
    post({ id: 'b', subreddit: 'only', url: 'https://example.com/launch', createdAt: NOW - 2 * DAY }),
    comment('filler one', { id: 'x' }),
    comment('filler two', { id: 'y' }),
  ];
  const result = assessEarlyRisk({ account: account(), profile: profile(), items, now: NOW });
  assert.ok(!result.signals.find((s) => s.key === 'early_crosspost_link'));
});

test('duplicate comments: 3 copies is 10 points, 5+ is 15 points', () => {
  const text = 'Same copy pasted comment with enough words to count for sure';
  const three = assessEarlyRisk({
    account: account(),
    profile: profile(),
    items: [comment(text, { id: 'a' }), comment(text, { id: 'b' }), comment(text, { id: 'c' }), comment('different text entirely here', { id: 'd' })],
    now: NOW,
  });
  assert.ok(three.signals.find((s) => s.key === 'early_duplicate_comments' && s.points === 10));

  const five = assessEarlyRisk({
    account: account(),
    profile: profile(),
    items: Array.from({ length: 5 }, (_, i) => comment(text, { id: `d${i}` })),
    now: NOW,
  });
  assert.ok(five.signals.find((s) => s.key === 'early_duplicate_comments' && s.points === 15));
});

test('activity burst: 6+ items in an hour is 8 points, 12+ is 12 points', () => {
  const items = (count, spreadHour) =>
    Array.from({ length: count }, (_, i) => comment(`burst ${i} text here`, { id: `b${i}`, createdAt: NOW - i * spreadHour }));

  const six = assessEarlyRisk({ account: account(), profile: profile(), items: items(6, 10 * 60 * 1000), now: NOW });
  assert.ok(six.signals.find((s) => s.key === 'early_activity_burst' && s.points === 8));

  const twelve = assessEarlyRisk({ account: account(), profile: profile(), items: items(12, 5 * 60 * 1000), now: NOW });
  assert.ok(twelve.signals.find((s) => s.key === 'early_activity_burst' && s.points === 12));

  const spread = assessEarlyRisk({ account: account(), profile: profile(), items: items(6, 3 * HOUR), now: NOW });
  assert.ok(!spread.signals.find((s) => s.key === 'early_activity_burst'));
});

// ---------------------------------------------------------------- temporal

test('night posting: 40–60% share is 10 points, 60%+ is 15 points', () => {
  // Absolute UTC hours, pinned to a known day so the UTC zone is unambiguous.
  const at = (hourUtc) => Date.parse('2026-10-18T00:00:00Z') + hourUtc * HOUR;
  const night = [2, 3, 4]; // hours 0-5 local (UTC)
  const day = [10, 11, 12, 13];

  const build = (nightCount, dayCount) =>
    assessEarlyRisk({
      account: account({ fingerprint: { timezone: 'UTC' } }),
      profile: profile(),
      items: [
        ...night.slice(0, nightCount).map((h, i) => comment(`night ${i} text`, { id: `n${i}`, createdAt: at(h) })),
        ...day.slice(0, dayCount).map((h, i) => comment(`day ${i} text`, { id: `d${i}`, createdAt: at(h) })),
      ],
      now: NOW,
    });

  // 2 of 5 = 40% -> 10 points.
  assert.ok(build(2, 3).signals.find((s) => s.key === 'early_night_posting' && s.points === 10));
  // 3 of 5 = 60% -> 15 points.
  assert.ok(build(3, 2).signals.find((s) => s.key === 'early_night_posting' && s.points === 15));
  // 1 of 5 = 20% -> below the 40% threshold, nothing fires.
  assert.ok(!build(1, 4).signals.find((s) => s.key === 'early_night_posting'));
});

test('night posting falls back to timezone_hint when the fingerprint has none', () => {
  const at = (hourUtc) => Date.parse('2026-10-18T00:00:00Z') + hourUtc * HOUR;
  const result = assessEarlyRisk({
    account: account({ timezone_hint: 'UTC' }),
    profile: profile(),
    items: [
      comment('night a text', { id: 'n1', createdAt: at(1) }),
      comment('night b text', { id: 'n2', createdAt: at(2) }),
      comment('day a text', { id: 'd1', createdAt: at(11) }),
    ],
    now: NOW,
  });
  assert.ok(result.signals.find((s) => s.key === 'early_night_posting' && s.points === 15));
});

test('night posting needs a known timezone', () => {
  const atHour = (hourUtc) => NOW - DAY + hourUtc * HOUR;
  const items = [
    comment('night a text', { id: 'n1', createdAt: atHour(1) }),
    comment('night b text', { id: 'n2', createdAt: atHour(2) }),
    comment('day a text', { id: 'd1', createdAt: atHour(10) }),
  ];
  const result = assessEarlyRisk({ account: account(), profile: profile(), items, now: NOW });
  assert.ok(!result.signals.find((s) => s.key === 'early_night_posting'));
});

test('no cooldown: a fresh sitewide removal plus 3+ items since is 20 points urgent', () => {
  const items = [
    post({ id: 'p0', url: 'https://x.com/1', domain: 'x.com', removalStatus: 'spam_filtered', createdAt: NOW - 2 * DAY }),
    post({ id: 'p1', url: 'https://x.com/2', domain: 'x.com', createdAt: NOW - DAY }),
    comment('one', { id: 'a', createdAt: NOW - 20 * HOUR }),
    comment('two', { id: 'b', createdAt: NOW - 10 * HOUR }),
  ];
  const result = assessEarlyRisk({ account: account(), profile: profile(), items, now: NOW });
  const signal = result.signals.find((s) => s.key === 'early_no_cooldown');
  assert.ok(signal);
  assert.equal(signal.points, 20);
  assert.equal(signal.priority, 'urgent');
});

test('no cooldown: a mod removal does not start the clock, only sitewide ones do', () => {
  const items = [
    post({ id: 'p0', url: 'https://x.com/1', domain: 'x.com', removalStatus: 'removed_by_mod', createdAt: NOW - 2 * DAY }),
    post({ id: 'p1', url: 'https://x.com/2', domain: 'x.com', createdAt: NOW - DAY }),
    comment('one', { id: 'a', createdAt: NOW - 20 * HOUR }),
    comment('two', { id: 'b', createdAt: NOW - 10 * HOUR }),
  ];
  const result = assessEarlyRisk({ account: account(), profile: profile(), items, now: NOW });
  assert.ok(!result.signals.find((s) => s.key === 'early_no_cooldown'));
});

test('no cooldown: fewer than three items after the removal is quiet', () => {
  const items = [
    post({ id: 'p0', url: 'https://x.com/1', domain: 'x.com', removalStatus: 'spam_filtered', createdAt: NOW - 2 * DAY }),
    post({ id: 'p1', url: 'https://x.com/2', domain: 'x.com', createdAt: NOW - DAY }),
    comment('one', { id: 'a', createdAt: NOW - 10 * HOUR }),
  ];
  const result = assessEarlyRisk({ account: account(), profile: profile(), items, now: NOW });
  assert.ok(!result.signals.find((s) => s.key === 'early_no_cooldown'));
});

// ---------------------------------------------------------------- score / level

test('level thresholds: 0–24 low, 25–49 elevated, 50–74 high, 75+ critical', () => {
  // 8 points for age 20 days + 15 negative karma + 5 unverified = 28 -> elevated.
  const elevated = assessEarlyRisk({
    account: account(),
    profile: profile({ createdAt: NOW - 20 * DAY, linkKarma: 10, commentKarma: -2, hasVerifiedEmail: false }),
    items: [],
    now: NOW,
  });
  assert.equal(elevated.level, 'elevated');
  assert.equal(elevated.score, 28);

  // 25 (new <7d) + 15 (negative karma) + 12 (burst 12+/hour) = 52 -> high.
  const high = assessEarlyRisk({
    account: account(),
    profile: profile({ createdAt: NOW - 3 * DAY, commentKarma: -5 }),
    items: Array.from({ length: 12 }, (_, i) => comment(`burst ${i} text`, { id: `h${i}`, createdAt: NOW - i * 5 * 60 * 1000 })),
    now: NOW,
  });
  assert.equal(high.level, 'high');
  assert.equal(high.score, 52);

  // 25 (new <7d) + 25 (2x sitewide) + 12 (burst 12+/hour) = 62 -> high.
  const justUnder = assessEarlyRisk({
    account: account(),
    profile: profile({ createdAt: NOW - 3 * DAY }),
    items: [
      post({ id: 'p0', url: 'https://x.com/1', domain: 'x.com', removalStatus: 'spam_filtered', createdAt: NOW - 2 * DAY }),
      post({ id: 'p1', url: 'https://x.com/2', domain: 'x.com', removalStatus: 'removed_by_admin', createdAt: NOW - 2 * DAY }),
      post({ id: 'p2', url: 'https://x.com/3', domain: 'x.com', createdAt: NOW - 2 * DAY }),
      comment('one', { id: 'a', createdAt: NOW - 2 * DAY }),
      comment('two', { id: 'b', createdAt: NOW - 2 * DAY }),
    ],
    now: NOW,
  });
  assert.equal(justUnder.score, 62);
  assert.equal(justUnder.level, 'high');

  // These inputs yield 82 points (including the low-karma contribution) -> critical.
  const critical = assessEarlyRisk({
    account: account({ fingerprint: { timezone: 'UTC' } }),
    profile: profile({ createdAt: NOW - 3 * DAY }),
    items: [
      post({ id: 'p0', url: 'https://x.com/1', domain: 'x.com', removalStatus: 'spam_filtered', createdAt: NOW - 2 * DAY + 1 * HOUR }),
      post({ id: 'p1', url: 'https://x.com/2', domain: 'x.com', removalStatus: 'removed_by_admin', createdAt: NOW - 2 * DAY + 2 * HOUR }),
      post({ id: 'p2', url: 'https://x.com/3', domain: 'x.com', createdAt: NOW - 2 * DAY + 3 * HOUR }),
      comment('night c text', { id: 'n', createdAt: NOW - 2 * DAY + 4 * HOUR }),
      comment('one', { id: 'a', createdAt: NOW - 2 * DAY + 5 * HOUR }),
      comment('two', { id: 'b', createdAt: NOW - 2 * DAY + 5 * HOUR }),
    ],
    now: NOW,
  });
  assert.equal(critical.score, 82);
  assert.equal(critical.level, 'critical');
});

test('the score never exceeds 100', () => {
  const result = assessEarlyRisk({
    account: account({ fingerprint: { timezone: 'UTC' } }),
    profile: profile({ createdAt: NOW - 3 * DAY, commentKarma: -5, linkKarma: 0, hasVerifiedEmail: false }),
    items: [
      post({ id: 'p0', url: 'https://x.com/1', domain: 'x.com', removalStatus: 'spam_filtered', createdAt: NOW - 2 * DAY + 1 * HOUR }),
      post({ id: 'p1', url: 'https://x.com/2', domain: 'x.com', removalStatus: 'removed_by_admin', createdAt: NOW - 2 * DAY + 2 * HOUR }),
      post({ id: 'p2', url: 'https://x.com/3', domain: 'x.com', createdAt: NOW - DAY + 1 * HOUR }),
      comment('one', { id: 'a', createdAt: NOW - 20 * HOUR }),
      comment('two', { id: 'b', createdAt: NOW - 10 * HOUR }),
      comment('night c text', { id: 'n', createdAt: NOW - DAY + 2 * HOUR }),
    ],
    now: NOW,
  });
  assert.ok(result.score <= 100);
});

test('signals are sorted by points descending and top is the strongest', () => {
  const result = assessEarlyRisk({
    account: account(),
    profile: profile({ createdAt: NOW - 3 * DAY, commentKarma: -5, hasVerifiedEmail: false }),
    items: [],
    now: NOW,
  });
  const points = result.signals.map((s) => s.points);
  assert.deepEqual(points, [...points].sort((a, b) => b - a));
  assert.equal(result.top.key, 'early_new_account');
  assert.equal(result.top.points, Math.max(...points));
});

// ---------------------------------------------------------------- recommendations

test('earlyRiskRecommendations maps signals to recs without a double prefix', () => {
  const early = assessEarlyRisk({
    account: account(),
    profile: profile({ createdAt: NOW - 3 * DAY }),
    items: [],
    now: NOW,
  });
  const recs = earlyRiskRecommendations(early);
  assert.equal(recs.length, early.signals.length);
  for (const rec of recs) {
    assert.match(rec.key, /^early_/);
    assert.ok(!rec.key.startsWith('early_early_'));
    assert.ok(rec.title.length > 0);
    assert.ok(rec.body.length > 0);
  }
});

test('earlyRiskRecommendations is empty for null or signal-less results', () => {
  assert.deepEqual(earlyRiskRecommendations(null), []);
  assert.deepEqual(earlyRiskRecommendations({ signals: [] }), []);
});
