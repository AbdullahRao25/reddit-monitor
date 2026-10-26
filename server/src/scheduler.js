// Re-checks every non-paused account on a fixed interval. Accounts are
// checked one after another, never in parallel, to stay within Reddit's
// API rate limit.
export function createScheduler({ repo, checker, intervalMinutes, log = console }) {
  const intervalMs = intervalMinutes * 60 * 1000;
  let timer = null;
  let running = false;
  let lastRunAt = null;
  let nextRunAt = null;

  async function runAll() {
    running = true;
    try {
      const accounts = await repo.listAccounts();
      for (const account of accounts) {
        if (account.paused) continue;
        try {
          await checker.checkAccount(account);
        } catch (err) {
          log.error(`Check crashed for u/${account.username}:`, err);
        }
      }
      lastRunAt = new Date().toISOString();
    } finally {
      running = false;
    }
  }

  // Start a full run now unless one is already going. Returns whether it started.
  function trigger() {
    if (running) return false;
    runAll().catch((err) => log.error('Run failed:', err));
    return true;
  }

  function scheduleNext(delayMs) {
    clearTimeout(timer);
    nextRunAt = new Date(Date.now() + delayMs).toISOString();
    timer = setTimeout(async () => {
      if (!running) await runAll().catch((err) => log.error('Scheduled run failed:', err));
      scheduleNext(intervalMs);
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
    status: () => ({ running, lastRunAt, nextRunAt, intervalMinutes }),
  };
}
