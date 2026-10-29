// Reader health describes access to Reddit, separately from account health.
const ISSUES = {
  rate_limited: ['Rate limited', 'Reddit is limiting public reads.'],
  access_denied: ['Access denied', 'Reddit is refusing access to the reader.'],
  browser_challenge: ['Browser challenge', 'Reddit returned a browser verification page.'],
  login_required: ['Sign-in required', 'Reddit returned a sign-in page instead of public account data.'],
  server_error: ['Reddit unavailable', 'Reddit returned a server error.'],
  unexpected_page: ['Page not recognized', "Reddit's public page could not be read because its format was not recognized."],
  parsing_error: ['Page could not be read', "Reddit's page did not contain a supported profile or listing."],
  navigation_error: ['Connection failed', "The reader could not finish loading Reddit's page."],
  browser_error: ['Browser unavailable', 'The monitoring browser could not complete the read.'],
};

export function readerErrorMessage(diagnostics, fallback = '') {
  if (!diagnostics && /(?:without (?:the )?|missing )profile card/i.test(fallback)) {
    return "Reddit's public profile page could not be read.";
  }
  return ISSUES[diagnostics?.code]?.[1] || fallback || "Reddit's public page could not be read.";
}

export function readerStatus(reddit = {}) {
  const reader = reddit?.reader;
  if (!reader) {
    if (reddit?.ok === true) return {label:'Reader available', description:'Reddit access is available.', tone:'healthy'};
    if (reddit?.ok === false) return {label:'Reader unavailable', description:readerErrorMessage(null, reddit.error || 'Reddit access is unavailable.'), tone:'warning'};
    return {label:'Reader not verified', description:'No successful Reddit read has been confirmed.', tone:'neutral'};
  }
  const paused = reader.paused === true || reader.state === 'paused';
  const diagnostics = paused ? reader.pause_reason ?? reader.last_error : reader.last_error;
  const failed = paused || reader.state === 'unavailable' || reader.readable === false;
  if (failed) return {
    label:ISSUES[diagnostics?.code]?.[0] || (paused ? 'Reader paused' : 'Reader unavailable'),
    description:readerErrorMessage(diagnostics, 'Reddit access is unavailable.'),
    tone:'warning', paused, diagnostics, retryAt:paused ? reader.retry_at || diagnostics?.retry_at || null : null,
  };
  if (reader.state === 'ready' && reader.readable === true) return {
    label:'Reader available', description:'The most recent Reddit read succeeded.', tone:'healthy',
    diagnostics:reader.last_error, historicalDiagnostics:true,
  };
  return {
    label:'Reader not verified',
    description:reader.browser?.state === 'ready'
      ? 'The browser started. A successful Reddit read has not been confirmed.'
      : 'Reddit access will be verified by a profile check.',
    tone:'neutral',
  };
}

// A failed Reddit reader does not disconnect the API or its stored workspace.
export function workspaceConnection(status, error = '') {
  if (error) return {label:'API unavailable', tone:'warning', connected:false};
  if (!status) return {label:'Connecting…', tone:'neutral', connected:false};
  if (status.missing?.length) return {label:'Needs setup', tone:'warning', connected:false};
  if (status.database?.ok === false) return {label:'Database unavailable', tone:'warning', connected:false};
  if (status.demo) return {label:'Demo server', tone:'healthy', connected:true};
  const reader = readerStatus(status.reddit);
  if (reader.tone === 'warning') return {label:'Connected · reader unavailable', tone:'warning', connected:true};
  if (reader.tone === 'neutral' && status.reddit?.reader) return {label:'Connected · reader not verified', tone:'neutral', connected:true};
  return {label:'Connected workspace', tone:'healthy', connected:true};
}

export function checkAllMessage(result, status) {
  if (result?.started) return 'Checking all accounts, one after another.';
  if (result?.readerPaused || status?.scheduler?.readerPaused || status?.reddit?.reader?.paused) {
    const retry = result?.retryAt || status?.scheduler?.retryAt || status?.reddit?.reader?.retry_at;
    const time = retry ? new Date(retry) : null;
    return `Reddit reads are paused.${time && !Number.isNaN(time.getTime()) ? ` Checks can run after ${time.toLocaleString()}.` : ' Wait until reader access is available.'}`;
  }
  return 'A run is already in progress.';
}
