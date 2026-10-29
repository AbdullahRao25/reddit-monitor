import React, {useState} from 'react';
import {downloadExport} from '../lib/api.js';
import Icon from './Icon.jsx';

// Two things the dashboard had no way to do: get the data out, and watch one
// account more closely than the rest.
//
// The export matters because nothing Reddit keeps says what a profile looked
// like to a logged-out visitor last Tuesday — this database is the only copy,
// and a copy you cannot read is not a backup.

// One key per button, used to mark just that button as busy.
const exportKey = (format, table) => `${format}-${table ?? 'all'}`;

const EXPORTS = [
  ['json', null, 'Everything (JSON)', 'Account, every check, every tracked item and every alert, in one file.'],
  ['csv', 'checks', 'Check history (CSV)', 'One row per check: risk score, karma, items sampled and removed.'],
  ['csv', 'content', 'Tracked content (CSV)', 'One row per post or comment, with its removal status.'],
  ['csv', 'alerts', 'Alerts (CSV)', 'One row per alert raised for this account.'],
];

// Matches the server's guard in PATCH /api/accounts/:id and the 15-minute
// floor config.js applies to CHECK_INTERVAL_MINUTES.
const INTERVALS = [
  ['', 'Use the server default'],
  ['15', 'Every 15 minutes'],
  ['30', 'Every 30 minutes'],
  ['60', 'Hourly'],
  ['240', 'Every 4 hours'],
  ['720', 'Every 12 hours'],
  ['1440', 'Daily'],
];

export default function AccountTools({account, demo = false, onPatch, onToast = () => {}}) {
  const [busy, setBusy] = useState(null);
  const current = account?.check_interval_minutes ?? null;
  const [interval, setInterval] = useState(current === null ? '' : String(current));

  const run = async (format, table) => {
    if (demo) { onToast('Export needs the live API; demo data lives only in this browser.'); return; }
    setBusy(exportKey(format, table));
    try {
      onToast(`Saved ${await downloadExport(account.id, {format, table})}`);
    } catch (err) {
      onToast(err.message);
    } finally {
      setBusy(null);
    }
  };

  const saveInterval = (value) => {
    setInterval(value);
    // '' clears the override and puts the account back on the server-wide interval.
    onPatch(account.id, {check_interval_minutes: value === '' ? null : Number(value)});
  };

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Check frequency</h3>
            <p>How often this account is re-checked, overriding the server-wide interval.</p>
          </div>
        </div>
        <select value={interval} onChange={(e) => saveInterval(e.target.value)} disabled={demo} aria-label="Check frequency">
          {INTERVALS.map(([value, text]) => <option key={value || 'default'} value={value}>{text}</option>)}
        </select>
        <p className="muted-note">
          The scheduler wakes up often enough for the shortest interval any account asks for, so a watched account can
          be checked more often without raising the rate for the rest. Checking more often than every 15 minutes tells
          you nothing new: shadowbans and removals do not change minute to minute.
          {demo && ' Read-only in demo mode.'}
        </p>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Export this account</h3>
            <p>Everything stored here, as a file you keep.</p>
          </div>
        </div>
        <div className="prevention-actions">
          {EXPORTS.map(([format, table, title, description]) => {
            const running = busy === exportKey(format, table);
            return (
              <button
                key={exportKey(format, table)}
                type="button"
                className="btn btn-outline"
                title={description}
                onClick={() => run(format, table)}
                disabled={demo || busy !== null}
              >
                <Icon name={running ? 'refresh' : 'download'} size={15} className={running ? 'spin' : ''} />
                <span>{title}</span>
              </button>
            );
          })}
        </div>
        <p className="muted-note">
          These are this monitor's observations of the public view of the profile, not Reddit's own records. The JSON
          file says so, so a reader months from now can tell what they are looking at.
        </p>
      </section>
    </>
  );
}
