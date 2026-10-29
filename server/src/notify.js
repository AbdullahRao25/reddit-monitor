// Pushes warning/critical alerts to a Discord or Slack incoming webhook.
// Discord reads `content`, Slack reads `text`; each ignores the other key.
//
// A webhook POST is the only way an alert leaves this process, so one that
// fails is an alert nobody hears about. Transient failures are retried; a
// rejection that will not fix itself (a deleted webhook, a malformed URL) is
// not, because retrying it only delays the check behind it.

const RETRYABLE_STATUS = (status) => status === 408 || status === 429 || status >= 500;
// Three tries over about four seconds. The checker awaits this, so the budget
// is deliberately small: a webhook outage must not stall every check.
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 4_000;

// Discord and Slack both answer 429 with the wait in Retry-After (seconds, or
// an HTTP date). Honouring it is the difference between backing off and being
// rate-limited harder.
function retryAfterMs(res) {
  const header = res.headers?.get?.('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(MAX_BACKOFF_MS, Math.max(0, seconds * 1000));
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.min(MAX_BACKOFF_MS, Math.max(0, at - Date.now())) : null;
}

export function createNotifier({
  webhookUrl,
  fetchImpl = fetch,
  log = console,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  /**
   * Sends one alert. Never throws: the caller is a check in progress, and a
   * webhook problem is not a reason to lose the check's results.
   *
   * Returns { sent, attempts, status, error } so an escalation pass can tell
   * whether the reminder actually went out.
   */
  return async function notify(alert, account = null) {
    if (!webhookUrl || alert.severity === 'info') return { sent: false, skipped: true, attempts: 0 };
    const who = account?.username ? ` u/${account.username}` : '';
    const prefix = alert.escalated ? 'STILL OPEN' : alert.severity.toUpperCase();
    const text = `[${prefix}]${who} ${alert.message}`;

    let last = { sent: false, attempts: 0, status: null, error: null };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      last.attempts = attempt;
      try {
        const res = await fetchImpl(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: text, text }),
          // A webhook that never answers must not stall the check behind it.
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return { sent: true, attempts: attempt, status: res.status, error: null };
        last = { sent: false, attempts: attempt, status: res.status, error: `HTTP ${res.status}` };
        if (!RETRYABLE_STATUS(res.status)) {
          // 403/404 means the webhook is gone or wrong. Say so once, plainly,
          // instead of retrying a URL that will answer the same way.
          log.warn(`Alert webhook rejected the alert (HTTP ${res.status}); check ALERT_WEBHOOK_URL.`);
          return last;
        }
        if (attempt < MAX_ATTEMPTS) await sleep(retryAfterMs(res) ?? backoff(attempt));
      } catch (err) {
        last = { sent: false, attempts: attempt, status: null, error: err.message };
        if (attempt < MAX_ATTEMPTS) await sleep(backoff(attempt));
      }
    }
    log.warn(`Alert webhook failed after ${last.attempts} attempts: ${last.error}`);
    return last;
  };
}

function backoff(attempt) {
  // Exponential, with jitter so several alerts failing at once do not retry in
  // lockstep against a webhook that is already struggling.
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
  return ceiling / 2 + Math.random() * (ceiling / 2);
}
