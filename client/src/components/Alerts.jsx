import { useState } from 'react';
import { api } from '../api.js';
import { timeAgo } from '../format.js';
import { SEVERITY_META } from '../meta.js';
import { Badge, Button, ErrorNote, Icon } from './ui.jsx';

export function AlertList({ alerts, onChanged, showAccount = true, emptyText }) {
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);

  async function acknowledge(id) {
    setBusyId(id);
    setError(null);
    try {
      await api.ackAlert(id);
      await onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusyId(null);
    }
  }

  if (alerts.length === 0) return <p className="empty">{emptyText}</p>;

  return (
    <>
      <ErrorNote error={error} />
      <ul className="alert-list">
        {alerts.map((alert) => {
          const meta = SEVERITY_META[alert.severity] ?? SEVERITY_META.info;
          return (
            <li key={alert.id} className={`alert-item${alert.acknowledged_at ? ' is-acked' : ''}`}>
              <div className="alert-meta">
                <Badge tone={meta.tone} icon={meta.icon}>
                  {meta.label}
                </Badge>
                {showAccount && alert.account?.username && (
                  <a href={`#/accounts/${alert.account_id}`}>u/{alert.account.username}</a>
                )}
                <time dateTime={alert.created_at} title={new Date(alert.created_at).toLocaleString()}>
                  {timeAgo(alert.created_at)}
                </time>
              </div>
              <p className="alert-message">{alert.message}</p>
              {alert.acknowledged_at ? (
                <span className="alert-acked">
                  <Icon name="check" size={14} /> Acknowledged {timeAgo(alert.acknowledged_at)}
                </span>
              ) : (
                <Button busy={busyId === alert.id} onClick={() => acknowledge(alert.id)}>
                  Acknowledge
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

export function AlertsPanel({ alerts, error, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [ackError, setAckError] = useState(null);

  async function acknowledgeAll() {
    setBusy(true);
    setAckError(null);
    try {
      await api.ackAllAlerts();
      await onChanged();
    } catch (err) {
      setAckError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel alerts-panel" aria-labelledby="alerts-heading">
      <div className="panel-head">
        <h2 id="alerts-heading">
          <Icon name="bell" /> Open alerts
        </h2>
        {alerts?.length > 1 && (
          <Button busy={busy} onClick={acknowledgeAll}>
            Acknowledge all
          </Button>
        )}
      </div>
      <ErrorNote error={error ?? ackError} />
      {alerts ? (
        <AlertList
          alerts={alerts}
          onChanged={onChanged}
          emptyText="No open alerts. Shadowbans, suspensions, spam-filter removals and risk jumps show up here."
        />
      ) : (
        !error && <p className="empty">Loading alerts…</p>
      )}
    </section>
  );
}

// Shown on every page while a critical alert is open.
export function CriticalBanner({ alerts }) {
  const critical = (alerts ?? []).filter((alert) => alert.severity === 'critical');
  if (critical.length === 0) return null;
  const [first] = critical;
  return (
    <div className="critical-banner" role="alert">
      <Icon name="octagon" size={20} />
      <div>
        <strong>
          {critical.length === 1 ? '1 critical alert' : `${critical.length} critical alerts`}
        </strong>
        <span>
          {first.message}
          {critical.length > 1 && ` (+${critical.length - 1} more)`}
        </span>
      </div>
      <a className="btn btn-secondary" href={`#/accounts/${first.account_id}`}>
        Review
      </a>
    </div>
  );
}
