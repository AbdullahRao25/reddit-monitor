import assert from 'node:assert/strict';
import test from 'node:test';
import { MIN_RETENTION_DAYS, checksCutoff, createRetention, retentionCutoff } from '../src/retention.js';
import { DAY, NOW, createMemoryRepo, silentLog } from './helpers.js';

const iso = (ms) => new Date(ms).toISOString();

test('retention is off when the window is zero, negative or unparseable', () => {
  for (const value of [0, -1, '', null, undefined, 'soon', NaN]) {
    assert.equal(retentionCutoff(value, NOW), null, JSON.stringify(value));
  }
});

test('a window shorter than the checker needs is raised to the floor', () => {
  // The checker unions stored content from the last 30 days into every check,
  // so a 7-day window would delete rows the next check still reads.
  assert.equal(retentionCutoff(7, NOW), iso(NOW - MIN_RETENTION_DAYS * DAY));
  assert.equal(retentionCutoff(90, NOW), iso(NOW - 90 * DAY));
});

test('the checks cut-off never reaches an account newest check', () => {
  const cutoff = iso(NOW - 90 * DAY);
  // A busy account: its newest check is inside the window, so the window wins.
  assert.equal(checksCutoff(cutoff, iso(NOW - DAY)), cutoff);
  // A long-paused account: its newest check is older than the window, so that
  // check's own timestamp becomes the cut-off and the row survives.
  const stale = iso(NOW - 400 * DAY);
  assert.equal(checksCutoff(cutoff, stale), stale);
  // No checks at all, or an unreadable date: fall back to the window.
  assert.equal(checksCutoff(cutoff, null), cutoff);
  assert.equal(checksCutoff(cutoff, 'not a date'), cutoff);
});

async function seeded() {
  const repo = createMemoryRepo({ now: () => NOW });
  const busy = await repo.createAccount({ username: 'busy' });
  const paused = await repo.createAccount({ username: 'paused' });

  // Busy account: one recent check, two ancient ones.
  await repo.insertCheck({ account_id: busy.id, checked_at: iso(NOW - DAY), risk_score: 10 });
  await repo.insertCheck({ account_id: busy.id, checked_at: iso(NOW - 200 * DAY), risk_score: 20 });
  await repo.insertCheck({ account_id: busy.id, checked_at: iso(NOW - 300 * DAY), risk_score: 30 });
  // Paused account: nothing but ancient checks.
  await repo.insertCheck({ account_id: paused.id, checked_at: iso(NOW - 400 * DAY), risk_score: 40 });

  await repo.upsertContentItems([
    { id: 't3_new', account_id: busy.id, kind: 'post', created_at: iso(NOW - DAY), removal_status: 'visible' },
    { id: 't3_old', account_id: busy.id, kind: 'post', created_at: iso(NOW - 200 * DAY), removal_status: 'visible' },
  ]);

  const openAlert = await repo.insertAlert({ account_id: busy.id, created_at: iso(NOW - 200 * DAY), severity: 'critical', type: 'shadowban_suspected', message: 'old but unresolved' });
  const ackedAlert = await repo.insertAlert({ account_id: busy.id, created_at: iso(NOW - 200 * DAY), severity: 'warning', type: 'removal_spike', message: 'old and handled' });
  await repo.ackAlert(ackedAlert.id);

  repo.shieldEvents.push({ id: 'e-old', account_id: busy.id, draft_id: null, event_type: 'gate_passed', created_at: iso(NOW - 200 * DAY), details: {} });
  repo.shieldEvents.push({ id: 'e-new', account_id: busy.id, draft_id: null, event_type: 'gate_passed', created_at: iso(NOW - DAY), details: {} });

  const released = await repo.createGateQueue({ account_id: busy.id, action: 'comment', verdict: 'hold' });
  await repo.releaseGateQueue(released.id, 'sent');
  const pending = await repo.createGateQueue({ account_id: busy.id, action: 'post', verdict: 'hold' });
  // Both gate rows were written at NOW; age them past the window.
  for (const id of [released.id, pending.id]) {
    repo.gateQueue.set(id, { ...repo.gateQueue.get(id), created_at: iso(NOW - 200 * DAY) });
  }

  return { repo, busy, paused, openAlert, ackedAlert, released, pending };
}

test('a pass prunes aged history and reports what it removed', async () => {
  const { repo, busy, paused } = await seeded();
  const retention = createRetention({ repo, retentionDays: 90, log: silentLog, now: () => NOW });
  const result = await retention.run();

  assert.equal(result.health_checks, 2, "the busy account's two ancient checks");
  assert.equal(result.content_items, 1);
  assert.equal(result.alerts, 1, 'only the acknowledged one');
  assert.equal(result.shield_events, 1);
  assert.equal(result.gate_queue, 1, 'only the released hold');

  // The busy account keeps its recent check; the paused one keeps its only one.
  assert.deepEqual((await repo.getRecentChecks(busy.id, 10)).map((c) => c.risk_score), [10]);
  assert.deepEqual((await repo.getRecentChecks(paused.id, 10)).map((c) => c.risk_score), [40]);
});

test('an open alert and an unreleased hold are not history', async () => {
  const { repo, openAlert, pending } = await seeded();
  await createRetention({ repo, retentionDays: 90, log: silentLog, now: () => NOW }).run();
  const alerts = await repo.listAlerts({ limit: 50 });
  assert.ok(alerts.some((a) => a.id === openAlert.id), 'an unacknowledged alert survives any age');
  assert.ok(repo.gateQueue.has(pending.id), 'a pending gated action is not yet history');
});

test('retention off deletes nothing', async () => {
  const { repo } = await seeded();
  const retention = createRetention({ repo, retentionDays: 0, log: silentLog, now: () => NOW });
  assert.equal(await retention.run(), null);
  assert.equal(repo.checks.length, 4);
  assert.equal(repo.content.size, 2);
  assert.equal(repo.shieldEvents.length, 2);
  assert.equal(repo.gateQueue.size, 2);
  assert.equal(retention.status().retentionDays, 0);
});

test('a second pass over already pruned history removes nothing more', async () => {
  const { repo } = await seeded();
  const retention = createRetention({ repo, retentionDays: 90, log: silentLog, now: () => NOW });
  await retention.run();
  const second = await retention.run();
  assert.deepEqual(
    { ...second, cutoff: undefined },
    { cutoff: undefined, health_checks: 0, content_items: 0, shield_events: 0, alerts: 0, gate_queue: 0 },
  );
});

test('status reports the window and the last pass', async () => {
  const { repo } = await seeded();
  const retention = createRetention({ repo, retentionDays: 120, log: silentLog, now: () => NOW });
  assert.deepEqual(retention.status(), { retentionDays: 120, lastRunAt: null, lastResult: null });
  await retention.run();
  const status = retention.status();
  assert.equal(status.lastRunAt, iso(NOW));
  assert.equal(status.lastResult.cutoff, iso(NOW - 120 * DAY));
});

test('a workspace with no accounts prunes the shared tables anyway', async () => {
  const repo = createMemoryRepo({ now: () => NOW });
  repo.shieldEvents.push({ id: 'e', account_id: null, draft_id: null, event_type: 'gate_passed', created_at: iso(NOW - 200 * DAY), details: {} });
  const result = await createRetention({ repo, retentionDays: 90, log: silentLog, now: () => NOW }).run();
  assert.equal(result.shield_events, 1);
});
