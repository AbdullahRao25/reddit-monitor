import { useEffect, useRef, useState } from 'react';

const BASE_TITLE = 'Reddit Account Health';

/**
 * Raises desktop notifications for warning/critical alerts that appear while
 * the dashboard is open, and puts the open-alert count in the tab title.
 * Alerts that were already open when the page loaded don't notify again.
 */
export function useAlertAlarms(openAlerts) {
  const seen = useRef(null);
  const [permission, setPermission] = useState(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );

  useEffect(() => {
    if (!openAlerts) return;
    const ids = openAlerts.map((alert) => alert.id);
    if (seen.current === null) {
      seen.current = new Set(ids);
      return;
    }
    const fresh = openAlerts.filter((alert) => !seen.current.has(alert.id) && alert.severity !== 'info');
    for (const id of ids) seen.current.add(id);

    if (permission !== 'granted') return;
    for (const alert of fresh) {
      const notification = new Notification(
        alert.severity === 'critical' ? 'Critical: Reddit account alert' : 'Reddit account warning',
        { body: alert.message, tag: alert.id, requireInteraction: alert.severity === 'critical' },
      );
      notification.onclick = () => {
        window.focus();
        window.location.hash = `/accounts/${alert.account_id}`;
      };
    }
  }, [openAlerts, permission]);

  useEffect(() => {
    const count = openAlerts?.length ?? 0;
    document.title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
  }, [openAlerts]);

  async function requestPermission() {
    if (permission === 'unsupported') return;
    setPermission(await Notification.requestPermission());
  }

  return { permission, requestPermission };
}
