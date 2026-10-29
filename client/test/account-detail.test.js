import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileManualCheck} from '../src/lib/accountDetail.js';

const successAt = '2026-10-29T11:00:00Z';
const oldAt = '2026-10-29T13:09:00Z';
const currentAt = '2026-10-29T13:15:00Z';
const diagnostics = {code:'browser_challenge',retry_at:'2026-10-29T13:25:00Z'};
const previous = {
  account:{id:'test',karma:150,risk_score:27,checking:true},
  latestCheck:{checked_at:successAt,risk_score:27},
  last_successful_check_at:successAt,
  lastError:{checked_at:oldAt,error:'Old missing profile card error'},
  history:[{created_at:successAt,risk_score:27}],
  content:[{id:'kept'}],
};
const failure = {
  account:{id:'test',karma:150,risk_score:27,checking:false,last_checked_at:currentAt},
  check:{checked_at:currentAt,error:'Browser verification page',factors:[{key:'reader_error',diagnostics}]},
};

test('manual failure replaces older diagnostics immediately and preserves the successful assessment', () => {
  const detail = reconcileManualCheck(previous,failure);
  assert.equal(detail.lastError.checked_at,currentAt);
  assert.equal(detail.lastError.diagnostics,diagnostics);
  assert.equal(detail.account.checking,false);
  assert.equal(detail.account.risk_score,27);
  assert.equal(detail.account.karma,150);
  assert.equal(detail.latestCheck,previous.latestCheck);
  assert.equal(detail.last_successful_check_at,successAt);
  assert.equal(detail.content,previous.content);
  assert.equal(detail.history,previous.history);
  assert.equal(detail.stale,true);
});

test('an older GET snapshot cannot replace the current manual failure', () => {
  const stale = {...previous,lastError:{checked_at:oldAt,error:'Old generic error'}};
  const detail = reconcileManualCheck(stale,failure);
  assert.equal(detail.lastError.diagnostics.code,'browser_challenge');
  assert.equal(detail.lastError.diagnostics.retry_at,diagnostics.retry_at);
  assert.equal(detail.account.checking,false);
});

test('a genuinely newer observed check supersedes the manual result', () => {
  const newer = {...previous,latestCheck:{checked_at:'2026-10-29T13:30:00Z'},lastError:null};
  assert.equal(reconcileManualCheck(newer,failure),newer);
});

test('a caught-up GET remains authoritative for later edits and a newly started check', () => {
  const caughtUp = {...previous,account:{...previous.account,label:'Updated label',paused:true,checking:true},lastError:{checked_at:currentAt,error:failure.check.error,diagnostics}};
  assert.equal(reconcileManualCheck(caughtUp,failure),caughtUp);
  assert.equal(reconcileManualCheck(caughtUp,failure).account.label,'Updated label');
  assert.equal(reconcileManualCheck(caughtUp,failure).account.checking,true);
});

test('manual recovery clears old failure and adds the successful check once', () => {
  const result = {account:{...failure.account,risk_score:18},check:{checked_at:currentAt,risk_score:18,status:'active',error:null}};
  const detail = reconcileManualCheck(previous,result);
  assert.equal(detail.lastError,null);
  assert.equal(detail.stale,false);
  assert.equal(detail.latestCheck,result.check);
  assert.equal(detail.last_successful_check_at,currentAt);
  assert.equal(detail.history.length,2);
  assert.equal(reconcileManualCheck(detail,result).history.length,2);
});
