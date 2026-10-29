// Re-checks every non-paused account that is due. Accounts are checked one
// after another, never in parallel, to stay within Reddit's API rate limit.
//
// Nothing here is on a grid. The gap between runs is jittered, and so is the
// gap between two accounts inside a run, for the same reason the active gate
// jitters its pacing: a request that arrives every 3600.000 seconds is a
// machine saying so out loud, and the whole point of this app is to notice
// what Reddit notices. The jitter is small — it shifts the cadence, it does
// not change how often an account is checked.
//
// An account may set its own `check_interval_minutes`. That is its floor: the
// scheduler ticks often enough for the shortest of them, and an account whose
// own interval has not elapsed yet is skipped rather than re-checked.

const MINUTE = 60 * 1000;
// The configured interval is the baseline; each run lands within this
// fraction either side of it.
const RUN_JITTER = 0.15;
// A pause between two accounts in the same run, so a sweep of ten accounts
// is not ten requests in ten seconds from one address.
const MIN_ACCOUNT_GAP = 2_000;
const MAX_ACCOUNT_GAP = 9_000;
// The floor config.js already applies to CHECK_INTERVAL_MINUTES: checking
// more often than this burns quota without telling you anything new.
const MIN_INTERVAL_MINUTES = 15;

const between = (min, max) => min + Math.random() * (max - min);

/**
 * Is this account due for a check?
 *
 * Pure, so the rule is testable: an account with no interval of its own uses
 * the global one, and an account that has never been checked is always due.
 */
export function isDue(account, { intervalMinutes, now }) {
  if (account.paused) return false;
  if (!account.last_checked_at) return true;
  const last = Date.parse(account.last_checked_at);
  if (!Number.isFinite(last)) return true;
  const own = Number(account.check_interval_minutes);
  const minutes = Number.isFinite(own) && own > 0 ? Math.max(MIN_INTERVAL_MINUTES, own) : intervalMinutes;
  // A tenth of a minute of slack: a run that starts a few hundred
  // milliseconds early must not push the account to the next run and halve
  // its real check rate.
  return now - last >= minutes * MINUTE - 6_000;
}

/**
 * How often the scheduler must wake up: often enough for the most impatient
 * account, never below the floor.
 */
export function tickMinutes(accounts, intervalMinutes) {
  const wanted = accounts
    .filter((account) => !account.paused)
    .map((account) => Number(account.check_interval_minutes))
    .filter((minutes) => Number.isFinite(minutes) && minutes > 0);
  return Math.max(MIN_INTERVAL_MINUTES, Math.min(intervalMinutes, ...wanted));
}

export function createScheduler({
  repo,
  checker,
  reddit = null,
  intervalMinutes,
  log = console,
  now = () => Date.now(),
  // Injected so tests do not actually wait out the between-account gaps.
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let timer = null;
  let running = false;
  let lastRunAt = null;
  let nextRunAt = null;
  let tick = intervalMinutes;

  function readerPause() {
    const reader = reddit?.getDiagnostics?.();
    return { paused: Boolean(reader?.paused), retryAt: reader?.retry_at ?? null };
  }

  async function runAll({ force = false } = {}) {
    running = true;
    try {
      if (readerPause().paused) return;
      const accounts = await repo.listAccounts();
      tick = tickMinutes(accounts, intervalMinutes);
      let checked = 0;
      for (const account of accounts) {
        // One access failure belongs to the shared reader, not every account.
        // Stop the sweep instead of writing an error for the whole workspace.
        if (readerPause().paused) break;
        if (account.paused || !force && !isDue(account, { intervalMinutes, now: now() })) continue;
        if (checked > 0) await sleep(between(MIN_ACCOUNT_GAP, MAX_ACCOUNT_GAP));
        if (readerPause().paused) break;
        checked++;
        try {
          await checker.checkAccount(account);
        } catch (err) {
          log.error(`Check crashed for u/${account.username}:`, err);
        }
      }
      lastRunAt = new Date(now()).toISOString();
    } finally {
      running = false;
    }
  }

  // Start a full run now unless one is already going. Returns whether it started.
  function trigger({ force = false } = {}) {
    if (running || readerPause().paused) return false;
    runAll({ force }).catch((err) => log.error('Run failed:', err));
    return true;
  }

  function scheduleNext(delayMs) {
    clearTimeout(timer);
    // Node timers overflow above this limit. Revisit a very long server
    // cooldown later without ever issuing a request before its retry time.
    delayMs = Math.min(delayMs, 2_147_483_647);
    nextRunAt = new Date(now() + delayMs).toISOString();
    timer = setTimeout(async () => {
      if (!running) await runAll().catch((err) => log.error('Scheduled run failed:', err));
      const base = tick * MINUTE;
      const pause = readerPause();
      const retryDelay = Date.parse(pause.retryAt) - now();
      scheduleNext(pause.paused && Number.isFinite(retryDelay) && retryDelay > 0
        ? retryDelay
        : between(base * (1 - RUN_JITTER), base * (1 + RUN_JITTER)));
    }, delayMs);
  }

  return {
    // The first run starts shortly after boot so a restart doesn't wait a full interval.
    start: () => scheduleNext(10_000),
    stop: () => {
      clearTimeout(timer);
      timer = null;
      nextRunAt = null;
    },
    trigger,
    status: () => ({ running, lastRunAt, nextRunAt, intervalMinutes, tickMinutes: tick,
      readerPaused: readerPause().paused, retryAt: readerPause().retryAt }),
  };
}
