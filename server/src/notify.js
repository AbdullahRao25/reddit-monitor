// Pushes warning/critical alerts to a Discord or Slack incoming webhook.
// Discord reads `content`, Slack reads `text`; each ignores the other key.
export function createNotifier({ webhookUrl, fetchImpl = fetch, log = console }) {
  return async function notify(alert) {
    if (!webhookUrl || alert.severity === 'info') return;
    const text = `[${alert.severity.toUpperCase()}] ${alert.message}`;
    try {
      const res = await fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text, text }),
        // The checker awaits this; a webhook that never answers must not stall every check.
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) log.warn(`Alert webhook answered HTTP ${res.status}`);
    } catch (err) {
      log.warn(`Alert webhook failed: ${err.message}`);
    }
  };
}
