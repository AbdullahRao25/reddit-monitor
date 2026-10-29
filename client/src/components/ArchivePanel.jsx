import React, {useCallback, useEffect, useState} from 'react';
import Icon from './Icon.jsx';
import {api} from '../lib/api.js';

// Recovered history for an account whose public pages are gone.
//
// A shadowbanned or banned account answers 404 or a ban notice to logged-out
// visitors, so the monitor's own reader can no longer see its posts and
// comments -- which is exactly when you need to know what it was doing. These
// rows come from a third-party public archive that copied the content while it
// was still visible, and the panel says so rather than presenting them as
// Reddit's records.

const when = value => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(undefined, {year:'numeric', month:'short', day:'numeric'});
};

// Who removed it. 'reddit' is the one that matters on a dead account: a
// site-wide action by Reddit itself, not a subreddit moderator.
const removal = row => {
  if (!row.removed_by_category) return {tone:'healthy', label:'Visible when archived'};
  if (row.removed_by_category === 'reddit') return {tone:'critical', label:'Removed by Reddit'};
  if (['author', 'deleted'].includes(row.removed_by_category)) return {tone:'neutral', label:'Deleted by author'};
  return {tone:'warning', label:`Removed by ${row.removed_by_category}`};
};

// The headline an operator should read first.
function verdict(summary) {
  if (!summary?.items) return null;
  if (summary.site_removed > 0) return ['critical',
    `Reddit removed ${summary.site_removed} item${summary.site_removed === 1 ? '' : 's'} site-wide — an action by Reddit itself, not a subreddit moderator.`];
  if (summary.mod_removed > 0) return ['warning',
    `${summary.mod_removed} item${summary.mod_removed === 1 ? ' was' : 's were'} removed by subreddit moderators.`];
  return ['healthy', 'Everything recovered was still visible when the archive copied it.'];
}

// Long post titles and comment bodies are clamped so one row cannot stretch
// the table; the row opens on click for the full text.
function Said({row}) {
  const [open, setOpen] = useState(false);
  const text = row.title || row.body || row.item_id;
  const long = String(text).length > 110;
  return <div className="archive-said">
    <div className={open ? 'archive-text is-open' : 'archive-text'}>
      {row.permalink
        ? <a href={row.permalink} target="_blank" rel="noreferrer">{text}</a>
        : text}
    </div>
    {row.title && row.body && row.body !== '[removed]' && open &&
      <p className="archive-body">{row.body}</p>}
    {long && <button type="button" className="archive-more" onClick={() => setOpen(v => !v)}>
      {open ? 'Show less' : 'Show more'}
    </button>}
  </div>;
}

export default function ArchivePanel({account, demo = false, onToast}) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (demo) return;
    setLoading(true);
    try { setData(await api.archive(account.id)); setError(''); }
    catch (err) { setError(err?.message || 'Could not load recovered history.'); }
    finally { setLoading(false); }
  }, [account.id, demo]);

  useEffect(() => {load();}, [load]);

  const recover = async () => {
    setBusy(true); setError('');
    try {
      const result = await api.recoverArchive(account.id);
      setData(result);
      onToast?.(result.recovered > 0
        ? `Recovered ${result.recovered} item${result.recovered === 1 ? '' : 's'} for u/${account.username}.`
        : 'The archive returned nothing for this account. Anything recovered earlier was kept.');
    } catch (err) {
      setError(err?.message || 'Could not reach the history archive.');
    } finally { setBusy(false); }
  };

  const clear = async () => {
    setBusy(true); setError('');
    try { await api.clearArchive(account.id); await load(); onToast?.('Recovered history cleared.'); }
    catch (err) { setError(err?.message || 'Could not clear recovered history.'); }
    finally { setBusy(false); }
  };

  const summary = data?.summary;
  const items = data?.items ?? [];
  const sentence = verdict(summary);
  const dark = ['suspended', 'shadowbanned', 'not_found'].includes(account.status);

  return <div className="detail-grid">
    <section className="panel span-all">
      <div className="panel-head">
        <div>
          <h3>Recovered history</h3>
          <p>{dark
            ? 'This account no longer appears in Reddit’s public listings, so the monitor cannot read it. These items were copied from a public archive while they were still visible.'
            : 'Posts and comments copied from a public archive. Worth keeping as a record before an account goes dark.'}</p>
        </div>
        {!demo && <div className="table-toolbar">
          <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={recover}>
            <Icon name="refresh" size={15} className={busy ? 'spin' : ''} /><span>{busy ? 'Recovering…' : 'Recover history'}</span>
          </button>
          {items.length > 0 && <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={clear}>Clear</button>}
        </div>}
      </div>

      {demo && <div className="empty-state">
        <span className="empty-icon"><Icon name="file" size={25} /></span>
        <h3>Not available in demo mode</h3>
        <p>History recovery calls an outside archive, so it is disabled here.</p>
      </div>}

      {!demo && <>
        {error && <p className="preventer-warning">{error}</p>}

        {sentence && <p className={`pill pill-${sentence[0]} panel-verdict`}>
          <Icon name={sentence[0] === 'healthy' ? 'circleCheck' : 'alert'} size={13} /><span>{sentence[1]}</span>
        </p>}

        {summary?.items > 0 && <div className="archive-stats">
          <span><strong>{summary.items}</strong> items</span>
          <span><strong>{summary.posts}</strong> posts</span>
          <span><strong>{summary.comments}</strong> comments</span>
          {summary.first_at && <span>{when(summary.first_at)} – {when(summary.last_at)}</span>}
          {summary.subreddits?.length > 0 && <span className="archive-subs">
            {summary.subreddits.map(s => `r/${s.subreddit} (${s.count})`).join(' · ')}
          </span>}
        </div>}

        {items.length === 0
          ? <div className="empty-state">
              <span className="empty-icon"><Icon name="file" size={25} /></span>
              <h3>{loading ? 'Loading…' : 'Nothing recovered yet'}</h3>
              <p>Use <strong>Recover history</strong> to look this account up in the public archive.</p>
            </div>
          : <div className="table-wrap">
              <table className="data-table archive-table">
                <thead>
                  <tr><th>Posted</th><th>Kind</th><th>Community</th><th>What it said</th><th>Status</th></tr>
                </thead>
                <tbody>{items.map(row => {
                  const flag = removal(row);
                  return <tr key={row.item_id}>
                    <td className="archive-when">{when(row.created_at) ?? '—'}</td>
                    <td>{row.kind}</td>
                    <td>{row.subreddit ? `r/${row.subreddit}` : '—'}</td>
                    <td className="archive-cell"><Said row={row} /></td>
                    <td><span className={`pill pill-${flag.tone}`}>{flag.label}</span></td>
                  </tr>;
                })}</tbody>
              </table>
            </div>}

        {data?.source_note && <p className="muted-note archive-note">{data.source_note}</p>}
      </>}
    </section>
  </div>;
}
