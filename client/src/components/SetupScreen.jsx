import { useState } from 'react';
import { Button, Icon } from './ui.jsx';

function Step({ number, title, state, children }) {
  const icon = { ok: 'check', todo: 'alert', waiting: 'clock' }[state];
  const tone = { ok: 'good', todo: 'serious', waiting: 'neutral' }[state];
  return (
    <li className="setup-step">
      <span className={`step-icon tone-${tone}`}>
        <Icon name={icon} size={18} />
      </span>
      <div>
        <h2>
          {number}. {title}
        </h2>
        <div className="step-body">{children}</div>
      </div>
    </li>
  );
}

export function SetupScreen({ status, error, onRetry }) {
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    await onRetry();
    setBusy(false);
  };

  if (!status) {
    return (
      <section className="panel setup">
        <h1>Can't reach the API server</h1>
        <p>{error?.message}</p>
        <p>
          Start the server and the dashboard together from the <code>reddit-monitor</code> folder with{' '}
          <code>npm run dev</code>, then try again.
        </p>
        <Button icon="refresh" busy={busy} onClick={retry}>
          Try again
        </Button>
      </section>
    );
  }

  const configured = status.missing.length === 0;
  const dbState = !status.database ? 'waiting' : status.database.ok ? 'ok' : 'todo';
  const redditState = !status.reddit ? 'waiting' : status.reddit.ok ? 'ok' : 'todo';

  return (
    <section className="panel setup">
      <h1>Finish setting up</h1>
      <p className="muted">
        The monitor needs a Supabase database and a Reddit API app. This page checks again every few seconds and
        opens the dashboard once everything is connected.
      </p>
      <ol className="setup-steps">
        <Step number={1} title="Fill in server/.env" state={configured ? 'ok' : 'todo'}>
          {configured ? (
            <p>All settings are present.</p>
          ) : (
            <>
              <p>
                Copy <code>server/.env.example</code> to <code>server/.env</code> and fill in:
              </p>
              <ul className="code-list">
                {status.missing.map((name) => (
                  <li key={name}>
                    <code>{name}</code>
                  </li>
                ))}
              </ul>
              <p>Then restart the server (stop and re-run <code>npm run dev</code>).</p>
            </>
          )}
        </Step>
        <Step number={2} title="Create the database tables" state={dbState}>
          {dbState === 'ok' && <p>Connected to Supabase.</p>}
          {dbState === 'waiting' && <p>Waiting for step 1.</p>}
          {dbState === 'todo' && (
            <>
              <p className="step-error">{status.database.error}</p>
              <p>
                In Supabase open <strong>SQL Editor → New query</strong>, paste the contents of{' '}
                <code>supabase/schema.sql</code> and click <strong>Run</strong>.
              </p>
            </>
          )}
        </Step>
        <Step number={3} title="Connect the Reddit API" state={redditState}>
          {redditState === 'ok' && <p>Reddit accepted the API credentials.</p>}
          {redditState === 'waiting' && <p>Waiting for step 1.</p>}
          {redditState === 'todo' && (
            <>
              <p className="step-error">{status.reddit.error}</p>
              <p>
                Create a <strong>script</strong> app at <code>reddit.com/prefs/apps</code> and copy its client ID
                (under the app name) and secret into <code>server/.env</code>.
              </p>
            </>
          )}
        </Step>
      </ol>
      <Button icon="refresh" busy={busy} onClick={retry}>
        Check again
      </Button>
    </section>
  );
}
