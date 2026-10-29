// Re-notifies alerts nobody has acknowledged.
//
// Alerts fire on transitions, which is what keeps them meaningful: a
// shadowban raises one alert, not one an hour. The cost is that a single
// notification is the only one you ever get, so a webhook delivered at 3am to
// a channel nobody was watching is an alert that effectively never happened —
// and a shadowban is exactly the kind of thing worth hearing about twice.
//
// This pass finds the open ones that have been sitting for a while and sends
// the reminder. Acknowledging an alert in the dashboard ends it.

import { createPeriodicTask } from './periodic.js';

const HOUR = 60 * 60 * 1000;

/**
 * Which open alerts are due for a reminder. Pure, so the rule can be read and
 * tested without a database or a webhook.
 *
 * An alert is due when it is old enough, was not acknowledged, is not merely
 * informational, and has not already been reminded about within the same
 * window. Reminders therefore repeat at most once per window, for as long as
 * the alert stays open.
 */
export function dueForEscalation(alerts, { afterHours, now }) {
  const hours = Number(afterHours);
  if (!Number.isFinite(hours) || hours <= 0) return [];
  const cutoff = now - hours * HOUR;
  return alerts.filter((alert) => {
    if (alert.acknowledged_at) return false;
    if (alert.severity === 'info') return false;
    const created = Date.parse(alert.created_at);
    if (!Number.isFinite(created) || created > cutoff) return false;
    const last = Date.parse(alert.details?.escalated_at ?? '');
    return !Number.isFinite(last) || last <= cutoff;
  });
}

export function createEscalation({ repo, notify, afterHours, log = console, now = () => Date.now() }) {
  let lastRunAt = null;
  let lastCount = 0;

  async function run() {
    const hours = Number(afterHours);
    if (!Number.isFinite(hours) || hours <= 0) return null;
    // Open alerts only, newest first; the cap is generous but bounded, because
    // a workspace that has ignored 500 alerts does not need 500 reminders.
    const open = await repo.listAlerts({ openOnly: true, limit: 200 });
    const due = dueForEscalation(open, { afterHours: hours, now: now() });
    let sent = 0;
    for (const alert of due) {
      // `escalated` changes the message prefix to STILL OPEN, so a reminder
      // does not read as a fresh incident.
      const result = await notify({ ...alert, escalated: true }, alert.account ?? null);
      // Only record the reminder if it actually left the building. A failed
      // send stays due, and the next pass tries again.
      if (result?.sent) {
        await repo.markAlertEscalated(alert.id, alert.details, new Date(now()).toISOString());
        sent++;
      }
    }
    lastRunAt = new Date(now()).toISOString();
    lastCount = sent;
    if (sent > 0) log.log(`Escalation: re-notified ${sent} alert(s) open for more than ${hours}h`);
    return { due: due.length, sent };
  }

  // Half-hourly, so a reminder lands within half an hour of coming due.
  const task = createPeriodicTask({ name: 'Escalation pass', run, firstDelayMs: 2 * 60 * 1000, everyMs: 30 * 60 * 1000, log });

  return {
    run,
    start: task.start,
    stop: task.stop,
    status: () => ({ afterHours: Number(afterHours) || 0, lastRunAt, lastCount }),
  };
}
