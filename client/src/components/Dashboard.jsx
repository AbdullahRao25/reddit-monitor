import { useMemo, useState } from 'react';
import { api } from '../api.js';
import { formatNumber, timeAgo } from '../format.js';
import { navigate, usePolling } from '../hooks.js';
import { accountSeverity, STEALTH_META } from '../meta.js';
import { AlertsPanel } from './Alerts.jsx';
import { Badge, Button, ErrorNote, Icon, RiskMeter, StatusBadge } from './ui.jsx';

const isBusy = (data) =>
  Boolean(data?.scheduler?.running || data?.accounts?.some((a) => a.checking || a.status === 'pending'));

function schedulerText(scheduler) {
  if (!scheduler) return '';
  if (scheduler.running) return 'Checking every account now…';
  const next = scheduler.nextRunAt ? ` Next run ${timeAgo(scheduler.nextRunAt)}.` : '';
  return `Every account is re-checked every ${scheduler.intervalMinutes} minutes.${next}`;
}

export function Dashboard({ openAlerts, alertsError, onAlertsChanged }) {
  const accounts = usePolling(api.accounts, (data) => (isBusy(data) ? 4000 : 15000));
  const [checkingAll, setCheckingAll] = useState(false);
  const [rowBusy, setRowBusy] = useState(null);
  const [actionError, setActionError] = useState(null);

  const list = useMemo(
    () =>
      [...(accounts.data?.accounts ?? [])].sort(
        (a, b) => accountSeverity(b) - accountSeverity(a) || a.username.localeCompare(b.username),
      ),
    [accounts.data],
  );
  const scheduler = accounts.data?.scheduler;

  async function checkAll() {
    setCheckingAll(true);
    setActionError(null);
    try {
      await api.checkAll();
      await accounts.refresh();
    } catch (err) {
      setActionError(err);
    } finally {
      setCheckingAll(false);
    }
  }

  async function checkOne(account) {
    setRowBusy(account.id);
    setActionError(null);
    try {
      await api.checkAccount(account.id);
      await Promise.all([accounts.refresh(), onAlertsChanged()]);
    } catch (err) {
      setActionError(new Error(`Check for u/${account.username} failed: ${err.message}`));
    } finally {
      setRowBusy(null);
    }
  }

  return (
    <div className="dashboard">
      <div className="toolbar">
        <div>
          <h1>Accounts</h1>
          <p className="muted">{schedulerText(scheduler)}</p>
        </div>
        <Button
          variant="primary"
          icon="refresh"
          busy={checkingAll || scheduler?.running}
          disabled={list.length === 0}
          onClick={checkAll}
        >
          {scheduler?.running ? 'Checking all…' : 'Check all now'}
        </Button>
      </div>

      <StatRow accounts={accounts.data ? list : null} openAlerts={openAlerts} />

      <div className="dash-grid">
        <section className="panel accounts-panel" aria-labelledby="accounts-heading">
          <div className="panel-head">
            <h2 id="accounts-heading">Monitored accounts</h2>
          </div>
          <AddAccountForm onAdded={accounts.refresh} />
          <ErrorNote error={actionError ?? accounts.error} />
          {accounts.data ? (
            <AccountsTable accounts={list} rowBusy={rowBusy} onCheck={checkOne} />
          ) : (
            !accounts.error && <p className="empty">Loading accounts…</p>
          )}
        </section>
        <AlertsPanel alerts={openAlerts} error={alertsError} onChanged={onAlertsChanged} />
      </div>
    </div>
  );
}

// accounts is null until the first load, so tiles show "—" rather than a misleading 0.
function StatRow({ accounts, openAlerts }) {
  const count = (predicate) => (accounts ? accounts.filter(predicate).length : null);
  const atRisk = count((a) => a.status === 'active' && (a.risk_level === 'high' || a.risk_level === 'critical'));
  const hidden = count((a) => a.status === 'shadowbanned' || a.status === 'suspended');
  const paused = count((a) => a.paused);
  const openCount = openAlerts?.length;
  const hasCritical = openAlerts?.some((alert) => alert.severity === 'critical');

  const tiles = [
    { label: 'Accounts monitored', value: accounts?.length ?? '—', sub: paused ? `${paused} paused` : null },
    { label: 'High or critical risk', value: atRisk ?? '—', tone: atRisk ? 'serious' : null },
    { label: 'Shadowbanned or suspended', value: hidden ?? '—', tone: hidden ? 'critical' : null },
    {
      label: 'Open alerts',
      value: openCount ?? '—',
      tone: hasCritical ? 'critical' : openCount ? 'warning' : null,
    },
  ];

  return (
    <div className="stat-row">
      {tiles.map((tile) => (
        <div key={tile.label} className="stat-tile">
          <span className={`stat-label${tile.tone ? ` tone-${tile.tone}` : ''}`}>
            {tile.tone && <Icon name={tile.tone === 'critical' ? 'octagon' : 'alert'} size={14} />}
            {tile.label}
          </span>
          <span className="stat-value">{tile.value}</span>
          {tile.sub && <span className="stat-sub">{tile.sub}</span>}
        </div>
      ))}
    </div>
  );
}

function AddAccountForm({ onAdded }) {
  const [username, setUsername] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(event) {
    event.preventDefault();
    if (!username.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.addAccount({ username, label });
      setUsername('');
      setLabel('');
      await onAdded();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="add-form" onSubmit={submit}>
      <label className="field">
        <span>Reddit username</span>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="u/username or profile link"
          autoComplete="off"
          spellCheck={false}
          maxLength={80}
          required
        />
      </label>
      <label className="field">
        <span>
          Label <em>(optional)</em>
        </span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Brand account" maxLength={60} />
      </label>
      <Button type="submit" variant="primary" icon="plus" busy={busy}>
        Add account
      </Button>
      <ErrorNote error={error} />
    </form>
  );
}

function AccountsTable({ accounts, rowBusy, onCheck }) {
  if (accounts.length === 0) {
    return <p className="empty">No accounts yet. Add a username above and the first check starts straight away.</p>;
  }

  return (
    <table className="accounts-table">
      <thead>
        <tr>
          <th>Account</th>
          <th>Status</th>
          <th>Risk</th>
          <th className="num">Karma</th>
          <th className="num" title="Removed out of all posts and comments from the last 30 days">
            Removed
          </th>
          <th>Last check</th>
          <th>
            <span className="visually-hidden">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {accounts.map((account) => (
          <tr
            key={account.id}
            className={account.paused ? 'is-paused' : undefined}
            onClick={() => navigate(`/accounts/${account.id}`)}
          >
            <td data-label="Account" className="account-td">
              <div className="account-cell">
                <a className="account-link" href={`#/accounts/${account.id}`} onClick={(e) => e.stopPropagation()}>
                  u/{account.username}
                </a>
                {account.stealth_mode && (
                  <Badge tone="neutral" icon="fingerprint" title="Stealth mode enabled">
                    <Icon name="fingerprint" size={12} />
                  </Badge>
                )}
                {account.label && <span className="account-label">{account.label}</span>}
                {account.open_alerts > 0 && (
                  <span className="alert-count" title={`${account.open_alerts} open alert(s)`}>
                    <Icon name="bell" size={12} />
                    {account.open_alerts}
                  </span>
                )}
              </div>
            </td>
            <td data-label="Status">
              <StatusBadge status={account.status} />
              {account.paused && <span className="muted small"> · paused</span>}
            </td>
            <td data-label="Risk">
              <RiskMeter score={account.risk_score} level={account.risk_level} />
            </td>
            <td data-label="Karma" className="num">
              {account.link_karma === null ? '—' : formatNumber(account.link_karma + account.comment_karma)}
            </td>
            <td data-label="Removed (30 days)" className="num">
              {account.items_sampled ? `${account.items_removed} of ${account.items_sampled}` : '—'}
            </td>
            <td data-label="Last check">
              {account.checking ? (
                <span className="checking">
                  <span className="spinner" aria-hidden="true" /> Checking…
                </span>
              ) : (
                timeAgo(account.last_checked_at)
              )}
            </td>
            <td className="row-actions">
              <Button
                variant="icon"
                icon="refresh"
                busy={rowBusy === account.id || account.checking}
                title="Check now"
                onClick={(e) => {
                  e.stopPropagation();
                  onCheck(account);
                }}
              >
                <span className="visually-hidden">Check u/{account.username} now</span>
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
