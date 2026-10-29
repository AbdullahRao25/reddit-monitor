import assert from 'node:assert/strict';
import test from 'node:test';
import { createRedditClient } from '../src/reddit.js';
import { NOW, createMemoryRepo } from './helpers.js';
import { withServer } from './harness.js';

const profile = { kind: 't2', data: { name: 'tester', link_karma: 25, comment_karma: 100, created_utc: 1_600_000_000 } };
const listing = (children = []) => ({ kind: 'Listing', data: { children } });
const reply = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });

function setup(resource) {
  let clock = NOW;
  const calls = [];
  const reddit = createRedditClient({
    clientId: 'fixture-id', clientSecret: 'fixture-secret', userAgent: 'fixture-reader',
    minIntervalMs: 0, now: () => clock,
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname;
      calls.push({ path, options });
      return path === '/api/v1/access_token'
        ? reply({ access_token: 'fixture-token', expires_in: 3600 })
        : resource(path, calls.length);
    },
  });
  return { reddit, calls, advance: (ms) => { clock += ms; } };
}

test('OAuth public reads preserve normal profiles, real empty listings and content batches', async () => {
  const post = { kind: 't3', data: { name: 't3_abc', title: 'Example' } };
  const s = setup((path) => reply(path.endsWith('/about') ? profile : path === '/api/info' ? listing([post]) : listing()));
  const about = await s.reddit.getUserAbout('tester');
  assert.equal(about.state, 'active');
  assert.equal(about.profile.commentKarma, 100);
  assert.deepEqual(await s.reddit.getUserListing('tester', 'submitted'), []);
  assert.deepEqual(await s.reddit.getUserListing('tester', 'comments'), []);
  assert.equal((await s.reddit.getInfo(['t3_abc']))[0].name, 't3_abc');
  assert.equal(s.calls.filter((call) => call.path === '/api/v1/access_token').length, 1);
  assert.equal(s.reddit.getDiagnostics().readable, true);
  assert.equal(s.reddit.getDiagnostics().authorization.state, 'ready');
});

test('OAuth authorization alone does not claim public readability and status polls do not fetch', async () => {
  const s = setup(() => reply(profile));
  await s.reddit.verify();
  assert.equal(s.reddit.getDiagnostics().authorization.state, 'ready');
  assert.equal(s.reddit.getDiagnostics().readable, null);
  await withServer({ repo: createMemoryRepo(), reddit: s.reddit }, async (call) => {
    const { body } = await call('GET', '/api/status');
    assert.equal(body.reddit.ok, null);
    assert.equal(body.reddit.reader.state, 'unverified');
    assert.equal(body.ready, false);
    await call('GET', '/api/status');
    assert.equal(s.calls.length, 1, 'status must not refresh credentials or perform public requests');
  });
});

for (const retryAfter of ['120', new Date(NOW + 120_000).toUTCString()]) {
  test(`OAuth honors Retry-After ${retryAfter}, rejects queued work, and recovers on a later call`, async () => {
    let limited = true;
    const s = setup(() => limited ? reply({ error: 429 }, 429, { 'Retry-After': retryAfter }) : reply(profile));
    await assert.rejects(s.reddit.getUserAbout('tester'), (error) => {
      assert.equal(error.code, 'rate_limited');
      assert.equal(error.status, 429);
      assert.equal(error.diagnostics.retry_at, new Date(NOW + 120_000).toISOString());
      return true;
    });
    const failed = s.reddit.getDiagnostics().last_failure_at;
    await assert.rejects(s.reddit.getUserAbout('tester'), { code: 'rate_limited' });
    assert.equal(s.calls.length, 2, 'cooldown must not issue another network request');
    assert.equal(s.reddit.getDiagnostics().last_failure_at, failed);
    s.advance(120_000);
    limited = false;
    assert.equal((await s.reddit.getUserAbout('tester')).state, 'active');
    const recovered = s.reddit.getDiagnostics();
    assert.equal(recovered.paused, false);
    assert.equal(recovered.readable, true);
    assert.equal(recovered.last_error.code, 'rate_limited', 'retain the most recent failed-read reason');
    assert.equal(recovered.last_failure_at, failed);
  });
}

for (const [status, code] of [[403, 'access_denied'], [500, 'server_error']]) {
  test(`OAuth ${status} cannot become an account result`, async () => {
    const s = setup(() => reply({ kind: 't2', data: { is_suspended: true } }, status));
    await assert.rejects(s.reddit.getUserAbout('tester'), { code, status });
    assert.equal(s.reddit.getDiagnostics().readable, false);
    assert.equal(s.reddit.getDiagnostics().paused, true);
  });
}

test('OAuth rejects malformed profile payloads, including false suspension/zero-health shapes', async () => {
  for (const body of [null, {}, { data: { is_suspended: true } },
    { kind: 't2', data: { name: 'tester' } },
    { ...profile, data: { ...profile.data, name: 'someone_else' } }]) {
    const s = setup(() => reply(body));
    await assert.rejects(s.reddit.getUserAbout('tester'), { code: 'parsing_error' });
    assert.equal(s.reddit.getDiagnostics().readable, false);
  }
  const suspended = setup(() => reply({ kind: 't2', data: { is_suspended: true } }));
  assert.equal((await suspended.reddit.getUserAbout('tester')).state, 'suspended');
});

test('OAuth rejects unrecognized listing and card formats before the next queued request', async () => {
  for (const body of [{}, listing([{ data: { name: 't3_abc' } }]),
    listing([{ kind: 't3', data: { name: 'invalid' } }]),
    listing([{ kind: 't1', data: { name: 't1_abc' } }])]) {
    const s = setup(() => reply(body));
    const results = await Promise.allSettled([
      s.reddit.getUserListing('tester', 'submitted'), s.reddit.getUserListing('tester', 'comments'),
    ]);
    assert.ok(results.every((result) => result.status === 'rejected' && result.reason.code === 'parsing_error'));
    assert.equal(s.calls.length, 2, 'invalid structure activates cooldown before the queued read');
  }
});

test('OAuth refreshes a rejected token only once and retains safe structured errors', async () => {
  let resources = 0;
  const s = setup(() => ++resources === 1 ? reply({}, 401) : reply(profile));
  assert.equal((await s.reddit.getUserAbout('tester')).state, 'active');
  assert.equal(resources, 2);
  assert.equal(s.calls.length, 4);
  const denied = setup(() => reply({}, 401));
  await assert.rejects(denied.reddit.getUserAbout('tester'), { code: 'access_denied', status: 401 });
  assert.equal(denied.calls.length, 4, 'no endless token refresh');
  assert.doesNotMatch(JSON.stringify(denied.reddit.getDiagnostics()), /fixture-secret|fixture-token/);
});

test('OAuth distinguishes real missing profiles from failed content-info requests', async () => {
  const s = setup(() => reply({}, 404));
  assert.equal((await s.reddit.getUserAbout('tester')).state, 'not_found');
  assert.equal(await s.reddit.getUserListing('tester', 'comments'), null);
  await assert.rejects(s.reddit.getInfo(['t3_abc']), { code: 'unexpected_page', status: 404 });
  assert.equal(s.reddit.getDiagnostics().readable, false);
});

test('OAuth navigation and invalid JSON errors omit raw response or exception text', async () => {
  for (const resource of [() => { throw new Error('https://private.example/?access_token=secret'); },
    () => new Response('password=secret and not JSON', { status: 200 })]) {
    const s = setup(resource);
    await assert.rejects(s.reddit.getUserAbout('tester'));
    assert.doesNotMatch(JSON.stringify(s.reddit.getDiagnostics()), /private\.example|access_token|password|secret/);
  }
});

test('OAuth quota headers pause future reads without falsely recording a failed read', async () => {
  const s = setup(() => reply(profile, 200, { 'x-ratelimit-remaining': '0.5', 'x-ratelimit-reset': '90' }));
  assert.equal((await s.reddit.getUserAbout('tester')).state, 'active');
  const state = s.reddit.getDiagnostics();
  assert.equal(state.readable, true);
  assert.equal(state.paused, true);
  assert.equal(state.pause_reason.code, 'rate_limited');
  assert.equal(state.last_failure_at, null);
  assert.equal(state.last_error, null);
  await assert.rejects(s.reddit.getUserAbout('tester'), (error) => error.code === 'rate_limited' && error.diagnostics.attempts === 0);
  assert.equal(s.calls.length, 2);
});

test('out-of-range OAuth cooldown headers keep a safe default and cached status never throws', async () => {
  for (const resource of [() => reply({}, 429, { 'Retry-After': '999999999999999' }),
    () => reply(profile, 200, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '999999999999999' })]) {
    const s = setup(resource);
    await s.reddit.getUserAbout('tester').catch(() => {});
    const state = s.reddit.getDiagnostics();
    assert.equal(state.paused, true);
    assert.equal(state.retry_at, new Date(NOW + 60_000).toISOString());
    assert.doesNotThrow(() => JSON.stringify(state));
    await assert.rejects(s.reddit.getUserAbout('tester'), { code: 'rate_limited' });
    assert.equal(s.calls.length, 2);
  }
});
