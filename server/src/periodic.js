// A background pass that repeats, and that a failure cannot stop.
//
// The history prune and the alert-escalation pass both want the same thing: do
// this every so often, starting a little after boot, and keep going. Written
// out twice it was also the same bug twice waiting to happen — if the chain is
// re-armed inside the success path, one thrown pass ends the task for the
// lifetime of the process. Here the next run is scheduled whatever happened.
//
// The scheduler does not use this: its loop also jitters the interval, reports
// nextRunAt and guards against overlapping runs, which is a different job.

export function createPeriodicTask({ name, run, firstDelayMs, everyMs, log = console }) {
  let timer = null;

  function scheduleNext(delayMs) {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await run().catch((err) => log.error(`${name} failed: ${err.message}`));
      scheduleNext(everyMs);
    }, delayMs);
    // The HTTP server is what keeps the process alive; a pending prune is not
    // a reason to hold it open, and an unref'd timer lets a script exit.
    timer.unref();
  }

  return {
    start: () => scheduleNext(firstDelayMs),
    stop: () => {
      clearTimeout(timer);
      timer = null;
    },
  };
}
