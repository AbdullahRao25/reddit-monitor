import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeUsername } from '../src/app.js';
import { createMemoryRepo } from './helpers.js';
import { withServer } from './harness.js';

function fakeChecker() {
  const checked = [];
  return {
    checked,
    busy: false,
    async checkAccount(account) {
      checked.push(account.username);
      return this.busy ? null : { account, check: {}, alerts: [] };
    },
    isChecking: () => false,
  };
}

const fakeScheduler = () => ({
  triggered: 0,
  trigger() {
    this.triggered++;
    return true;
  },
  status: () => ({ running: false, lastRunAt: null, nextRunAt: null, intervalMinutes: 60 }),
});


const configured = () => {
  const repo = createMemoryRepo();
  return {
    repo,
    checker: fakeChecker(),
    scheduler: fakeScheduler(),
    reddit: { verify: async () => {} },
  };
};

test('normalizeUsername accepts the common ways people paste a username', () => {
  assert.equal(normalizeUsername('Some_User'), 'Some_User');
  assert.equal(normalizeUsername(' u/Some_User '), 'Some_User');
  assert.equal(normalizeUsername('/u/Some_User'), 'Some_User');
  assert.equal(normalizeUsername('https://www.reddit.com/user/Some_User/'), 'Some_User');
  assert.equal(normalizeUsername('https://old.reddit.com/u/Some-User?x=1'), 'Some-User');
});

test('unconfigured server reports what is missing and refuses other calls', async () => {
  await withServer({ missing: ['REDDIT_CLIENT_ID', 'SUPABASE_URL'] }, async (call) => {
    const status = await call('GET', '/api/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.ready, false);
    assert.deepEqual(status.body.missing, ['REDDIT_CLIENT_ID', 'SUPABASE_URL']);

    const accounts = await call('GET', '/api/accounts');
    assert.equal(accounts.status, 503);
    assert.match(accounts.body.error, /REDDIT_CLIENT_ID/);
  });
});

test('status reports database and Reddit problems', async () => {
  const deps = configured();
  deps.repo.ping = async () => 'Tables not found. Run supabase/schema.sql in the Supabase SQL editor.';
  deps.reddit.verify = async () => {
    throw new Error('Reddit rejected the API credentials (HTTP 401)');
  };
  await withServer(deps, async (call) => {
    const { body } = await call('GET', '/api/status');
    assert.equal(body.ready, false);
    assert.match(body.database.error, /schema\.sql/);
    assert.match(body.reddit.error, /401/);
  });
});

test('adding accounts: validation, normalization, first check, duplicates', async () => {
  const deps = configured();
  await withServer(deps, async (call) => {
    assert.equal((await call('POST', '/api/accounts', { username: 'x' })).status, 400);
    assert.equal((await call('POST', '/api/accounts', { username: 'has spaces' })).status, 400);
    assert.equal((await call('POST', '/api/accounts', {})).status, 400);

    const created = await call('POST', '/api/accounts', { username: 'u/Some_User', label: '  Main  ' });
    assert.equal(created.status, 201);
    assert.equal(created.body.account.username, 'Some_User');
    assert.equal(created.body.account.label, 'Main');
    assert.deepEqual(deps.checker.checked, ['Some_User']);

    const duplicate = await call('POST', '/api/accounts', { username: 'some_user' });
    assert.equal(duplicate.status, 409);

    const list = await call('GET', '/api/accounts');
    assert.equal(list.body.accounts.length, 1);
    assert.equal(list.body.accounts[0].open_alerts, 0);
    assert.equal(list.body.scheduler.intervalMinutes, 60);
  });
});

test('account detail, update, manual check and delete', async () => {
  const deps = configured();
  const account = await deps.repo.createAccount({ username: 'tester' });
  await withServer(deps, async (call) => {
    assert.equal((await call('GET', '/api/accounts/not-a-uuid')).status, 404);
    assert.equal((await call('GET', '/api/accounts/00000000-0000-4000-8000-000000000000')).status, 404);

    const detail = await call('GET', `/api/accounts/${account.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.account.username, 'tester');
    assert.equal(detail.body.latestCheck, null);
    assert.deepEqual(detail.body.history, []);

    const paused = await call('PATCH', `/api/accounts/${account.id}`, { paused: true });
    assert.equal(paused.body.account.paused, true);
    assert.equal((await call('PATCH', `/api/accounts/${account.id}`, {})).status, 400);

    assert.equal((await call('POST', `/api/accounts/${account.id}/check`)).status, 200);
    deps.checker.busy = true;
    assert.equal((await call('POST', `/api/accounts/${account.id}/check`)).status, 409);

    assert.equal((await call('POST', '/api/check-all')).status, 202);
    assert.equal(deps.scheduler.triggered, 1);

    await deps.repo.insertAlert({ account_id: account.id, severity: 'warning', type: 'risk_high', message: 'x' });
    assert.equal((await call('DELETE', `/api/accounts/${account.id}`)).status, 204);
    assert.equal((await call('GET', `/api/accounts/${account.id}`)).status, 404);
    // Like the schema's on-delete cascade: no orphaned alerts for a removed account.
    assert.deepEqual((await call('GET', '/api/alerts')).body.alerts, []);
  });
});

test('alerts can be listed and acknowledged', async () => {
  const deps = configured();
  const account = await deps.repo.createAccount({ username: 'tester' });
  const first = await deps.repo.insertAlert({ account_id: account.id, severity: 'critical', type: 'shadowban_suspected', message: 'm1' });
  await deps.repo.insertAlert({ account_id: account.id, severity: 'warning', type: 'removal_spike', message: 'm2' });

  await withServer(deps, async (call) => {
    const open = await call('GET', '/api/alerts?open=1');
    assert.equal(open.body.alerts.length, 2);
    assert.equal(open.body.alerts[0].account.username, 'tester');
    assert.equal((await call('GET', '/api/accounts')).body.accounts[0].open_alerts, 2);

    assert.equal((await call('POST', `/api/alerts/${first.id}/ack`)).status, 204);
    assert.equal((await call('GET', '/api/alerts?open=1')).body.alerts.length, 1);
    assert.equal((await call('GET', '/api/alerts')).body.alerts.length, 2);

    assert.equal((await call('POST', '/api/alerts/ack-all')).status, 204);
    assert.equal((await call('GET', '/api/alerts?open=1')).body.alerts.length, 0);
  });
});

test('malformed JSON is a 400, unknown API paths a 404', async () => {
  await withServer(configured(), async (call) => {
    assert.equal((await call('POST', '/api/accounts', '{not json')).status, 400);
    assert.equal((await call('GET', '/api/nope')).status, 404);
  });
});
