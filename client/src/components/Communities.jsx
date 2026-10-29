import React, {useCallback, useEffect, useState} from 'react';
import {api, breakdownLabel as label, percent as pct} from '../lib/api.js';
import Icon from './Icon.jsx';

// Which communities are removing this account's content.
//
// The dashboard could already tell you that 20% of your posts were removed.
// It could not tell you whether that was one subreddit's rule or a problem
// with the account, and those call for completely different responses — so
// the first thing this panel says is which of the two it is.

const WINDOWS = [[30, '30 days'], [90, '90 days'], [180, '6 months'], [365, '1 year']];

const when = (value) => (value ? new Date(value).toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'}) : '—');

// How a removal rate reads at a glance. The thresholds mirror risk.js's
// removal_rate factor rather than inventing a second opinion.
function tone(row) {
  if (row.removed === 0) return 'healthy';
  if (row.thin_sample) return 'warning';
  if (row.removal_rate >= 0.5) return 'critical';
  if (row.removal_rate >= 0.2) return 'danger';
  return 'warning';
}

// The sentence that answers "so what?". Concentration is the whole point: the
// same removal rate means different things depending on where it comes from.
function verdict(summary) {
  if (!summary || summary.items === 0) return ['No content tracked yet in this window.', 'neutral'];
  if (summary.removed === 0) return [`Nothing removed across ${summary.subreddits} ${summary.subreddits === 1 ? 'community' : 'communities'}.`, 'healthy'];
  const share = Math.round((summary.share ?? 0) * 100);
  if (summary.subreddits === 1) return [`All ${summary.removed} removals are in ${label(summary.worst)} — the only community tracked here.`, 'warning'];
  if (share >= 70) {
    return [`${share}% of removals come from ${label(summary.worst)} alone. Read that community's rules before posting there again.`, 'warning'];
  }
  if (share <= 40) {
    return [`Removals are spread across ${summary.subreddits} communities, so this looks like the account rather than one subreddit's rule.`, 'critical'];
  }
  return [`${label(summary.worst)} accounts for ${share}% of removals, with the rest spread across other communities.`, 'danger'];
}

export default function Communities({accountId, demo = false, demoData = null}) {
  const [days, setDays] = useState(90);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    if (demo) { setData(demoData); return; }
    if (!accountId) return;
    setLoading(true);
    api.subreddits(accountId, {days})
      .then((res) => { setData(res); setError(null); })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [accountId, days, demo, demoData]);

  useEffect(load, [load]);

  const rows = data?.subreddits ?? [];
  const [sentence, sentenceTone] = verdict(data?.summary);

  return (
    <div className="detail-grid">
      <section className="panel span-all">
        <div className="panel-head">
          <div>
            <h3>Removals by community</h3>
            <p>Where this account's content is being removed, from the items checks have seen.</p>
          </div>
          <div className="table-toolbar">
            {!demo && (
              <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Time window">
                {WINDOWS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
              </select>
            )}
            <button type="button" className="btn btn-outline btn-sm" onClick={load} disabled={loading || demo}>
              <Icon name="refresh" size={15} className={loading ? 'spin' : ''} /><span>Refresh</span>
            </button>
          </div>
        </div>

        {error && <p className="preventer-warning">{error}</p>}

        {rows.length > 0 && (
          <p className={`pill pill-${sentenceTone} panel-verdict`}>
            <Icon name={sentenceTone === 'healthy' ? 'circleCheck' : 'activity'} size={13} /><span>{sentence}</span>
          </p>
        )}

        {rows.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon"><Icon name="file" size={25} /></span>
            <h3>Nothing tracked yet</h3>
            <p>Run a check for this account. Content only appears here once a check has seen it.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Community</th>
                  <th>Items</th>
                  <th>Posts / comments</th>
                  <th>Removed</th>
                  <th>Rate</th>
                  <th>By mods</th>
                  <th>Site-wide</th>
                  <th>Last removal</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.subreddit}>
                    <td><strong>{label(row.subreddit)}</strong></td>
                    <td>{row.items}{row.undated > 0 && <small className="muted-note"> ({row.undated} undated)</small>}</td>
                    <td>{row.posts} / {row.comments}</td>
                    <td>{row.removed}</td>
                    <td>
                      <span className={`pill pill-${tone(row)}`}>
                        {/* A rate needs a sample: one removal out of two posts is one removal. */}
                        <span>{row.thin_sample ? 'thin sample' : pct(row.removal_rate)}</span>
                      </span>
                    </td>
                    <td>{row.removed_by_mod || '—'}</td>
                    {/* Spam filter and admin removals are the ones that tend to precede a shadowban. */}
                    <td>{row.removed_sitewide || '—'}</td>
                    <td>{when(row.last_removal_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="muted-note">
          Counts come from the items checks have stored, not from Reddit's own records: a very active account's
          first checks undercount, and the window only covers what was seen.
          {demo && ' Demo mode shows sample data.'}
        </p>
      </section>
    </div>
  );
}
