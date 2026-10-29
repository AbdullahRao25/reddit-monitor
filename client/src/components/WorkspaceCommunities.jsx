import React, {useEffect, useState} from 'react';
import {api, breakdownLabel as label, percent as pct} from '../lib/api.js';
import Icon from './Icon.jsx';

// The workspace-wide version of the account breakdown.
//
// A subreddit that removes content from one account is that account's problem
// there. A subreddit that removes content from several monitored accounts is
// either a strict community or — read the other way — a pattern a moderator
// could notice too, which is why the accounts it touches are named.


export default function WorkspaceCommunities({demo = false, demoRows = []}) {
  const [rows, setRows] = useState(demo ? demoRows : null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (demo) { setRows(demoRows); return; }
    let live = true;
    api.allSubreddits({days: 90})
      .then((res) => { if (live) { setRows(res.subreddits ?? []); setError(null); } })
      .catch((err) => { if (live) setError(err.message); });
    return () => { live = false; };
  }, [demo, demoRows]);

  // Only the ones with removals are worth the space on an overview.
  const worth = (rows ?? []).filter((row) => row.removed > 0).slice(0, 5);

  return (
    <section className="panel list-panel">
      <div className="panel-head">
        <div>
          <h3>Communities removing content</h3>
          <p>Across every monitored account, last 90 days. Open an account's Communities tab for its own breakdown.</p>
        </div>
      </div>
      {error && <p className="preventer-warning">{error}</p>}
      {worth.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon"><Icon name="circleCheck" size={25} /></span>
          <h3>{rows === null ? 'Loading…' : 'No removals tracked'}</h3>
          <p>{rows === null ? 'Reading the breakdown.' : 'No community has removed tracked content in this window.'}</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>COMMUNITY</th><th>REMOVED</th><th>RATE</th><th>SITE-WIDE</th><th>ACCOUNTS HIT</th></tr>
            </thead>
            <tbody>
              {worth.map((row) => (
                <tr key={row.subreddit}>
                  <td><strong>{label(row.subreddit)}</strong></td>
                  <td><b>{row.removed}</b> <small className="muted-note">of {row.items}</small></td>
                  <td>{row.thin_sample ? <small className="muted-note">thin sample</small> : pct(row.removal_rate)}</td>
                  {/* Spam-filter and admin removals are the ones that tend to come before a shadowban. */}
                  <td>{row.removed_sitewide || '—'}</td>
                  <td>
                    {row.accounts_with_removals > 1
                      ? <span className="pill pill-warning"><span>{row.accounts_with_removals} accounts</span></span>
                      : <small>u/{row.accounts.find((a) => a.removed > 0)?.username ?? '—'}</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
