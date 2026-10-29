import assert from 'node:assert/strict';
import test from 'node:test';
import { createPeriodicTask } from '../src/periodic.js';
import { silentLog } from './helpers.js';

// Short delays throughout: these tests are about the chain, not the clock, so
// they wait for the condition they care about rather than for a fixed number
// of milliseconds — a fixed sleep makes them flaky on a loaded machine.
async function until(predicate, { timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not met within the timeout');
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test('the first run waits firstDelayMs, then the chain repeats on everyMs', async () => {
  let runs = 0;
  const task = createPeriodicTask({ name: 'test', run: async () => { runs++; }, firstDelayMs: 5, everyMs: 5, log: silentLog });
  assert.equal(runs, 0, 'nothing runs before start');
  task.start();
  await until(() => runs >= 2);
  task.stop();
});

test('a thrown pass is logged and the chain survives it', async () => {
  // The reason this helper exists: re-arming inside the success path would end
  // the task for the lifetime of the process on the first bad night.
  let runs = 0;
  const errors = [];
  const task = createPeriodicTask({
    name: 'Flaky pass',
    run: async () => { runs++; if (runs === 1) throw new Error('database unreachable'); },
    firstDelayMs: 5,
    everyMs: 5,
    log: { ...silentLog, error: (message) => errors.push(message) },
  });
  task.start();
  await until(() => runs >= 2);
  task.stop();
  assert.deepEqual(errors, ['Flaky pass failed: database unreachable']);
});

test('stop ends the chain, and stopping twice is harmless', async () => {
  let runs = 0;
  const task = createPeriodicTask({ name: 'test', run: async () => { runs++; }, firstDelayMs: 5, everyMs: 5, log: silentLog });
  task.start();
  await until(() => runs >= 1);
  task.stop();
  task.stop();
  const settled = runs;
  await settle();
  assert.equal(runs, settled, 'no further runs after stop');
});

test('start after stop runs again', async () => {
  let runs = 0;
  const task = createPeriodicTask({ name: 'test', run: async () => { runs++; }, firstDelayMs: 5, everyMs: 1000, log: silentLog });
  task.start();
  await until(() => runs >= 1);
  task.stop();
  const first = runs;
  task.start();
  await until(() => runs > first);
  task.stop();
});

test('the timer does not hold the process open', () => {
  // An unref'd timer is what lets a process whose only pending work is the
  // next prune exit instead of hanging.
  const timers = [];
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (...args) => {
    const timer = real(...args);
    timers.push(timer);
    return timer;
  };
  try {
    const task = createPeriodicTask({ name: 'test', run: async () => {}, firstDelayMs: 60_000, everyMs: 60_000, log: silentLog });
    task.start();
    assert.equal(timers.length, 1);
    assert.equal(timers[0].hasRef(), false);
    task.stop();
  } finally {
    globalThis.setTimeout = real;
    for (const timer of timers) clearTimeout(timer);
  }
});
