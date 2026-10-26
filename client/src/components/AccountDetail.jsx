import { useMemo, useState } from 'react';
import { api } from '../api.js';
import { compact, formatDate, formatDateTime, formatNumber, timeAgo } from '../format.js';
import { navigate, usePolling } from '../hooks.js';
import { PRIORITY_META, REMOVAL_META, STATUS_META, STEALTH_META } from '../meta.js';
import { AlertList } from './Alerts.jsx';
import { LineChart } from './LineChart.jsx';
import { Badge, Button, ErrorNote, ExternalLink, Icon, RiskBadge, RiskMeter, StatusBadge } from './ui.jsx';

const RISK_TICKS = [0, 25, 50, 75, 100];
const RISK_DOMAIN = [0, 100];

const pollInterval = (data) =>
  data?.account?.checking || data?.account?.status === 'pending' ? 4000 : 30000;

function BackLink() {
  return (
    <a className="back-link" href="#/">
      <Icon name="arrowLeft" /> All accounts
    </a>
  );
}

export function AccountDetail({ id, onAlertsChanged }) {
  const detail = usePolling(() => api.account(id), pollInterval);
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [view, setView] = useState('charts');

  const history = detail.data?.history;
  const riskPoints = useMemo(
    () =>
      (history ?? [])
        .filter((h) => h.risk_score !== null)
        .map((h) => ({ t: Date.parse(h.checked_at), v: h.risk_score })),
    [history],
  );
  const karmaPoints = useMemo(
    () =>
      (history ?? [])
        .filter((h) => h.link_karma !== null && h.comment_karma !== null)
        .map((h) => ({ t: Date.parse(h.checked_at), v: h.link_karma + h.comment_karma })),
    [history],
  );

  if (!detail.data) {
    return (
      <div className="detail">
        <BackLink />
        {detail.error ? (
          <section className="panel">
            <ErrorNote
              error={
                detail.error.status === 404
                  ? new Error('This account is not being monitored any more.')
                  : detail.error
              }
            />
          </section>
        ) : (
          <p className="empty">Loading…</p>
        )}
      </div>
    );
  }

  const { account, latestCheck, lastError, removed, alerts } = detail.data;

  async function run(kind, action) {
    setBusy(kind);
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(null);
    }
  }

  const checkNow = () =>
    run('check', async () => {
      await api.checkAccount(id);
      await Promise.all([detail.refresh(), onAlertsChanged()]);
    });

  const togglePause = () =>
    run('pause', async () => {
      await api.updateAccount(id, { paused: !account.paused });
      await detail.refresh();
    });

  const remove = () => {
    if (!window.confirm(`Stop monitoring u/${account.username}? Its history and alerts will be deleted.`)) return;
    run('delete', async () => {
      await api.deleteAccount(id);
      await onAlertsChanged();
      navigate('/');
    });
  };

  const checking = account.checking || busy === 'check';

  return (
    <div className="detail">
      <BackLink />

      <section className="panel detail-head">
        <div className="detail-id">
          <h1>u/{account.username}</h1>
          <div className="detail-tags">
            <StatusBadge status={account.status} />
            {account.stealth_mode && (
              <Badge tone="neutral" icon="fingerprint">
                Stealth
              </Badge>
            )}
            {account.paused && (
              <Badge tone="neutral" icon="pause">
                Monitoring paused
              </Badge>
            )}
            {account.label && <span className="label-chip">{account.label}</span>}
            <ExternalLink href={`https://www.reddit.com/user/${account.username}`}>Profile</ExternalLink>
          </div>
          <p className="muted small">
            {checking ? (
              <span className="checking">
                <span className="spinner" aria-hidden="true" /> Checking now…
              </span>
            ) : (
              <>Last checked {timeAgo(account.last_checked_at)}</>
            )}
            {account.last_seen_active_at && ` · last seen publicly visible ${timeAgo(account.last_seen_active_at)}`}
          </p>
        </div>

        <div className="detail-score">
          <span className="hero-figure">
            {account.risk_score ?? '—'}
            <span className="hero-unit">/100</span>
          </span>
          <RiskBadge level={account.risk_level} />
        </div>

        <div className="detail-actions">
          <Button variant="primary" icon="refresh" busy={checking} onClick={checkNow}>
            Check now
          </Button>
          <Button icon={account.paused ? 'play' : 'pause'} busy={busy === 'pause'} onClick={togglePause}>
            {account.paused ? 'Resume monitoring' : 'Pause monitoring'}
          </Button>
          <Button
            icon="fingerprint"
            busy={busy === 'stealth'}
            onClick={() =>
              run('stealth', async () => {
                await api.updateAccount(id, { stealth_mode: !account.stealth_mode });
                await detail.refresh();
              })
            }
          >
            {account.stealth_mode ? 'Disable stealth' : 'Enable stealth'}
          </Button>
          <Button variant="danger" icon="trash" busy={busy === 'delete'} onClick={remove}>
            Remove
          </Button>
        </div>

        <div className="detail-notes">
          <ErrorNote error={actionError ?? detail.error} />
          {lastError && (
            <p className="note note-warn">
              <Icon name="alert" />
              <span>
                The last check ({timeAgo(lastError.checked_at)}) failed: {lastError.error}. Showing the last
                successful check below.
              </span>
            </p>
          )}
        </div>
      </section>

      {latestCheck ? (
        <div className="detail-grid">
          <section className="panel">
            <h2>What to do</h2>
            <Recommendations items={latestCheck.recommendations} />
          </section>
          <section className="panel">
            <h2>Why this score</h2>
            <Factors items={latestCheck.factors} />
            {latestCheck.status === 'active' && (
              <p className="muted small">
                Based on {latestCheck.items_sampled} posts and comments from the last 30 days, checked{' '}
                {formatDateTime(latestCheck.checked_at)}.
              </p>
            )}
          </section>
        </div>
      ) : (
        <section className="panel">
          <p className="empty">
            {checking
              ? 'The first check is running. Results appear here in a few seconds.'
              : 'No completed check yet.'}
          </p>
        </section>
      )}

      <section className="panel">
        <div className="panel-head">
          <h2>History</h2>
          <div className="segmented" role="group" aria-label="History view">
            <button type="button" aria-pressed={view === 'charts'} onClick={() => setView('charts')}>
              Charts
            </button>
            <button type="button" aria-pressed={view === 'table'} onClick={() => setView('table')}>
              Table
            </button>
          </div>
        </div>
        {view === 'charts' ? (
          <div className="charts">
            <LineChart
              title="Risk score"
              description="0 to 100, higher is riskier"
              points={riskPoints}
              yDomain={RISK_DOMAIN}
              yTicks={RISK_TICKS}
              formatValue={(v) => `${v} / 100`}
              formatTick={String}
            />
            <LineChart
              title="Total karma"
              description="Post + comment karma"
              points={karmaPoints}
              formatValue={(v) => v.toLocaleString()}
              formatTick={compact}
            />
          </div>
        ) : (
          <HistoryTable history={history} />
        )}
      </section>

      <section className="panel">
        <h2>Removed posts and comments</h2>
        <RemovedList items={removed} />
      </section>

      <section className="panel">
        <h2>Alerts for this account</h2>
        <AlertList
          alerts={alerts}
          onChanged={async () => {
            await Promise.all([detail.refresh(), onAlertsChanged()]);
          }}
          showAccount={false}
          emptyText="No alerts for this account yet."
        />
      </section>

      {account.stealth_mode && (
        <StealthPanel
          key={account.id}
          account={account}
          earlyRisk={latestCheck?.early_risk ?? null}
          earlyFactors={(latestCheck?.factors ?? []).filter((factor) => factor.key.startsWith('early_'))}
          onSaved={detail.refresh}
        />
      )}

      <NotesForm key={account.id} account={account} onSaved={detail.refresh} />
    </div>
  );
}

function Recommendations({ items }) {
  if (items.length === 0) {
    return (
      <p className="all-clear tone-good">
        <Icon name="check" size={18} />
        Nothing to do right now.
      </p>
    );
  }
  return (
    <ol className="recs">
      {items.map((rec) => {
        const meta = PRIORITY_META[rec.priority] ?? PRIORITY_META.normal;
        return (
          <li key={rec.key} className="rec">
            <Badge tone={meta.tone} icon={meta.icon}>
              {meta.label}
            </Badge>
            <h3>{rec.title}</h3>
            <p>{rec.body}</p>
            {rec.links?.map((link) => (
              <ExternalLink key={link.url} href={link.url}>
                {link.label}
              </ExternalLink>
            ))}
          </li>
        );
      })}
    </ol>
  );
}

function Factors({ items }) {
  if (items.length === 0) return <p className="empty">No risk factors found.</p>;
  return (
    <ul className="factors">
      {items.map((factor) => (
        <li key={factor.key} className={factor.points ? undefined : 'factor-zero'}>
          <div className="factor-head">
            <span>{factor.label}</span>
            <span className="factor-points">{factor.points ? `+${factor.points}` : '0'}</span>
          </div>
          <p>{factor.detail}</p>
        </li>
      ))}
    </ul>
  );
}

function HistoryTable({ history }) {
  if (!history?.length) return <p className="empty">No completed checks yet.</p>;
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>Checked</th>
            <th>Status</th>
            <th className="num">Risk</th>
            <th className="num">Karma</th>
            <th className="num">Removed (30 days)</th>
          </tr>
        </thead>
        <tbody>
          {[...history].reverse().map((row) => (
            <tr key={row.checked_at}>
              <td>{formatDateTime(row.checked_at)}</td>
              <td>{STATUS_META[row.status]?.label ?? row.status}</td>
              <td className="num">{row.risk_score ?? '—'}</td>
              <td className="num">
                {row.link_karma === null ? '—' : formatNumber(row.link_karma + row.comment_karma)}
              </td>
              <td className="num">{row.items_sampled ? `${row.items_removed} of ${row.items_sampled}` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RemovedList({ items }) {
  if (items.length === 0) {
    return <p className="empty">Nothing removed among the posts and comments checked so far.</p>;
  }
  return (
    <ul className="content-list">
      {items.map((item) => {
        const meta = REMOVAL_META[item.removal_status] ?? REMOVAL_META.removed;
        return (
          <li key={item.id}>
            <div className="content-meta">
              <Badge tone={meta.tone} icon={meta.icon} title="Who removed it">
                {meta.label}
              </Badge>
              <span>
                {item.kind === 'post' ? 'Post' : 'Comment'} in r/{item.subreddit}
              </span>
              <span>posted {formatDate(item.created_at)}</span>
              {item.removal_detected_at && <span>removal seen {timeAgo(item.removal_detected_at)}</span>}
            </div>
            {item.title && (
              <p className="content-title">
                {item.kind === 'comment' && <span className="muted">On: </span>}
                {item.title}
              </p>
            )}
            {item.excerpt && <p className="content-excerpt">{item.excerpt}</p>}
            {item.permalink && <ExternalLink href={item.permalink}>Open on Reddit</ExternalLink>}
          </li>
        );
      })}
    </ul>
  );
}

function StealthPanel({ account, earlyRisk = null, earlyFactors = [], onSaved }) {
  const [view, setView] = useState('fingerprint');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  async function run(kind, action) {
    setBusy(kind);
    setError(null);
    try {
      await action();
      await onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel stealth-panel">
      <div className="panel-head">
        <h2>
          <Icon name="fingerprint" size={16} /> Stealth mode
        </h2>
        <div className="segmented" role="group" aria-label="Stealth view">
          <button type="button" aria-pressed={view === 'fingerprint'} onClick={() => setView('fingerprint')}>
            Fingerprint
          </button>
          <button type="button" aria-pressed={view === 'warmup'} onClick={() => setView('warmup')}>
            Warm-up
          </button>
          <button type="button" aria-pressed={view === 'early'} onClick={() => setView('early')}>
            Early risk
          </button>
        </div>
      </div>
      <ErrorNote error={error} />
      {view === 'fingerprint' ? (
        <FingerprintForm account={account} onSaved={onSaved} />
      ) : view === 'early' ? (
        <EarlyRiskPanel earlyRisk={earlyRisk} factors={earlyFactors} />
      ) : (
        <WarmupPanel account={account} onSaved={onSaved} />
      )}
    </section>
  );
}

// Early shadowban risk: signals computed on each check while the account is
// still fully visible, so the account can be fixed before a ban lands.
function EarlyRiskPanel({ earlyRisk, factors }) {
  if (!earlyRisk) {
    return (
      <p className="empty">
        No early-risk data yet. It is computed on every check once stealth mode has run at least one.
      </p>
    );
  }

  return (
    <div>
      <div className="early-risk-head">
        <RiskMeter score={earlyRisk.score} level={earlyRisk.level} />
        <RiskBadge level={earlyRisk.level} />
      </div>
      <p className="muted small">
        Pre-ban signals from the last check. Fix the strongest ones while the account is still
        visible — by the time a shadowban shows up, the damage is done.
      </p>

      {earlyRisk.top && (
        <div className="early-risk-top">
          <p className="small">
            <strong>Strongest signal: </strong>
            {earlyRisk.top.label} (+{earlyRisk.top.points})
          </p>
        </div>
      )}

      {factors.length > 0 && (
        <ul className="early-risk-signals">
          {factors.map((factor) => (
            <li key={factor.key} title={factor.detail ?? null}>
              <span>{factor.label}</span>
              <Badge tone="neutral" icon={factor.points > 10 ? 'alert' : 'info'}>
                +{factor.points}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FingerprintForm({ account, onSaved }) {
  const [ua, setUa] = useState(account.fingerprint?.userAgent ?? '');
  const [tz, setTz] = useState(account.fingerprint?.timezone ?? '');
  const [viewport, setViewport] = useState(account.fingerprint?.viewport ?? '');
  const [locale, setLocale] = useState(account.fingerprint?.locale ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const dirty =
    ua !== (account.fingerprint?.userAgent ?? '') ||
    tz !== (account.fingerprint?.timezone ?? '') ||
    viewport !== (account.fingerprint?.viewport ?? '') ||
    locale !== (account.fingerprint?.locale ?? '');

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.saveFingerprint(account.id, { userAgent: ua, timezone: tz, viewport, locale });
      await onSaved();
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="notes-form" onSubmit={save}>
      <p className="muted small">
        The fingerprint is what the dashboard shows when it simulates this account's browser environment.
        Keep it consistent with where you actually post from.
      </p>
      <label className="field">
        <span>User-Agent</span>
        <input
          value={ua}
          onChange={(e) => {
            setUa(e.target.value);
            setSaved(false);
          }}
          placeholder="Mozilla/5.0 (Windows NT 10.0; Win64; x64)…"
          maxLength={300}
          required
        />
      </label>
      <label className="field">
        <span>Timezone (IANA)</span>
        <input
          value={tz}
          onChange={(e) => {
            setTz(e.target.value);
            setSaved(false);
          }}
          placeholder="America/New_York"
          maxLength={100}
          required
        />
      </label>
      <div className="field-row">
        <label className="field">
          <span>Viewport</span>
          <input
            value={viewport}
            onChange={(e) => {
              setViewport(e.target.value);
              setSaved(false);
            }}
            placeholder="1920x1080"
            maxLength={10}
            required
          />
        </label>
        <label className="field">
          <span>Locale</span>
          <input
            value={locale}
            onChange={(e) => {
              setLocale(e.target.value);
              setSaved(false);
            }}
            placeholder="en-US"
            maxLength={10}
            required
          />
        </label>
      </div>
      <div className="form-actions">
        <Button type="submit" variant="primary" busy={busy} disabled={!dirty}>
          Save fingerprint
        </Button>
        {saved && !dirty && <span className="muted small">Saved</span>}
      </div>
      <ErrorNote error={error} />
    </form>
  );
}

function WarmupPanel({ account, onSaved }) {
  const [log, setLog] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const plan = account.fingerprint?.warmup ?? null;

  async function refresh() {
    try {
      const data = await api.getWarmupLog(account.id);
      setLog(data);
    } catch (err) {
      setError(err);
    }
  }

  async function run(kind, action) {
    setBusy(kind);
    setError(null);
    try {
      await action();
      await onSaved();
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  const progress = log?.progress ?? (plan ? Math.round((plan.actions_done / plan.actions_target) * 100) : 0);

  return (
    <div>
      <ErrorNote error={error} />
      {log ? null : <p className="empty">Loading warm-up status…</p>}

      {plan && (
        <div className="warmup-progress">
          <div className="meter tone-neutral" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
            <span style={{ width: `${Math.max(progress, 2)}%` }} />
          </div>
          <p className="muted small">
            {plan.actions_done} of {plan.actions_target} actions done ({progress}%)
            {plan.target_at && ` · target date ${formatDate(plan.target_at)}`}
          </p>
        </div>
      )}

      <div className="warmup-actions">
        {!plan && (
          <Button variant="primary" icon="play" busy={busy === 'start'} onClick={() => run('start', () => api.startWarmup(account.id))}>
            Start warm-up
          </Button>
        )}
        {plan && plan.actions_done < plan.actions_target && (
          <Button
            icon="check"
            busy={busy === 'action'}
            onClick={() =>
              run('action', async () => {
                const actions = ['upvote', 'comment', 'browse_sub', 'view_profile'];
                const action = actions[Math.floor(Math.random() * actions.length)];
                await api.recordWarmupAction(account.id, action);
              })
            }
          >
            Record action
          </Button>
        )}
        {plan && (
          <Button icon="trash" busy={busy === 'clear'} onClick={() => run('clear', () => api.clearWarmup(account.id))}>
            Clear plan
          </Button>
        )}
        {plan && plan.actions_done >= plan.actions_target && (
          <Badge tone="good" icon="check">
            Complete
          </Badge>
        )}
      </div>

      {log?.log?.length > 0 && (
        <ul className="warmup-log">
          {log.log.slice(0, 10).map((row) => (
            <li key={row.id}>
              <span className="muted small">{timeAgo(row.performed_at)}</span>
              <span>{row.action}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NotesForm({ account, onSaved }) {
  const [label, setLabel] = useState(account.label ?? '');
  const [notes, setNotes] = useState(account.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const dirty = label !== (account.label ?? '') || notes !== (account.notes ?? '');

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.updateAccount(account.id, { label, notes });
      await onSaved();
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>Label and notes</h2>
      <form className="notes-form" onSubmit={save}>
        <label className="field">
          <span>Label</span>
          <input
            value={label}
            onChange={(e) => {
              setLabel(e.target.value);
              setSaved(false);
            }}
            maxLength={60}
          />
        </label>
        <label className="field">
          <span>Notes (only visible here)</span>
          <textarea
            value={notes}
            onChange={(e) => {
              setNotes(e.target.value);
              setSaved(false);
            }}
            maxLength={1000}
            rows={3}
          />
        </label>
        <div className="form-actions">
          <Button type="submit" variant="primary" busy={busy} disabled={!dirty}>
            Save
          </Button>
          {saved && !dirty && <span className="muted small">Saved</span>}
        </div>
        <ErrorNote error={error} />
      </form>
    </section>
  );
}
