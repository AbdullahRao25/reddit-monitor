// Prunes history the dashboard no longer shows.
//
// Nothing in this app ever deleted a row it had written. One account on the
// default hour-long interval writes ~24 health_checks a day, every day,
// forever, plus a content_items row per post or comment it ever saw and a
// shield_events row per gate decision. On Supabase's free tier that is the
// kind of growth you notice only once writes start failing.
//
// What is kept, and why:
//
//   health_checks   the risk trend and the account page's history chart read
//                   these. Pruned past the window — except an account's most
//                   recent check, which is kept no matter how old it is: a
//                   paused account must not lose the last thing we knew about
//                   it just because nobody looked at it for a year.
//   content_items   the checker unions stored items from the last 30 days into
//                   every check to catch removals after posting, so the window
//                   is floored well above that (see MIN_RETENTION_DAYS).
//   shield_events   an audit trail, including every gate decision. Pruned
//                   past the window.
//   alerts          only acknowledged ones are pruned. An open alert is work
//                   somebody still owes, whatever its age.
//   gate queue      only released rows. An unreleased hold is a pending
//                   action, not history.
//
// Votes, warm-up logs, drafts, holds and incidents are not touched: they are
// imported or operator-entered, small, and nobody expects them to evaporate.

import { createPeriodicTask } from './periodic.js';

// The checker reads back stored content from the last 30 days, so a window
// shorter than that would delete rows the next check still needs.
export const MIN_RETENTION_DAYS = 45;
const DAY = 24 * 60 * 60 * 1000;

/**
 * Decides the cut-off dates for one pass. Pure, so the policy is testable
 * without a database.
 *
 * Returns null when retention is off, otherwise the ISO cut-off.
 */
export function retentionCutoff(retentionDays, now = Date.now()) {
  const days = Number(retentionDays);
  if (!Number.isFinite(days) || days <= 0) return null;
  return new Date(now - Math.max(MIN_RETENTION_DAYS, days) * DAY).toISOString();
}

/**
 * For one account: the cut-off its checks may be pruned to. Never prunes the
 * newest check, so `keep` is the older of the window and that check's own
 * timestamp.
 */
export function checksCutoff(cutoffIso, newestCheckedAt) {
  if (!newestCheckedAt) return cutoffIso;
  const newest = Date.parse(newestCheckedAt);
  if (!Number.isFinite(newest)) return cutoffIso;
  return new Date(Math.min(Date.parse(cutoffIso), newest)).toISOString();
}

export function createRetention({ repo, retentionDays, log = console, now = () => Date.now() }) {
  let lastRunAt = null;
  let lastResult = null;

  async function run() {
    const cutoff = retentionCutoff(retentionDays, now());
    if (!cutoff) return null;
    const totals = { health_checks: 0, content_items: 0, shield_events: 0, alerts: 0, gate_queue: 0 };
    const accounts = await repo.listAccounts();
    for (const account of accounts) {
      const [newest] = await repo.getRecentChecks(account.id, 1);
      const counts = await repo.pruneAccountHistory(account.id, {
        checksBefore: checksCutoff(cutoff, newest?.checked_at),
        contentBefore: cutoff,
      });
      totals.health_checks += counts.health_checks;
      totals.content_items += counts.content_items;
    }
    const global = await repo.pruneGlobalHistory(cutoff);
    totals.shield_events += global.shield_events;
    totals.alerts += global.alerts;
    totals.gate_queue += global.gate_queue;

    lastRunAt = new Date(now()).toISOString();
    lastResult = { cutoff, ...totals };
    const removed = Object.values(totals).reduce((sum, n) => sum + n, 0);
    if (removed > 0) log.log(`Retention: removed ${removed} rows older than ${cutoff}`);
    return lastResult;
  }

  // Nothing here is urgent, and a boot is the busiest the process gets (the
  // scheduler starts a full check run 10s in), so the first pass waits a few
  // minutes rather than competing with it.
  const task = createPeriodicTask({ name: 'Retention pass', run, firstDelayMs: 5 * 60 * 1000, everyMs: DAY, log });

  return {
    run,
    start: task.start,
    stop: task.stop,
    status: () => ({ retentionDays: Number(retentionDays) || 0, lastRunAt, lastResult }),
  };
}
