import assert from 'node:assert/strict';
import test from 'node:test';
import { createScheduler, isDue, tickMinutes } from '../src/scheduler.js';
import { withServer } from './harness.js';
import { DAY, HOUR, NOW, createMemoryRepo, silentLog } from './helpers.js';

const iso = (ms) => new Date(ms).toISOString();
const account = (over = {}) => ({ id: 'a', username: 'tester', paused: false, last_checked_at: null, check_interval_minutes: null, ...over });

test('an account that has never been checked is always due', () => {
  assert.equal(isDue(account(), { intervalMinutes: 60, now: NOW }), true);
  assert.equal(isDue(account({ last_checked_at: 'not a date' }), { intervalMinutes: 60, now: NOW }), true);
});

test('a paused account is never due', () => {
  assert.equal(isDue(account({ paused: true }), { intervalMinutes: 60, now: NOW }), false);
  assert.equal(isDue(account({ paused: true, last_checked_at: iso(NOW - DAY) }), { intervalMinutes: 60, now: NOW }), false);
});

test('the server interval decides when an account sets none', () => {
  assert.equal(isDue(account({ last_checked_at: iso(NOW - 30 * 60_000) }), { intervalMinutes: 60, now: NOW }), false);
  assert.equal(isDue(account({ last_checked_at: iso(NOW - HOUR) }), { intervalMinutes: 60, now: NOW }), true);
});

test('a run that starts a moment early still counts the account as due', () => {
  // Without the slack, a run firing 1s before the hour would skip every
  // account and halve the real check rate.
  assert.equal(isDue(account({ last_checked_at: iso(NOW - HOUR + 1000) }), { intervalMinutes: 60, now: NOW }), true);
});

test('an account interval overrides the server one, in both directions', () => {
  const twentyMinutesAgo = iso(NOW - 20 * 60_000);
  // Wants checking every 15 minutes on a server that checks hourly: due.
  assert.equal(isDue(account({ last_checked_at: twentyMinutesAgo, check_interval_minutes: 15 }), { intervalMinutes: 60, now: NOW }), true);
  // Wants checking daily on a server that checks hourly: not due.
  assert.equal(isDue(account({ last_checked_at: iso(NOW - 2 * HOUR), check_interval_minutes: 1440 }), { intervalMinutes: 60, now: NOW }), false);
});

test('an account interval below the floor is raised to it', () => {
  // A one-minute override would burn quota without telling you anything new.
  assert.equal(isDue(account({ last_checked_at: iso(NOW - 5 * 60_000), check_interval_minutes: 1 }), { intervalMinutes: 60, now: NOW }), false);
  assert.equal(isDue(account({ last_checked_at: iso(NOW - 15 * 60_000), check_interval_minutes: 1 }), { intervalMinutes: 60, now: NOW }), true);
});

test('the tick follows the most impatient unpaused account', () => {
  assert.equal(tickMinutes([], 60), 60);
  assert.equal(tickMinutes([account()], 60), 60, 'no overrides: the server interval');
  assert.equal(tickMinutes([account(), account({ check_interval_minutes: 20 })], 60), 20);
  assert.equal(tickMinutes([account({ check_interval_minutes: 20, paused: true })], 60), 60, 'a paused account asks for nothing');
  assert.equal(tickMinutes([account({ check_interval_minutes: 2 })], 60), 15, 'never below the floor');
  assert.equal(tickMinutes([account({ check_interval_minutes: 240 })], 60), 60, 'an override never slows the tick below the server interval');
});

test('a run checks only the due accounts and paces them apart', async () => {
  const repo = createMemoryRepo({ now: () => NOW });
  const due = await repo.createAccount({ username: 'due' });
  const fresh = await repo.createAccount({ username: 'fresh' });
  const paused = await repo.createAccount({ username: 'paused' });
  const second = await repo.createAccount({ username: 'alsodue' });
  await repo.updateAccount(fresh.id, { last_checked_at: iso(NOW - 60_000) });
  await repo.updateAccount(paused.id, { paused: true });

  const seen = [];
  const slept = [];
  const scheduler = createScheduler({
    repo,
    checker: { async checkAccount(a) { seen.push(a.username); } },
    intervalMinutes: 60,
    log: silentLog,
    now: () => NOW,
    sleep: async (ms) => slept.push(ms),
  });
  assert.equal(scheduler.trigger(), true);
  // trigger() does not await; give the run a turn to finish.
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(seen.sort(), ['alsodue', 'due']);
  assert.equal(slept.length, 1, 'one gap between two accounts, none before the first');
  assert.ok(slept[0] >= 2_000 && slept[0] <= 9_000, `gap ${slept[0]} out of range`);
  assert.equal(scheduler.status().lastRunAt, iso(NOW));
  assert.ok(second);
});

test('a verification resume rechecks recent accounts while respecting paused accounts and reader pauses', async () => {
  const repo = createMemoryRepo({ now: () => NOW });
  const recent = await repo.createAccount({ username: 'recent' });
  const paused = await repo.createAccount({ username: 'paused' });
  await repo.updateAccount(recent.id, { last_checked_at: new Date(NOW).toISOString() });
  await repo.updateAccount(paused.id, { last_checked_at: new Date(NOW).toISOString(), paused: true });
  const checked = [];
  let readerPaused = false;
  const scheduler = createScheduler({
    repo, intervalMinutes: 60, now: () => NOW, log: silentLog, sleep: async () => {},
    reddit: { getDiagnostics: () => ({ paused: readerPaused }) },
    checker: { async checkAccount(account) { checked.push(account.username); } },
  });
  scheduler.trigger();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(checked, [], 'scheduled cadence stays unchanged');
  scheduler.trigger({ force: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(checked, ['recent'], 'the user can resume real checks immediately after verification');
  readerPaused = true;
  assert.equal(scheduler.trigger({ force: true }), false, 'force never overrides a shared reader pause');
});

test('the between-account gap is jittered, not a constant', async () => {
  const repo = createMemoryRepo({ now: () => NOW });
  for (let i = 0; i < 6; i++) await repo.createAccount({ username: `acct${i}` });
  const slept = [];
  const scheduler = createScheduler({
    repo,
    checker: { async checkAccount() {} },
    intervalMinutes: 60,
    log: silentLog,
    now: () => NOW,
    sleep: async (ms) => slept.push(ms),
  });
  for (let run = 0; run < 5; run++) {
    scheduler.trigger();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(slept.length >= 20);
  assert.ok(new Set(slept).size > slept.length * 0.8, `expected a spread of gaps, got ${new Set(slept).size} distinct of ${slept.length}`);
});

test('a crashing check does not stop the rest of the run', async () => {
  const repo = createMemoryRepo({ now: () => NOW });
  await repo.createAccount({ username: 'bad' });
  await repo.createAccount({ username: 'good' });
  const seen = [];
  const scheduler = createScheduler({
    repo,
    checker: { async checkAccount(a) { seen.push(a.username); if (a.username === 'bad') throw new Error('boom'); } },
    intervalMinutes: 60,
    log: silentLog,
    now: () => NOW,
    sleep: async () => {},
  });
  scheduler.trigger();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen.sort(), ['bad', 'good']);
});

test('trigger refuses to start a second run on top of a running one', async () => {
  const repo = createMemoryRepo({ now: () => NOW });
  await repo.createAccount({ username: 'slow' });
  let release;
  const scheduler = createScheduler({
    repo,
    checker: { async checkAccount() { await new Promise((resolve) => { release = resolve; }); } },
    intervalMinutes: 60,
    log: silentLog,
    now: () => NOW,
    sleep: async () => {},
  });
  assert.equal(scheduler.trigger(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.status().running, true);
  assert.equal(scheduler.trigger(), false, 'two runs in parallel would double the rate at Reddit');
  release();
  await new Promise((resolve) => setImmediate(resolve));
});

test('status reports the tick the last run settled on', async () => {
  const repo = createMemoryRepo({ now: () => NOW });
  const watched = await repo.createAccount({ username: 'watched' });
  await repo.updateAccount(watched.id, { check_interval_minutes: 20 });
  const scheduler = createScheduler({
    repo,
    checker: { async checkAccount() {} },
    intervalMinutes: 60,
    log: silentLog,
    now: () => NOW,
    sleep: async () => {},
  });
  assert.equal(scheduler.status().tickMinutes, 60, 'before any run, the configured interval');
  scheduler.trigger();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.status().tickMinutes, 20);
});

// ---------------------------------------------------------------- the route


test('PATCH sets, clears and validates an account check interval', async () => {
  const repo = createMemoryRepo();
  const acct = await repo.createAccount({ username: 'tester' });
  await withServer({ repo }, async (call) => {
    assert.equal((await call('GET', `/api/accounts/${acct.id}`)).body.account.check_interval_minutes, null);

    const set = await call('PATCH', `/api/accounts/${acct.id}`, { check_interval_minutes: 30 });
    assert.equal(set.status, 200);
    assert.equal(set.body.account.check_interval_minutes, 30);

    const cleared = await call('PATCH', `/api/accounts/${acct.id}`, { check_interval_minutes: null });
    assert.equal(cleared.body.account.check_interval_minutes, null);

    for (const bad of [5, 0, -30, 20161, 30.5, 'hourly', true]) {
      const res = await call('PATCH', `/api/accounts/${acct.id}`, { check_interval_minutes: bad });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    }
  });
});
