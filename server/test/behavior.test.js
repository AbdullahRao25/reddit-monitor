import assert from 'node:assert/strict';
import test from 'node:test';
import { behaviorFactors, localHourIn, midnightShare } from '../src/behavior.js';
import { assessRisk } from '../src/risk.js';
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

// Timestamp that is `localHour` on the wall clock of `timeZone`, `daysAgo`
// days before `now` (2026-10-19T12:00Z). October dates fall in EDT (UTC-4)
// and JST (UTC+9), so the offsets below are unambiguous for this fixture.
const localAt = (daysAgo, localHour, timeZone) => {
  const utcHour =
    timeZone === 'America/New_York'
      ? (localHour + 4 + 24) % 24
      : timeZone === 'Asia/Tokyo'
        ? (localHour - 9 + 24) % 24
        : localHour;
  return NOW - daysAgo * DAY + (utcHour - 12) * HOUR;
};

const active = (items, account = null, { newlyRemoved = 0 } = {}) =>
  assessRisk({ username: 'tester', status: 'active', profile: healthyProfile(), items, now: NOW, account, newlyRemoved });

const factor = (result, key) => result.factors.find((f) => f.key === key);
const rec = (result, key) => result.recommendations.find((r) => r.key === key);

test('localHourIn reads the wall-clock hour in an IANA zone', () => {
  const ts = Date.UTC(2026, 9, 18, 12, 0, 0); // noon UTC
  assert.equal(localHourIn(ts, 'UTC'), 12);
  assert.equal(localHourIn(ts, 'America/New_York'), 8); // EDT, UTC-4
  assert.equal(localHourIn(ts, 'Asia/Tokyo'), 21); // UTC+9
  assert.equal(localHourIn(ts, 'Not/AZone'), null);
});

test('midnightShare counts 0..5 am as night and needs a timezone', () => {
  assert.equal(midnightShare([], 'UTC'), null);
  assert.equal(midnightShare([Date.UTC(2026, 9, 18, 3)], null), null);
  const hours = [1, 4, 7, 22].map((h) => Date.UTC(2026, 9, 18, h));
  assert.equal(midnightShare(hours, 'UTC'), 0.5);
});

test('an all-night poster in its own timezone is flagged', () => {
  const items = Array.from({ length: 10 }, (_, i) =>
    item({ createdAt: localAt(1 + Math.floor(i / 5), 2, 'America/New_York') }),
  );
  const result = active(items, { fingerprint: { timezone: 'America/New_York' } });
  assert.equal(factor(result, 'night_posting').points, 10);
  assert.match(factor(result, 'night_posting').detail, /10 of 10/);
  assert.equal(rec(result, 'fix_posting_hours').priority, 'normal');
});

test('a daytime poster in the claimed timezone is not flagged', () => {
  const items = Array.from({ length: 10 }, (_, i) =>
    item({ createdAt: localAt(1 + Math.floor(i / 5), 10, 'America/New_York') }),
  );
  const result = active(items, { fingerprint: { timezone: 'America/New_York' } });
  assert.equal(factor(result, 'night_posting'), undefined);
});

test('posting at night in UTC but awake hours in the claimed zone is not flagged', () => {
  // 22:00 UTC is 18:00 in New York: evening locally, night by UTC.
  const items = Array.from({ length: 10 }, (_, i) =>
    item({ createdAt: localAt(1 + Math.floor(i / 5), 18, 'America/New_York') }),
  );
  const result = active(items, { fingerprint: { timezone: 'America/New_York' } });
  assert.equal(factor(result, 'night_posting'), undefined);
});

test('a small sample is not flagged, and the timezone_hint fallback is used', () => {
  const few = Array.from({ length: 3 }, (_, i) => item({ createdAt: localAt(1, 3 + i, 'UTC') }));
  assert.equal(factor(active(few, { timezone_hint: 'UTC' }), 'night_posting'), undefined);

  const many = Array.from({ length: 6 }, (_, i) => item({ createdAt: localAt(1, 3 + i, 'UTC') }));
  assert.ok(factor(active(many, { timezone_hint: 'UTC' }), 'night_posting'));
});

test('no timezone information means no night-posting factor', () => {
  const items = Array.from({ length: 10 }, (_, i) => item({ createdAt: localAt(1, 3, 'UTC') }));
  for (const account of [null, {}, { fingerprint: null }, { fingerprint: { timezone: 'Mars/Phobos' } }]) {
    assert.equal(factor(active(items, account), 'night_posting'), undefined);
  }
});

test('keeping the same cadence after a removal suggests a pause', () => {
  const items = [
    ...Array.from({ length: 4 }, (_, i) =>
      item({ createdAt: NOW - (5 + i) * 6 * HOUR, removalStatus: 'spam_filtered' }),
    ),
    ...Array.from({ length: 4 }, (_, i) =>
      item({ createdAt: NOW - (i + 1) * 6 * HOUR, text: `a fresh comment, variant ${i} here` }),
    ),
  ];
  const result = active(items);
  const cooldown = rec(result, 'post_removal_cooldown');
  assert.equal(cooldown.priority, 'high');
  assert.match(cooldown.body, /4 more since/);
  // The cooldown is advice, not a scored factor.
  assert.equal(factor(result, 'post_removal_cooldown'), undefined);
});

test('a removal older than 3 days does not trigger the cooldown', () => {
  const items = [
    ...Array.from({ length: 4 }, (_, i) =>
      item({ createdAt: NOW - (10 + i) * 6 * DAY, removalStatus: 'spam_filtered' }),
    ),
    ...Array.from({ length: 4 }, (_, i) => item({ createdAt: NOW - (i + 1) * 6 * HOUR })),
  ];
  assert.equal(rec(active(items), 'post_removal_cooldown'), undefined);
});

test('posting a little after a removal does not trigger the cooldown', () => {
  const items = [
    ...Array.from({ length: 2 }, (_, i) =>
      item({ createdAt: NOW - (5 + i) * 12 * HOUR, removalStatus: 'spam_filtered' }),
    ),
    ...Array.from({ length: 2 }, (_, i) => item({ createdAt: NOW - (i + 1) * 12 * HOUR })),
  ];
  assert.equal(rec(active(items), 'post_removal_cooldown'), undefined);
});

test('subreddit removals are not a cooldown trigger', () => {
  const items = [
    ...Array.from({ length: 3 }, (_, i) =>
      item({ createdAt: NOW - (5 + i) * 6 * HOUR, removalStatus: 'removed_by_mod' }),
    ),
    ...Array.from({ length: 3 }, (_, i) => item({ createdAt: NOW - (i + 1) * 6 * HOUR })),
  ];
  assert.equal(rec(active(items), 'post_removal_cooldown'), undefined);
});

test('the cooldown and night factors stack in the score', () => {
  // Distinct text everywhere: identical comment bodies are their own risk
  // factor and would cloud what this test is checking. The night items also
  // carry a removal so only the night-posting and cooldown layers interact.
  const night = Array.from({ length: 6 }, (_, i) =>
    item({
      createdAt: localAt(1, 2 + i, 'UTC'),
      removalStatus: 'spam_filtered',
      text: `late night comment, variation ${i}`,
    }),
  );
  const after = Array.from({ length: 3 }, (_, i) =>
    item({ createdAt: NOW - (i + 1) * 6 * HOUR, text: `a fresh comment, variant ${i} here` }),
  );
  const result = active([...night, ...after], { timezone_hint: 'UTC' });
  const nightFactor = factor(result, 'night_posting');
  assert.equal(nightFactor.points, 10);
  const keys = result.factors.map((f) => f.key);
  assert.ok(!keys.includes('post_removal_cooldown'), 'cooldown stays a recommendation');
  const cooldown = rec(result, 'post_removal_cooldown');
  assert.ok(cooldown);
  // Cooldown rec (high) outranks the normal-priority night advice.
  assert.equal(rec(result, 'fix_posting_hours').priority, 'normal');
  const order = result.recommendations.map((r) => r.key);
  assert.ok(order.indexOf('post_removal_cooldown') < order.indexOf('fix_posting_hours'));
});
