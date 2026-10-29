import assert from 'node:assert/strict';
import test from 'node:test';
import { gateDecision } from '../src/stealth/gate.js';
import { withServer } from './harness.js';
import { DAY, HOUR, createMemoryRepo } from './helpers.js';

// The gate's pure core takes `now` as an argument, so the decision tests below
// pick their own clock and are not affected by when the suite runs.
//
// The routes, by design, decide against the real clock: a gate that could be
// told what time it is would be a gate that could be talked past. Their
// fixtures are therefore dated relative to Date.now(), and the memory repo's
// clock is moved to place a row *at* a chosen moment in the past rather than to
// pretend "now" is elsewhere.

const MIN_GAP = 20 * 60 * 1000;
const MAX_GAP = 75 * 60 * 1000;

// A fixed-offset IANA zone in which `at` falls on the given local hour. Real
// zones drift with DST and with the time of day the suite runs; these do not,
// which is what makes the posting-window tests deterministic.
function zoneWhereLocalHourIs(hour, at = Date.now()) {
  let offset = (hour - new Date(at).getUTCHours() + 24) % 24;
  if (offset > 14) offset -= 24;
  if (offset === 0) return 'Etc/GMT';
  // Etc/GMT+N is UTC−N: the sign is inverted, by POSIX convention.
  return offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

const fingerprint = (extra = {}) => ({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Chrome/120.0.0.0 Safari/537.36',
  timezone: 'America/New_York',
  viewport: '1440x900',
  locale: 'en-GB',
  ...extra,
});

const goodCheck = (over = {}) => ({ error: null, risk_level: 'low', risk_score: 10, newly_removed: 0, checked_at: new Date().toISOString(), ...over });

// ------------------------------------------------------------- pure decisions

test('a critical intervention blocks, and a block carries no token', () => {
  const now = Date.parse('2026-06-15T15:00:00Z');
  const decision = gateDecision({
    account: { status: 'active', fingerprint: fingerprint({ timezone: 'Etc/GMT' }) },
    check: goodCheck({ risk_level: 'critical', risk_score: 88, checked_at: new Date(now).toISOString() }),
    now,
  });
  assert.equal(decision.verdict, 'block');
  assert.equal(decision.token, null, 'a block is not releasable, so there is nothing to hold a token for');
  assert.equal(decision.next_safe_at, null);
  assert.match(decision.reasons.join(' '), /critical/i);
});

test('a restricted account blocks even when every other stage is clear', () => {
  const now = Date.parse('2026-06-15T15:00:00Z');
  for (const status of ['shadowbanned', 'suspended']) {
    const decision = gateDecision({
      account: { status, fingerprint: fingerprint({ timezone: 'Etc/GMT' }) },
      check: goodCheck({ checked_at: new Date(now).toISOString() }),
      now,
    });
    assert.equal(decision.verdict, 'block', status);
  }
});

test('a review-severity intervention is a soft hold about an hour out, not a block', () => {
  const now = Date.parse('2026-06-15T15:00:00Z');
  const decision = gateDecision({
    account: { status: 'active', fingerprint: fingerprint({ timezone: 'Etc/GMT' }) },
    check: null,
    intervention: { code: 'check_failing', reason: 'Three consecutive monitoring failures.', severity: 'review' },
    now,
  });
  assert.equal(decision.verdict, 'hold');
  assert.equal(decision.next_safe_at, now + HOUR);
  assert.ok(decision.token, 'a hold is releasable, so it carries a token');
  assert.match(decision.reasons.join(' '), /Soft hold/);
});

test('a removal inside the last three days holds until the cool-down ends', () => {
  const now = Date.parse('2026-06-15T15:00:00Z');
  const checkedAt = now - DAY;
  const decision = gateDecision({
    account: { status: 'active', fingerprint: fingerprint({ timezone: zoneWhereLocalHourIs(12, now) }) },
    check: goodCheck({ newly_removed: 1, checked_at: new Date(checkedAt).toISOString() }),
    now,
  });
  assert.equal(decision.verdict, 'hold');
  assert.equal(decision.next_safe_at, checkedAt + 3 * DAY);
  assert.match(decision.reasons.join(' '), /cool-down/);
});

test('a removal older than the cool-down no longer holds', () => {
  const now = Date.parse('2026-06-15T15:00:00Z');
  const decision = gateDecision({
    account: { status: 'active', fingerprint: fingerprint({ timezone: zoneWhereLocalHourIs(12, now) }) },
    check: goodCheck({ newly_removed: 2, checked_at: new Date(now - 4 * DAY).toISOString() }),
    now,
  });
  assert.equal(decision.verdict, 'pass');
});

test('outside the posting window the gate holds until the window reopens', () => {
  const now = Date.parse('2026-06-15T15:00:00Z');
  const zone = zoneWhereLocalHourIs(3, now);
  const decision = gateDecision({
    account: { status: 'active', fingerprint: fingerprint({ timezone: zone }) },
    check: goodCheck({ checked_at: new Date(now).toISOString() }),
    now,
  });
  assert.equal(decision.verdict, 'hold');
  assert.match(decision.reasons.join(' '), /posting window/);
  // 3am local, window opens at 08:00: five hours out, to the quarter hour.
  assert.ok(decision.next_safe_at > now, 'the slot is in the future');
  assert.ok(decision.next_safe_at <= now + 5 * HOUR + 15 * 60 * 1000);
  // And at that moment the same action passes.
  const later = gateDecision({
    account: { status: 'active', fingerprint: fingerprint({ timezone: zone }) },
    check: goodCheck({ checked_at: new Date(now).toISOString() }),
    now: decision.next_safe_at,
  });
  assert.equal(later.verdict, 'pass');
});

test('a fingerprint can narrow its own posting window, overnight wrap included', () => {
  const now = Date.parse('2026-06-15T15:00:00Z');
  const zone = zoneWhereLocalHourIs(3, now);
  // 3am is inside a 21 -> 05 window, so the night owl is not held.
  const decision = gateDecision({
    account: { status: 'active', fingerprint: fingerprint({ timezone: zone, posting_window: [21, 5] }) },
    check: goodCheck({ checked_at: new Date(now).toISOString() }),
    now,
  });
  assert.equal(decision.verdict, 'pass');
});

test('an unknown timezone does not hold on the window and does not throw', () => {
  const now = Date.parse('2026-06-15T15:00:00Z');
  for (const account of [{ status: 'active' }, { status: 'active', fingerprint: null }, { status: 'active', fingerprint: { timezone: 'Not/AZone' } }]) {
    const decision = gateDecision({ account, check: goodCheck({ checked_at: new Date(now).toISOString() }), now });
    assert.equal(decision.verdict, 'pass', JSON.stringify(account));
  }
});

test('pacing holds a second action inside the jittered gap after the first', () => {
  const now = Date.parse('2026-06-15T15:00:00Z');
  const account = { status: 'active', fingerprint: fingerprint({ timezone: zoneWhereLocalHourIs(12, now) }) };
  const decision = gateDecision({ account, check: goodCheck({ checked_at: new Date(now).toISOString() }), releases: [now - 60_000], now });
  assert.equal(decision.verdict, 'hold');
  assert.match(decision.reasons.join(' '), /cool-down after the last release/);
  assert.ok(decision.next_safe_at > now);
  assert.ok(decision.next_safe_at <= now - 60_000 + MAX_GAP, 'never further out than the maximum gap');
});

test('pacing clears once the last release is older than the maximum gap', () => {
  const now = Date.parse('2026-06-15T15:00:00Z');
  const account = { status: 'active', fingerprint: fingerprint({ timezone: zoneWhereLocalHourIs(12, now) }) };
  const decision = gateDecision({ account, check: goodCheck({ checked_at: new Date(now).toISOString() }), releases: [now - MAX_GAP - 1000], now });
  assert.equal(decision.verdict, 'pass');
});

test('the pacing gap is jittered, never a fixed interval', () => {
  const now = Date.parse('2026-06-15T15:00:00Z');
  const account = { status: 'active', fingerprint: fingerprint({ timezone: zoneWhereLocalHourIs(12, now) }) };
  const last = now - 60_000;
  const gaps = new Set();
  for (let i = 0; i < 40; i++) {
    const decision = gateDecision({ account, check: goodCheck({ checked_at: new Date(now).toISOString() }), releases: [last], now });
    const gap = decision.next_safe_at - last;
    assert.ok(gap >= MIN_GAP && gap <= MAX_GAP, `gap ${gap} outside the range`);
    gaps.add(gap);
  }
  assert.ok(gaps.size > 30, `expected a spread of gaps, got ${gaps.size} distinct values in 40 draws`);
});

test('the daily budget holds the ninth action until the oldest release ages out', () => {
  const now = Date.parse('2026-06-15T15:00:00Z');
  const account = { status: 'active', fingerprint: fingerprint({ timezone: zoneWhereLocalHourIs(12, now) }) };
  const check = goodCheck({ checked_at: new Date(now).toISOString() });
  // Eight releases spread over the last 20 hours, the oldest 20h ago.
  const releases = Array.from({ length: 8 }, (_, i) => now - (20 - i * 2) * HOUR);
  const held = gateDecision({ account, check, releases, now });
  assert.equal(held.verdict, 'hold');
  assert.match(held.reasons.join(' '), /Daily budget of 8/);
  assert.equal(held.next_safe_at, releases[0] + DAY);
  // Once the oldest has aged out of the rolling day, there is room again.
  const after = gateDecision({ account, check, releases, now: releases[0] + DAY + 1000 });
  assert.equal(after.verdict, 'pass');
});

test('the cool-down, the window and pacing merge to the latest floor', () => {
  const now = Date.parse('2026-06-15T15:00:00Z');
  const checkedAt = now - 2 * DAY;
  // Night-time *and* inside the removal cool-down: the cool-down is the later
  // of the two floors, so it is the one that decides.
  const decision = gateDecision({
    account: { status: 'active', fingerprint: fingerprint({ timezone: zoneWhereLocalHourIs(3, now) }) },
    check: goodCheck({ newly_removed: 1, checked_at: new Date(checkedAt).toISOString() }),
    now,
  });
  assert.equal(decision.verdict, 'hold');
  assert.equal(decision.next_safe_at, checkedAt + 3 * DAY);
});

// ---------------------------------------------------------------- the routes


// A stealth account whose local hour is mid-day, so the posting window is open
// and only the stage under test can hold the action.
async function stealthAccount(repo, { check = goodCheck(), fp = {} } = {}) {
  const account = await repo.createAccount({ username: 'gated' });
  await repo.updateAccount(account.id, {
    status: 'active',
    stealth_mode: true,
    fingerprint: fingerprint({ timezone: zoneWhereLocalHourIs(12), ...fp }),
  });
  if (check) await repo.insertCheck({ account_id: account.id, ...check });
  return account;
}

test('POST gate passes a clear account, audits it and queues nothing', async () => {
  const repo = createMemoryRepo();
  const account = await stealthAccount(repo);
  await withServer({ repo }, async (call) => {
    const res = await call('POST', `/api/accounts/${account.id}/stealth/gate`, { action: 'comment', payload: { subreddit: 'test' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.verdict, 'pass');
    assert.ok(res.body.token);
    assert.equal(repo.gateQueue.size, 0, 'a pass is not queued');
    assert.ok(repo.shieldEvents.some((e) => e.event_type === 'gate_passed' && e.draft_id === null && e.details.action === 'comment'));
  });
});

test('POST gate blocks a critical account with no token, and audits the block', async () => {
  const repo = createMemoryRepo();
  const account = await stealthAccount(repo, { check: goodCheck({ risk_level: 'critical', risk_score: 91 }) });
  await withServer({ repo }, async (call) => {
    const res = await call('POST', `/api/accounts/${account.id}/stealth/gate`, { action: 'post' });
    assert.equal(res.status, 200);
    assert.equal(res.body.verdict, 'block');
    assert.equal(res.body.token, undefined);
    assert.equal(res.body.next_safe_at, null);
    assert.equal(repo.gateQueue.size, 0, 'a block is not queued: it needs a person, not a slot');
    const event = repo.shieldEvents.find((e) => e.event_type === 'gate_blocked');
    assert.ok(event);
    assert.equal(event.draft_id, null);
    assert.equal(event.details.intervention.code, 'critical_risk');
  });
});

test('POST gate soft-holds after three consecutive failed checks', async () => {
  const repo = createMemoryRepo();
  const account = await stealthAccount(repo, { check: null });
  // Newest first in getRecentChecks: three errors on top of one good check.
  await repo.insertCheck({ account_id: account.id, ...goodCheck({ checked_at: new Date(Date.now() - 4 * HOUR).toISOString() }) });
  for (let i = 3; i >= 1; i--) {
    await repo.insertCheck({ account_id: account.id, error: 'Profile page unavailable', checked_at: new Date(Date.now() - i * HOUR).toISOString() });
  }
  await withServer({ repo }, async (call) => {
    const res = await call('POST', `/api/accounts/${account.id}/stealth/gate`, { action: 'comment' });
    assert.equal(res.body.verdict, 'hold', 'a monitor that cannot see is a hold, never a block');
    assert.match(res.body.reasons.join(' '), /Soft hold/);
    assert.ok(res.body.next_safe_at > Date.now());
    assert.ok(res.body.token);
    assert.equal(repo.gateQueue.size, 1);
  });
});

test('POST gate holds on pacing once an action has been released, and queues it durably', async () => {
  const realNow = Date.now();
  let clock = realNow;
  const repo = createMemoryRepo({ now: () => clock });
  const account = await stealthAccount(repo);
  await withServer({ repo }, async (call) => {
    // First action passes, so nothing is queued; stand in for the caller
    // having sent it by queueing and releasing one at "a minute ago".
    assert.equal((await call('POST', `/api/accounts/${account.id}/stealth/gate`, { action: 'comment' })).body.verdict, 'pass');
    clock = realNow - 60_000;
    const queued = await repo.createGateQueue({ account_id: account.id, action: 'comment', verdict: 'hold' });
    await repo.releaseGateQueue(queued.id, 'sent');
    clock = realNow;

    const second = await call('POST', `/api/accounts/${account.id}/stealth/gate`, { action: 'comment' });
    assert.equal(second.body.verdict, 'hold');
    assert.ok(second.body.next_safe_at > Date.now(), 'a hold always says when the slot opens');
    assert.ok(second.body.queued, 'the held action is queued so a restart cannot drop it');
    const row = repo.gateQueue.get(second.body.queued);
    assert.equal(row.verdict, 'hold');
    assert.equal(row.account_id, account.id);
    assert.ok(row.next_safe_at, 'the durable row carries the slot too');
    assert.equal(row.released_at, null);
  });
});

test('a release older than the maximum gap stops counting against pacing', async () => {
  const realNow = Date.now();
  let clock = realNow - 3 * HOUR;
  const repo = createMemoryRepo({ now: () => clock });
  const account = await stealthAccount(repo);
  const queued = await repo.createGateQueue({ account_id: account.id, action: 'comment', verdict: 'hold' });
  await repo.releaseGateQueue(queued.id, 'sent');
  clock = realNow;
  await withServer({ repo }, async (call) => {
    const res = await call('POST', `/api/accounts/${account.id}/stealth/gate`, { action: 'comment' });
    assert.equal(res.body.verdict, 'pass');
  });
});

test('the daily budget holds a ninth action through the route', async () => {
  const realNow = Date.now();
  let clock = realNow;
  const repo = createMemoryRepo({ now: () => clock });
  const account = await stealthAccount(repo);
  // Eight released actions spread over the last 20 hours.
  for (let i = 0; i < 8; i++) {
    clock = realNow - (20 - i * 2) * HOUR;
    const row = await repo.createGateQueue({ account_id: account.id, action: 'comment', verdict: 'hold' });
    await repo.releaseGateQueue(row.id, 'sent');
  }
  clock = realNow;
  await withServer({ repo }, async (call) => {
    const res = await call('POST', `/api/accounts/${account.id}/stealth/gate`, { action: 'comment' });
    assert.equal(res.body.verdict, 'hold');
    assert.match(res.body.reasons.join(' '), /Daily budget/);
  });
});

test('POST gate release clears a held action exactly once', async () => {
  const repo = createMemoryRepo();
  const account = await stealthAccount(repo, { fp: { timezone: zoneWhereLocalHourIs(3) } });
  await withServer({ repo }, async (call) => {
    const held = await call('POST', `/api/accounts/${account.id}/stealth/gate`, { action: 'comment' });
    assert.equal(held.body.verdict, 'hold', 'held by the posting window');
    const id = held.body.queued;

    const first = await call('POST', `/api/accounts/${account.id}/stealth/gate/${id}`, { reason: 'operator sent it' });
    assert.equal(first.status, 200);
    assert.ok(first.body.queued.released_at);
    assert.equal(first.body.queued.released_reason, 'operator sent it');

    const second = await call('POST', `/api/accounts/${account.id}/stealth/gate/${id}`, {});
    assert.equal(second.status, 409, 'a double release would hand pacing a second slot');

    assert.ok(repo.shieldEvents.some((e) => e.event_type === 'gate_released' && e.details.token === id));
  });
});

test('gate release defaults its reason and refuses unknown or foreign rows', async () => {
  const repo = createMemoryRepo();
  const account = await stealthAccount(repo, { fp: { timezone: zoneWhereLocalHourIs(3) } });
  const other = await repo.createAccount({ username: 'bystander' });
  const foreign = await repo.createGateQueue({ account_id: other.id, action: 'comment', verdict: 'hold' });
  await withServer({ repo }, async (call) => {
    const held = await call('POST', `/api/accounts/${account.id}/stealth/gate`, { action: 'comment' });
    const ok = await call('POST', `/api/accounts/${account.id}/stealth/gate/${held.body.queued}`, {});
    assert.equal(ok.body.queued.released_reason, 'released by operator');

    assert.equal((await call('POST', `/api/accounts/${account.id}/stealth/gate/not-a-uuid`, {})).status, 404);
    assert.equal((await call('POST', `/api/accounts/${account.id}/stealth/gate/${foreign.id}`, {})).status, 404, "another account's row is not visible here");
  });
});

test('GET gate returns the overview and GET gate/queue filters the open rows', async () => {
  const repo = createMemoryRepo();
  const account = await stealthAccount(repo, { fp: { timezone: zoneWhereLocalHourIs(3) } });
  await withServer({ repo }, async (call) => {
    const first = await call('POST', `/api/accounts/${account.id}/stealth/gate`, { action: 'comment' });
    await call('POST', `/api/accounts/${account.id}/stealth/gate`, { action: 'post' });
    await call('POST', `/api/accounts/${account.id}/stealth/gate/${first.body.queued}`, {});

    const overview = await call('GET', `/api/accounts/${account.id}/stealth/gate`);
    assert.equal(overview.status, 200);
    assert.equal(overview.body.stealth_mode, true);
    assert.equal(overview.body.verdict, null, 'a read decides nothing');
    assert.equal(overview.body.queue.length, 2);

    const all = await call('GET', `/api/accounts/${account.id}/stealth/gate/queue`);
    assert.equal(all.body.queue.length, 2);
    const open = await call('GET', `/api/accounts/${account.id}/stealth/gate/queue?open=1`);
    assert.equal(open.body.open, true);
    assert.equal(open.body.queue.length, 1);
    assert.equal(open.body.queue[0].action, 'post');
  });
});

test('gate routes guard stealth mode, the action name, the payload and the account', async () => {
  const repo = createMemoryRepo();
  const plain = await repo.createAccount({ username: 'plain' });
  const account = await stealthAccount(repo);
  await withServer({ repo }, async (call) => {
    const off = await call('POST', `/api/accounts/${plain.id}/stealth/gate`, { action: 'comment' });
    assert.equal(off.status, 400);
    assert.match(off.body.error, /Stealth mode is not enabled/);

    assert.equal((await call('POST', `/api/accounts/${account.id}/stealth/gate`, {})).status, 400);
    assert.equal((await call('POST', `/api/accounts/${account.id}/stealth/gate`, { action: '   ' })).status, 400);
    assert.equal((await call('POST', `/api/accounts/${account.id}/stealth/gate`, { action: 'comment', payload: [1, 2] })).status, 400);
    assert.equal((await call('POST', `/api/accounts/${account.id}/stealth/gate`, { action: 'comment', payload: 'text' })).status, 400);

    const unknown = '00000000-0000-4000-8000-000000000000';
    assert.equal((await call('POST', `/api/accounts/${unknown}/stealth/gate`, { action: 'comment' })).status, 404);
    assert.equal((await call('GET', `/api/accounts/${unknown}/stealth/gate`)).status, 404);
  });
});

test('the gate decides even when the Shield migration was never run', async () => {
  const repo = createMemoryRepo();
  const account = await stealthAccount(repo);
  // A workspace without shield.sql has no audit sink; the gate must still work.
  delete repo.insertShieldEvent;
  await withServer({ repo }, async (call) => {
    const res = await call('POST', `/api/accounts/${account.id}/stealth/gate`, { action: 'comment' });
    assert.equal(res.status, 200);
    assert.equal(res.body.verdict, 'pass');
  });
});

test('deleting an account clears its queued actions', async () => {
  const repo = createMemoryRepo();
  const account = await stealthAccount(repo, { fp: { timezone: zoneWhereLocalHourIs(3) } });
  await withServer({ repo }, async (call) => {
    await call('POST', `/api/accounts/${account.id}/stealth/gate`, { action: 'comment' });
    assert.equal(repo.gateQueue.size, 1);
    await call('DELETE', `/api/accounts/${account.id}`);
    assert.equal(repo.gateQueue.size, 0, 'mirrors the schema on delete cascade');
  });
});

test('clearGateQueue removes only the named account rows', async () => {
  const repo = createMemoryRepo();
  const a = await repo.createAccount({ username: 'one' });
  const b = await repo.createAccount({ username: 'two' });
  await repo.createGateQueue({ account_id: a.id, action: 'comment', verdict: 'hold' });
  await repo.createGateQueue({ account_id: b.id, action: 'comment', verdict: 'hold' });
  await repo.clearGateQueue(a.id);
  assert.equal((await repo.listGateQueue(a.id)).length, 0);
  assert.equal((await repo.listGateQueue(b.id)).length, 1);
  assert.equal(await repo.getGateQueue('00000000-0000-4000-8000-000000000000'), null);
});
