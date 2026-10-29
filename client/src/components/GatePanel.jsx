import React, {useCallback, useEffect, useState} from 'react';
import {api, formatDate} from '../lib/api.js';
import Icon from './Icon.jsx';

// The active gate (server/src/stealth/gate.js).
//
// The passive Shield tells you, after the fact, whether something you already
// posted got hit. This is the other half: ask before an action goes out and
// the gate answers pass, hold or block, and says why. A hold is queued and can
// be released by hand when its slot opens; a block is not releasable at all,
// because it means the account needs a person, not a slot.

const ACTIONS = [
  ['comment', 'Comment'],
  ['post', 'Post'],
  ['vote', 'Vote'],
  ['edit', 'Edit'],
  ['message', 'Message'],
];

const VERDICT = {
  pass: ['healthy', 'circleCheck', 'Clear to go out now'],
  hold: ['warning', 'clock', 'Not yet'],
  block: ['critical', 'alert', 'Blocked'],
};

// formatDate's format, but '—' rather than 'Never' for an absent value: a
// blocked action has no slot, and "Never" overstates that in a table.
const when = (value) => (value === null || value === undefined ? '—' : formatDate(value));

const untilNow = (value) => {
  const at = typeof value === 'number' ? value : Date.parse(value ?? '');
  if (!Number.isFinite(at)) return null;
  const minutes = Math.round((at - Date.now()) / 60000);
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `in ${hours} h` : `in ${Math.round(hours / 24)} days`;
};

export default function GatePanel({account, demo = false, onToast = () => {}}) {
  const accountId = account?.id;
  const [action, setAction] = useState('comment');
  const [decision, setDecision] = useState(null);
  const [queue, setQueue] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    if (demo || !accountId) return;
    api.gate(accountId)
      .then((res) => { setQueue(res.queue ?? []); setError(null); })
      .catch((err) => setError(err.message));
  }, [accountId, demo]);

  useEffect(load, [load]);

  const ask = async () => {
    if (demo) { onToast('The gate needs the live API; it is read-only in demo mode.'); return; }
    setBusy(true);
    try {
      const res = await api.gateCheck(accountId, action);
      setDecision(res);
      setError(null);
      load();
    } catch (err) {
      setError(err.message);
      setDecision(null);
    } finally {
      setBusy(false);
    }
  };

  const release = async (row) => {
    if (demo) return;
    try {
      await api.gateRelease(accountId, row.id, 'released by operator');
      onToast(`Released the queued ${row.action}.`);
      load();
    } catch (err) {
      onToast(err.message);
    }
  };

  if (!account?.stealth_mode) {
    return (
      <div className="detail-grid">
        <section className="panel span-all">
          <div className="empty-state">
            <span className="empty-icon"><Icon name="lock" size={25} /></span>
            <h3>The gate is off for this account</h3>
            <p>Turn on advanced mode in Advanced settings to use it. The gate paces one account's actions; it does not change what any other account does.</p>
          </div>
        </section>
      </div>
    );
  }

  const open = queue.filter((row) => !row.released_at);
  const [tone, icon, headline] = VERDICT[decision?.verdict] ?? [];

  return (
    <div className="detail-grid">
      <section className="panel span-all">
        <div className="panel-head">
          <div>
            <h3>Ask the gate</h3>
            <p>Check whether an action can go out right now. Nothing is sent to Reddit — the gate only answers.</p>
          </div>
        </div>
        <div className="table-toolbar">
          <select value={action} onChange={(e) => setAction(e.target.value)} aria-label="Action">
            {ACTIONS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
          </select>
          <button type="button" className="btn btn-primary" onClick={ask} disabled={busy}>
            <Icon name={busy ? 'refresh' : 'shield'} size={17} className={busy ? 'spin' : ''} /><span>Ask the gate</span>
          </button>
        </div>

        {error && <p className="preventer-warning">{error}</p>}

        {decision && (
          <div className="prevention-block gate-decision">
            <p className={`pill pill-${tone}`}><Icon name={icon} size={13} /><span>{headline}</span></p>
            <ul className="prevention-tasks">
              {(decision.reasons ?? []).map((reason, index) => <li key={index}>{reason}</li>)}
            </ul>
            {decision.verdict === 'hold' && (
              <p className="muted-note">
                Queued, so a restart cannot drop it. Slot opens {untilNow(decision.next_safe_at)} ({when(decision.next_safe_at)}).
              </p>
            )}
            {decision.verdict === 'block' && (
              <p className="muted-note">
                A block is not releasable: it carries no token and nothing was queued. Resolve the account's status first.
              </p>
            )}
          </div>
        )}
      </section>

      <section className="panel span-all">
        <div className="panel-head">
          <div>
            <h3>Queue</h3>
            <p>{open.length} waiting, {queue.length - open.length} released.</p>
          </div>
          <button type="button" className="btn btn-outline btn-sm" onClick={load} disabled={demo}>
            <Icon name="refresh" size={15} /><span>Refresh</span>
          </button>
        </div>
        {queue.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon"><Icon name="circleCheck" size={25} /></span>
            <h3>Nothing queued</h3>
            <p>Held actions appear here with the time their slot opens.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>Action</th><th>Asked</th><th>Slot opens</th><th>Why</th><th /></tr>
              </thead>
              <tbody>
                {queue.map((row) => (
                  <tr key={row.id}>
                    <td><strong>{row.action}</strong></td>
                    <td>{when(row.created_at)}</td>
                    <td>{row.released_at ? <span className="pill pill-healthy"><span>released {when(row.released_at)}</span></span> : when(row.next_safe_at)}</td>
                    <td><small>{(row.reasons ?? []).join(' ')}</small></td>
                    <td>
                      {!row.released_at && (
                        <button type="button" className="btn btn-outline btn-sm" onClick={() => release(row)} disabled={demo}>
                          <span>Release</span>
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted-note">
          Releasing records that the action went out, which is what the gate paces the next one against. Release only
          what you actually sent, or the pacing is measuring something that never happened.
        </p>
      </section>
    </div>
  );
}
