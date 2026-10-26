import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createAuth } from '../src/auth.js';
import { authPolicy } from '../src/config.js';
import { createMemoryRepo, silentLog } from './helpers.js';

// The rule that decides whether a deployment may run without sign-in.
test('sign-in is optional on loopback and mandatory on any reachable host', () => {
  // Local default: no key, no auth, and that is allowed.
  const local = authPolicy({ host: '127.0.0.1' });
  assert.deepEqual([local.required, local.enabled], [false, false]);

  // A key present locally turns it on so the real flow can be tested.
  assert.equal(authPolicy({ host: '127.0.0.1', anonKey: 'k' }).enabled, true);
  assert.equal(authPolicy({ host: 'localhost', forceRequired: true }).required, true);

  // Deployed: bound to every interface, so sign-in is required even if the
  // operator set nothing. missingConfig() then refuses to start it open.
  for (const host of ['0.0.0.0', '10.0.0.4', 'monitor.example.com']) {
    const deployed = authPolicy({ host });
    assert.equal(deployed.required, true, host);
    assert.equal(deployed.enabled, true, host);
  }

  // The explicit escape hatch still works, and is the only way to run open.
  assert.deepEqual(
    (({ required, enabled }) => ({ required, enabled }))(authPolicy({ host: '0.0.0.0', disabled: true })),
    { required: false, enabled: false },
  );
});

test('an access rule is only recognised when one is actually configured', () => {
  assert.equal(authPolicy({}).hasRule, false);
  assert.equal(authPolicy({ allowedEmails: ['a@b.com'] }).hasRule, true);
  assert.equal(authPolicy({ allowedDomain: 'b.com' }).hasRule, true);
  assert.equal(authPolicy({ allowAny: true }).hasRule, true);
});

// A verifier that maps a handful of fake tokens to users, like Supabase would.
const USERS = {
  'tok-boss': { id: '1', email: 'boss@team.com' },
  'tok-mate': { id: '2', email: 'mate@team.com' },
  'tok-outsider': { id: '3', email: 'stranger@gmail.com' },
};
const verifyToken = async (token) => USERS[token] ?? null;

function serverWith(authOpts) {
  const repo = createMemoryRepo();
  const app = createApp({
    repo,
    reddit: { verify: async () => {} },
    checker: { isChecking: () => false, checkAccount: async () => null },
    scheduler: { status: () => ({}), trigger: () => true },
    auth: createAuth({ verifyToken, log: silentLog, ...authOpts }),
    corsOrigins: ['https://team.netlify.app'],
    log: silentLog,
  });
  return { repo, app };
}

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, { token, method = 'GET', origin } = {}) =>
    fetch(base + path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(origin ? { Origin: origin } : {}),
      },
    });
  return { server, call };
}

test('the health check needs no token; everything else under /api does', async (t) => {
  const { app } = serverWith({ allowedEmails: ['boss@team.com'] });
  const { server, call } = await listen(app);
  t.after(() => server.close());

  assert.equal((await call('/api/health')).status, 200);
  assert.equal((await call('/api/accounts')).status, 401);
  assert.equal((await call('/api/accounts', { token: 'not-a-real-token' })).status, 401);
  assert.equal((await call('/api/accounts', { token: 'tok-boss' })).status, 200);
});

test('the allowlist admits listed emails and the domain, and refuses the rest', async (t) => {
  const { app } = serverWith({ allowedEmails: ['boss@team.com'], allowedDomain: 'team.com' });
  const { server, call } = await listen(app);
  t.after(() => server.close());

  assert.equal((await call('/api/accounts', { token: 'tok-boss' })).status, 200);
  assert.equal((await call('/api/accounts', { token: 'tok-mate' })).status, 200, 'same domain');
  const outsider = await call('/api/accounts', { token: 'tok-outsider' });
  assert.equal(outsider.status, 403);
  assert.match((await outsider.json()).error, /not on the access list/);
});

test('allowAny admits any validly signed-in user but still rejects a bad token', async (t) => {
  const { app } = serverWith({ allowAny: true });
  const { server, call } = await listen(app);
  t.after(() => server.close());

  assert.equal((await call('/api/accounts', { token: 'tok-outsider' })).status, 200);
  assert.equal((await call('/api/accounts', { token: 'forged' })).status, 401);
});

test('a preflight from the dashboard origin is answered with CORS headers', async (t) => {
  const { app } = serverWith({ allowAny: true });
  const { server, call } = await listen(app);
  t.after(() => server.close());

  const pre = await call('/api/accounts', { method: 'OPTIONS', origin: 'https://team.netlify.app' });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://team.netlify.app');
  assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
});

test('a validated token is cached, so repeat requests do not re-verify', async (t) => {
  let calls = 0;
  const repo = createMemoryRepo();
  const app = createApp({
    repo,
    reddit: { verify: async () => {} },
    checker: { isChecking: () => false, checkAccount: async () => null },
    scheduler: { status: () => ({}), trigger: () => true },
    auth: createAuth({
      verifyToken: async (token) => {
        calls++;
        return USERS[token] ?? null;
      },
      allowAny: true,
      log: silentLog,
    }),
    log: silentLog,
  });
  const { server, call } = await listen(app);
  t.after(() => server.close());

  await call('/api/accounts', { token: 'tok-boss' });
  await call('/api/accounts', { token: 'tok-boss' });
  await call('/api/accounts', { token: 'tok-boss' });
  assert.equal(calls, 1);
});
