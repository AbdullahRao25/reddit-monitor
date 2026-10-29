import test from 'node:test';
import assert from 'node:assert/strict';
import {api} from '../src/lib/api.js';

const mock = async (fetch, run) => {
  const original = globalThis.fetch;
  globalThis.fetch = fetch;
  try {await run();} finally {globalThis.fetch = original;}
};

test('opening manual verification sends an explicit empty POST to the reader route', () => mock(async (path, options) => {
  assert.equal(path, '/api/reader/verification/open');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(options.body), {});
  return {ok:true, status:200, json:async()=>({opened:true, active:true, reader:{mode:'html',manual_verification:{available:true,active:true}}})};
}, async () => {
  const result = await api.openReaderVerification();
  assert.equal(result.opened, true);
  assert.equal(result.reader.manual_verification.active, true);
}));

test('resuming after a human solve POSTs to verification completion without credentials or account data', () => mock(async (path, options) => {
  assert.equal(path, '/api/reader/verification/complete');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(options.body), {});
  return {ok:true, status:200, json:async()=>({verified:true, username:'example', reader:{mode:'html',readable:true}})};
}, async () => {
  const result = await api.completeReaderVerification();
  assert.equal(result.verified, true);
  assert.equal(result.reader.readable, true);
}));

test('verification API failures retain safe server explanations and reader diagnostics', () => mock(async () => ({
  ok:false, status:503, json:async()=>({error:'Complete the verification in the monitor browser.',diagnostics:{code:'browser_challenge',http_status:200}}),
}), async () => {
  await assert.rejects(api.completeReaderVerification(), error => {
    assert.equal(error.status, 503);
    assert.equal(error.message, 'Complete the verification in the monitor browser.');
    assert.deepEqual(error.diagnostics, {code:'browser_challenge',http_status:200});
    return true;
  });
}));

test('manual verification preserves the shared adapter network error', () => mock(async () => {
  throw new Error('private transport details');
}, async () => {
  await assert.rejects(api.openReaderVerification(), error => {
    assert.equal(error.status, 0);
    assert.equal(error.message, 'Cannot reach the API server. Is it running?');
    assert.doesNotMatch(error.message, /private/);
    return true;
  });
}));

test('resuming monitoring forces a sweep while ordinary check-all keeps its existing request shape', async () => {
  const calls = [];
  await mock(async (path, options) => {
    calls.push({path,options});
    return {ok:true,status:202,json:async()=>({started:true})};
  }, async () => {
    await api.checkAll({force:true});
    await api.checkAll();
  });
  assert.equal(calls[0].path, '/api/check-all');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), {force:true});
  assert.equal(calls[1].path, '/api/check-all');
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[1].options.body, undefined);
});
