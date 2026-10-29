import assert from 'node:assert/strict';
import test from 'node:test';
import { createNotifier } from '../src/notify.js';
import { createEscalation, dueForEscalation } from '../src/escalation.js';
import { HOUR, NOW, createMemoryRepo, silentLog } from './helpers.js';

const HOOK = 'https://example.invalid/webhook';
const iso = (ms) => new Date(ms).toISOString();
const ok = () => ({ ok: true, status: 204, headers: new Headers() });
const fail = (status, headers = {}) => ({ ok: false, status, headers: new Headers(headers) });

function recorder(responses) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, fetchImpl };
}

// ------------------------------------------------------------------- sending

test('a warning alert is posted in both the Discord and the Slack key', async () => {
  const { calls, fetchImpl } = recorder([ok()]);
  const notify = createNotifier({ webhookUrl: HOOK, fetchImpl, log: silentLog, sleep: async () => {} });
  const result = await notify({ severity: 'critical', message: 'Profile returns 404 to logged-out visitors' }, { username: 'tester' });
  assert.deepEqual(result, { sent: true, attempts: 1, status: 204, error: null });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.content, calls[0].body.text, 'Discord reads content, Slack reads text');
  assert.match(calls[0].body.content, /^\[CRITICAL\] u\/tester /);
});

test('no webhook and info alerts send nothing', async () => {
  const { calls, fetchImpl } = recorder([ok()]);
  const quiet = createNotifier({ webhookUrl: '', fetchImpl, log: silentLog, sleep: async () => {} });
  assert.equal((await quiet({ severity: 'critical', message: 'x' })).sent, false);
  const notify = createNotifier({ webhookUrl: HOOK, fetchImpl, log: silentLog, sleep: async () => {} });
  assert.equal((await notify({ severity: 'info', message: 'recovered' })).skipped, true);
  assert.equal(calls.length, 0);
});

test('a 500 is retried and a later success still counts as sent', async () => {
  const { calls, fetchImpl } = recorder([fail(500), fail(502), ok()]);
  const notify = createNotifier({ webhookUrl: HOOK, fetchImpl, log: silentLog, sleep: async () => {} });
  const result = await notify({ severity: 'warning', message: 'removal spike' });
  assert.equal(result.sent, true);
  assert.equal(result.attempts, 3);
  assert.equal(calls.length, 3);
});

test('a network failure is retried and reported, never thrown', async () => {
  const { calls, fetchImpl } = recorder([new Error('socket hang up')]);
  const notify = createNotifier({ webhookUrl: HOOK, fetchImpl, log: silentLog, sleep: async () => {} });
  const result = await notify({ severity: 'warning', message: 'removal spike' });
  assert.equal(result.sent, false);
  assert.equal(result.attempts, 3, 'a check must not lose its results to a webhook outage');
  assert.equal(result.error, 'socket hang up');
  assert.equal(calls.length, 3);
});

test('a 404 is not retried: a deleted webhook will answer the same way', async () => {
  const { calls, fetchImpl } = recorder([fail(404)]);
  const notify = createNotifier({ webhookUrl: HOOK, fetchImpl, log: silentLog, sleep: async () => {} });
  const result = await notify({ severity: 'warning', message: 'removal spike' });
  assert.equal(result.sent, false);
  assert.equal(result.attempts, 1);
  assert.equal(result.status, 404);
  assert.equal(calls.length, 1);
});

test('a 429 is retried and waits as long as Retry-After asks', async () => {
  const slept = [];
  const { fetchImpl } = recorder([fail(429, { 'retry-after': '2' }), ok()]);
  const notify = createNotifier({ webhookUrl: HOOK, fetchImpl, log: silentLog, sleep: async (ms) => slept.push(ms) });
  assert.equal((await notify({ severity: 'warning', message: 'x' })).sent, true);
  assert.deepEqual(slept, [2000]);
});

test('a Retry-After date is honoured, and a nonsense one falls back to backoff', async () => {
  const slept = [];
  const future = new Date(Date.now() + 3000).toUTCString();
  const { fetchImpl } = recorder([fail(429, { 'retry-after': future }), ok()]);
  await createNotifier({ webhookUrl: HOOK, fetchImpl, log: silentLog, sleep: async (ms) => slept.push(ms) })({ severity: 'warning', message: 'x' });
  assert.ok(slept[0] > 1000 && slept[0] <= 4000, `slept ${slept[0]}`);

  const other = [];
  const second = recorder([fail(429, { 'retry-after': 'soon' }), ok()]);
  await createNotifier({ webhookUrl: HOOK, fetchImpl: second.fetchImpl, log: silentLog, sleep: async (ms) => other.push(ms) })({ severity: 'warning', message: 'x' });
  assert.ok(other[0] > 0 && other[0] <= 4000);
});

test('backoff is jittered so simultaneous failures do not retry in lockstep', async () => {
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    const slept = [];
    const { fetchImpl } = recorder([fail(500), ok()]);
    await createNotifier({ webhookUrl: HOOK, fetchImpl, log: silentLog, sleep: async (ms) => slept.push(ms) })({ severity: 'warning', message: 'x' });
    seen.add(slept[0]);
  }
  assert.ok(seen.size > 15, `expected a spread of backoffs, got ${seen.size} distinct of 20`);
});

// ---------------------------------------------------------------- escalation

const alert = (over = {}) => ({ id: 'x', severity: 'critical', type: 'shadowban_suspected', message: 'm', created_at: iso(NOW - 2 * 24 * HOUR), acknowledged_at: null, details: {}, ...over });

test('escalation is off for a zero, negative or unparseable window', () => {
  for (const hours of [0, -5, 'never', NaN, null]) {
    assert.deepEqual(dueForEscalation([alert()], { afterHours: hours, now: NOW }), []);
  }
});

test('only open, non-info, old-enough alerts are due', () => {
  const alerts = [
    alert({ id: 'old-open' }),
    alert({ id: 'acked', acknowledged_at: iso(NOW - HOUR) }),
    alert({ id: 'info', severity: 'info' }),
    alert({ id: 'fresh', created_at: iso(NOW - HOUR) }),
    alert({ id: 'undated', created_at: 'not a date' }),
  ];
  assert.deepEqual(
    dueForEscalation(alerts, { afterHours: 24, now: NOW }).map((a) => a.id),
    ['old-open'],
  );
});

test('a reminder repeats once per window, not on every pass', () => {
  const justReminded = alert({ details: { escalated_at: iso(NOW - HOUR) } });
  assert.deepEqual(dueForEscalation([justReminded], { afterHours: 24, now: NOW }), []);
  const remindedLongAgo = alert({ details: { escalated_at: iso(NOW - 48 * HOUR) } });
  assert.equal(dueForEscalation([remindedLongAgo], { afterHours: 24, now: NOW }).length, 1);
});

test('a run re-notifies, marks and counts the reminders', async () => {
  const repo = createMemoryRepo({ now: () => NOW });
  const account = await repo.createAccount({ username: 'tester' });
  const stale = await repo.insertAlert({ account_id: account.id, created_at: iso(NOW - 3 * 24 * HOUR), severity: 'critical', type: 'shadowban_suspected', message: 'still 404', details: {} });
  await repo.insertAlert({ account_id: account.id, created_at: iso(NOW - HOUR), severity: 'warning', type: 'removal_spike', message: 'fresh', details: {} });

  const sent = [];
  const escalation = createEscalation({
    repo,
    notify: async (a) => { sent.push(a); return { sent: true }; },
    afterHours: 24,
    log: silentLog,
    now: () => NOW,
  });
  const result = await escalation.run();
  assert.deepEqual(result, { due: 1, sent: 1 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, stale.id);
  assert.equal(sent[0].escalated, true);

  const marked = (await repo.listAlerts({ limit: 10 })).find((a) => a.id === stale.id);
  assert.equal(marked.details.escalated_at, iso(NOW));
  assert.equal(marked.details.escalation_count, 1);

  // A second pass in the same window has nothing to do.
  assert.deepEqual(await escalation.run(), { due: 0, sent: 0 });
});

test('a reminder that failed to send stays due for the next pass', async () => {
  const repo = createMemoryRepo({ now: () => NOW });
  const account = await repo.createAccount({ username: 'tester' });
  await repo.insertAlert({ account_id: account.id, created_at: iso(NOW - 3 * 24 * HOUR), severity: 'critical', type: 'shadowban_suspected', message: 'still 404', details: {} });
  let online = false;
  const escalation = createEscalation({
    repo,
    notify: async () => ({ sent: online }),
    afterHours: 24,
    log: silentLog,
    now: () => NOW,
  });
  assert.deepEqual(await escalation.run(), { due: 1, sent: 0 });
  online = true;
  assert.deepEqual(await escalation.run(), { due: 1, sent: 1 }, 'the unsent reminder was not marked as delivered');
});

test('escalation with the window off does nothing and says so in status', async () => {
  const repo = createMemoryRepo({ now: () => NOW });
  const escalation = createEscalation({ repo, notify: async () => ({ sent: true }), afterHours: 0, log: silentLog, now: () => NOW });
  assert.equal(await escalation.run(), null);
  assert.deepEqual(escalation.status(), { afterHours: 0, lastRunAt: null, lastCount: 0 });
});

test('an escalated alert reads as a reminder, not a fresh incident', async () => {
  const { calls, fetchImpl } = recorder([ok()]);
  const notify = createNotifier({ webhookUrl: HOOK, fetchImpl, log: silentLog, sleep: async () => {} });
  await notify({ severity: 'critical', message: 'Profile returns 404', escalated: true }, { username: 'tester' });
  assert.match(calls[0].body.content, /^\[STILL OPEN\] u\/tester /);
});
