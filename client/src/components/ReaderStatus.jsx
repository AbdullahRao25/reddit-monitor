import React, {useEffect, useState} from 'react';
import Icon from './Icon.jsx';
import {api} from '../lib/api.js';
import {checkAllMessage, readerErrorMessage, readerStatus} from '../lib/readerStatus.js';

const when = value => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
};
const browserLabels = {not_started:'Not started', ready:'Started', error:'Failed', closed:'Closed'};
const authorizationLabels = {unverified:'Not verified', ready:'Authorized', error:'Failed'};

function RetryTime({value}) {
  const time = when(value);
  return time ? <p className="reader-retry">Next attempt can run after {time}. Scheduled checks resume on the scheduler's next eligible run.</p> : null;
}

function DiagnosticDetails({diagnostics, historical = false}) {
  return diagnostics ? <details className="reader-diagnostics"><summary>{historical?'Last failed read diagnostics':'Reader diagnostics'}</summary><p>{diagnostics.code}{diagnostics.http_status?` · HTTP ${diagnostics.http_status}`:''}{diagnostics.page_title?` · Page: ${diagnostics.page_title}`:''}</p></details> : null;
}

export default function ReaderStatus({reddit, compact = false, onRefresh}) {
  const [liveReddit, setLiveReddit] = useState(reddit);
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {setLiveReddit(reddit);}, [reddit]);
  const status = readerStatus(liveReddit);
  const reader = liveReddit?.reader;
  const manual = reader?.mode === 'html' && reader.manual_verification?.available === true;
  const active = reader?.manual_verification?.active === true;
  const updateReader = result => {
    if (result?.reader) setLiveReddit(current => ({...current, reader:result.reader}));
  };
  const refresh = async () => {
    const latest = await api.status();
    if (latest?.reddit) setLiveReddit(latest.reddit);
    await onRefresh?.();
  };
  const verify = async complete => {
    setBusy(complete ? 'complete' : 'open');
    setError(''); setMessage('');
    let verified = false;
    try {
      const result = await (complete ? api.completeReaderVerification() : api.openReaderVerification());
      updateReader(result);
      if (result?.verified === true) {
        verified = true;
        setMessage('Reddit access verified. Resuming account checks…');
        // Recently failed accounts need a fresh check even before their usual
        // cadence. The server still respects account pauses and reader limits.
        const checks = await api.checkAll({force:true});
        setMessage(`Reddit access verified. ${checkAllMessage(checks)}`);
      } else if (complete) {
        setError('The public profile is not readable yet. Finish the browser verification, then try again.');
      } else {
        setMessage('The monitor browser is open on this computer. Complete any verification there.');
      }
    } catch (err) {
      if (verified) setMessage('Reddit access verified.');
      setError(verified
        ? 'Reddit access was verified, but the account refresh did not finish. Use Check all now to try again.'
        : err?.message || readerErrorMessage(err?.diagnostics, 'The monitor browser could not be verified. Please try again.'));
    } finally {
      try {await refresh();} catch {
        setError(current => current || 'Could not refresh reader status. Use Refresh status to try again.');
      }
      setBusy(null);
    }
  };
  return <div className={`reader-status reader-status-${status.tone}${compact?' reader-status-compact':''}`} role="status">
    <Icon name={status.tone==='healthy'?'circleCheck':status.tone==='warning'?'alert':'info'} size={17}/>
    <div><strong>{status.label}.</strong> <span>{status.description}</span>
      {status.tone==='warning'&&<p>Stored workspace data remains available. Failed reads keep the last successful account results.</p>}
      {status.paused&&!status.retryAt&&<p>New reads are paused until access is available.</p>}
      <RetryTime value={status.retryAt}/>
      {manual&&(status.tone!=='healthy'||active||message||error)&&<div className="reader-verification">
        {active&&<p>Solve the CAPTCHA or verification in the monitor browser on this computer. Keep that browser signed out of Reddit so checks use the public view. Then resume checks below.</p>}
        {(status.tone!=='healthy'||active)&&<p><button type="button" className="btn btn-outline" disabled={Boolean(busy)} onClick={()=>verify(false)}>{busy==='open'?'Opening browser…':active?'Show verification browser':'Solve CAPTCHA / open reader'}</button>{' '}
          {active&&<button type="button" className="btn btn-outline" disabled={Boolean(busy)} onClick={()=>verify(true)}>{busy==='complete'?'Verifying and resuming…':'I solved it — resume checks'}</button>}
        </p>}
        {message&&<p>{message}</p>}
        {error&&<p role="alert">{error}</p>}
      </div>}
      {!compact&&reader&&<div className="reader-metadata">
        <span>Reader: {reader.mode==='html'?'Public HTML':reader.mode==='oauth'?'OAuth API':'Unknown'}</span>
        {reader.browser&&<span>Browser: {browserLabels[reader.browser.state]||'Unknown'}</span>}
        {reader.authorization&&<span>OAuth authorization: {authorizationLabels[reader.authorization.state]||'Unknown'}</span>}
        <span>Last successful read: {when(reader.last_success_at)||'None confirmed'}</span>
        <span>Last failed read: {when(reader.last_failure_at)||'None recorded'}</span>
      </div>}
      {!compact&&<DiagnosticDetails diagnostics={status.diagnostics} historical={status.historicalDiagnostics}/>}
    </div>
  </div>;
}

export function ReaderFailure({diagnostics, error, lastSuccessfulAt, preserved = false, failedAt}) {
  const success = when(lastSuccessfulAt);
  const failure = when(failedAt || diagnostics?.occurred_at);
  return <div className="reader-status reader-status-warning" role="alert">
    <Icon name="alert" size={17}/><div>
      <strong>{readerErrorMessage(diagnostics, error)}</strong>
      {preserved&&<p>Previous account data is unchanged.{success?` Showing the last successful check from ${success}; these results are stale.`:' No successful check has been recorded yet.'}</p>}
      {!preserved&&diagnostics&&<p>No account-health result was recorded from this attempt.</p>}
      {failure&&<p>Failed attempt: {failure}.</p>}
      <RetryTime value={diagnostics?.retry_at}/>
      <DiagnosticDetails diagnostics={diagnostics}/>
    </div>
  </div>;
}
