import test from 'node:test';
import assert from 'node:assert/strict';
import {readerStatus, readerErrorMessage, workspaceConnection, checkAllMessage} from '../src/lib/readerStatus.js';
import {api, normalizeDetail} from '../src/lib/api.js';

test('starting a browser does not claim that Reddit pages can be read', () => {
  const status = readerStatus({ok:null, reader:{mode:'html', state:'unverified', readable:null, browser:{state:'ready'}}});
  assert.equal(status.label, 'Reader not verified');
  assert.equal(status.tone, 'neutral');
  assert.match(status.description, /browser started/i);
  assert.match(status.description, /not been confirmed/i);
});

test('cached rate-limit diagnostics show the retry window without claiming a healthy account', () => {
  const retry = '2026-10-29T14:15:00Z';
  const status = readerStatus({ok:false, reader:{state:'paused', readable:false, paused:true, retry_at:retry, last_error:{code:'rate_limited'}}});
  assert.equal(status.label, 'Rate limited');
  assert.equal(status.retryAt, retry);
  assert.equal(status.tone, 'warning');
  assert.doesNotMatch(status.description, /shadowban|healthy/i);
});

test('expired pauses keep reader failures visible without showing historical retry deadlines', () => {
  for (const [code, label] of [['rate_limited', 'Rate limited'], ['unexpected_page', 'Page not recognized']]) {
    const lastError = {code, retry_at:'2026-10-28T14:15:00Z'};
    const status = readerStatus({ok:false, reader:{state:'unavailable',readable:false,paused:false,retry_at:null,last_error:lastError}});
    assert.equal(status.label, label);
    assert.equal(status.tone, 'warning');
    assert.equal(status.paused, false);
    assert.equal(status.retryAt, null);
    assert.equal(status.diagnostics, lastError);
  }
});

test('successful OAuth reads with exhausted quota show the pause reason without inventing a failed read', () => {
  const retry = '2026-10-29T14:15:00Z';
  const reddit = {ok:false, reader:{mode:'oauth',state:'paused',readable:true,paused:true,last_error:null,last_failure_at:null,pause_reason:{code:'rate_limited',retry_at:retry}}};
  const status = readerStatus(reddit);
  assert.equal(status.label, 'Rate limited');
  assert.equal(status.tone, 'warning');
  assert.equal(status.retryAt, retry);
  assert.match(status.description, /limiting public reads/i);
  assert.equal(status.diagnostics, reddit.reader.pause_reason);
  assert.equal(reddit.reader.last_error, null);
  assert.equal(reddit.reader.last_failure_at, null);
});

test('reader failure categories explain the cause instead of missing-profile markup', () => {
  for (const [code, phrase] of [
    ['access_denied',/refusing access/i], ['browser_challenge',/verification page/i],
    ['login_required',/sign-in page/i], ['unexpected_page',/format.*not recognized/i],
    ['navigation_error',/loading Reddit/i], ['browser_error',/monitoring browser/i],
    ['server_error',/server error/i], ['parsing_error',/supported profile or listing/i],
  ]) assert.match(readerErrorMessage({code}, 'missing profile card'), phrase);
  assert.equal(readerErrorMessage(null, 'Specific legacy error'), 'Specific legacy error');
  assert.equal(readerErrorMessage(null, 'Reddit returned a page without the profile card, possibly because of rate limiting; the last known result is kept.'), "Reddit's public profile page could not be read.");
});

test('check-all explains a cooldown instead of claiming that a run is in progress', () => {
  assert.match(checkAllMessage({started:false}, {scheduler:{readerPaused:true,retryAt:'2026-10-29T14:15:00Z'}}), /reads are paused.*Checks can run after/i);
  assert.match(checkAllMessage({started:false,readerPaused:true}), /reads are paused/i);
  assert.equal(checkAllMessage({started:true}, {scheduler:{readerPaused:true}}), 'Checking all accounts, one after another.');
  assert.equal(checkAllMessage({started:false}, {scheduler:{readerPaused:false}}), 'A run is already in progress.');
});

test('a readable cached result is available and legacy status fields still work', () => {
  assert.equal(readerStatus({reader:{state:'ready',readable:true}}).tone, 'healthy');
  assert.equal(readerStatus({ok:true}).tone, 'healthy');
  assert.equal(readerStatus({ok:false,error:'Connection failed'}).description, 'Connection failed');
  assert.equal(readerStatus({ok:null}).tone, 'neutral');
});

test('recovered reader stays healthy while retaining clearly historical failure diagnostics', () => {
  const lastError = {code:'access_denied',http_status:403,occurred_at:'2026-10-28T14:15:00Z'};
  const status = readerStatus({ok:true, reader:{state:'ready',readable:true,paused:false,last_error:lastError,last_failure_at:lastError.occurred_at,last_success_at:'2026-10-29T14:15:00Z'}});
  assert.equal(status.tone, 'healthy');
  assert.equal(status.label, 'Reader available');
  assert.match(status.description, /most recent.*succeeded/i);
  assert.equal(status.diagnostics, lastError);
  assert.equal(status.historicalDiagnostics, true);
  assert.equal(status.retryAt, undefined);
});

test('reader access failure leaves the workspace connected even when legacy ready is false', () => {
  const status = {ready:false,missing:[],database:{ok:true},reddit:{ok:false,reader:{state:'unavailable',readable:false,last_error:{code:'access_denied'}}}};
  assert.deepEqual(workspaceConnection(status), {label:'Connected · reader unavailable',tone:'warning',connected:true});
  assert.equal(workspaceConnection({...status,missing:['SUPABASE_URL']}).connected, false);
  assert.equal(workspaceConnection({...status,database:{ok:false}}).connected, false);
  assert.equal(workspaceConnection(status, 'Cannot reach API').connected, false);
});

test('quick check errors retain structured reader diagnostics for the UI', async () => {
  const original = globalThis.fetch;
  const diagnostics = {code:'browser_challenge',http_status:403,page_title:'Verification',retry_at:'2026-10-29T14:15:00Z'};
  globalThis.fetch = async () => ({ok:false,status:503,json:async()=>({error:'Reader unavailable',diagnostics})});
  try {
    await assert.rejects(api.checkLive('example'), error => {
      assert.equal(error.status, 503);
      assert.deepEqual(error.diagnostics, diagnostics);
      return true;
    });
  } finally { globalThis.fetch = original; }
});

test('account normalization preserves stale metadata and the last successful account values', () => {
  const diagnostics = {code:'unexpected_page'};
  const detail = normalizeDetail({account:{risk_score:32,link_karma:100,comment_karma:50,items_sampled:8,items_removed:1},stale:true,last_successful_check_at:'2026-10-28T14:15:00Z',lastError:{error:'Unreadable page',diagnostics}});
  assert.equal(detail.stale, true);
  assert.equal(detail.last_successful_check_at, '2026-10-28T14:15:00Z');
  assert.deepEqual(detail.lastError.diagnostics, diagnostics);
  assert.equal(detail.account.karma, 150);
  assert.equal(detail.account.risk_score, 32);
  assert.equal(detail.account.removed_30d, 1);
});
