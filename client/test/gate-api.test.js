import test from 'node:test';
import assert from 'node:assert/strict';
import {api} from '../src/lib/api.js';

// These pin the URLs and bodies lib/api.js builds against the routes
// server/src/app.js registers. They are the only thing that notices when one
// side is renamed and the other is not.

const A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const Q = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';
const mock = async (impl, run) => {
  const old = globalThis.fetch;
  globalThis.fetch = impl;
  try { await run(); } finally { globalThis.fetch = old; }
};

test('reading the gate is a GET that decides nothing', () => mock(async (path, options) => {
  assert.equal(path, `/api/accounts/${A}/stealth/gate`);
  assert.equal(options.method, 'GET');
  return {ok: true, status: 200, json: async () => ({verdict: null, queue: []})};
}, async () => {
  const res = await api.gate(A);
  assert.equal(res.verdict, null);
  assert.deepEqual(res.queue, []);
}));

test('asking the gate POSTs the action and reads back the verdict', () => mock(async (path, options) => {
  assert.equal(path, `/api/accounts/${A}/stealth/gate`);
  assert.equal(options.method, 'POST');
  assert.deepEqual(JSON.parse(options.body), {action: 'comment'});
  return {ok: true, status: 200, json: async () => ({verdict: 'pass', reasons: ['Safe slot'], token: 'tok'})};
}, async () => {
  const res = await api.gateCheck(A, 'comment');
  assert.equal(res.verdict, 'pass');
  assert.equal(res.token, 'tok');
}));

test('an optional payload is sent only when there is one', () => mock(async (path, options) => {
  assert.deepEqual(JSON.parse(options.body), {action: 'post', payload: {subreddit: 'test'}});
  return {ok: true, status: 200, json: async () => ({verdict: 'hold'})};
}, async () => { await api.gateCheck(A, 'post', {subreddit: 'test'}); }));

test('a hold carries the queue id the release route needs', () => mock(async (path, options) => {
  assert.equal(path, `/api/accounts/${A}/stealth/gate/${Q}`);
  assert.equal(options.method, 'POST');
  assert.deepEqual(JSON.parse(options.body), {reason: 'sent by hand'});
  return {ok: true, status: 200, json: async () => ({queued: {id: Q, released_at: '2026-10-28T00:00:00.000Z'}})};
}, async () => {
  const res = await api.gateRelease(A, Q, 'sent by hand');
  assert.ok(res.queued.released_at);
}));

test('releasing without a reason sends an empty body and lets the server default it', () => mock(async (path, options) => {
  assert.deepEqual(JSON.parse(options.body), {});
  return {ok: true, status: 200, json: async () => ({queued: {id: Q}})};
}, async () => { await api.gateRelease(A, Q); }));

test('the queue can be asked for the open rows only', () => mock(async (path) => {
  assert.equal(path, `/api/accounts/${A}/stealth/gate/queue?open=1`);
  return {ok: true, status: 200, json: async () => ({queue: [], open: true})};
}, async () => assert.equal((await api.gateQueue(A, {openOnly: true})).open, true)));

test('the queue without the flag asks for everything', () => mock(async (path) => {
  assert.equal(path, `/api/accounts/${A}/stealth/gate/queue`);
  return {ok: true, status: 200, json: async () => ({queue: [], open: false})};
}, async () => { await api.gateQueue(A); }));

test('a 400 from the gate surfaces the server message, not an HTTP code', () => mock(async () => ({
  ok: false, status: 400, json: async () => ({error: 'Stealth mode is not enabled for this account.'}),
}), async () => {
  await assert.rejects(() => api.gateCheck(A, 'comment'), /Stealth mode is not enabled/);
}));
