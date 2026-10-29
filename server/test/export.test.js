import assert from 'node:assert/strict';
import test from 'node:test';
import { EXPORT_COLUMNS, accountBundle, exportFilename, toCsv } from '../src/export.js';
import { withServer } from './harness.js';
import { DAY, NOW, createMemoryRepo } from './helpers.js';

const iso = (ms) => new Date(ms).toISOString();

test('toCsv writes the named columns, in order, with a CRLF header', () => {
  const csv = toCsv([{ b: 2, a: 1, extra: 'ignored' }], ['a', 'b']);
  assert.equal(csv, 'a,b\r\n1,2\r\n');
});

test('toCsv quotes delimiters, quotes and newlines, and doubles embedded quotes', () => {
  const csv = toCsv([{ t: 'a,b' }, { t: 'say "hi"' }, { t: 'one\ntwo' }], ['t']);
  assert.equal(csv, 't\r\n"a,b"\r\n"say ""hi"""\r\n"one\ntwo"\r\n');
});

test('toCsv renders missing values as empty, not as the word undefined', () => {
  assert.equal(toCsv([{ a: null }, { a: undefined }, {}], ['a']), 'a\r\n\r\n\r\n\r\n');
});

test('toCsv defuses fields a spreadsheet would run as a formula', () => {
  // Reddit titles starting with - or = are ordinary; a spreadsheet treating
  // them as formulas is not.
  assert.equal(toCsv([{ t: '=1+1' }], ['t']), "t\r\n'=1+1\r\n");
  assert.equal(toCsv([{ t: '-50% karma' }], ['t']), "t\r\n'-50% karma\r\n");
  assert.equal(toCsv([{ t: '@everyone' }], ['t']), "t\r\n'@everyone\r\n");
  assert.equal(toCsv([{ t: 'normal' }], ['t']), 't\r\nnormal\r\n');
});

test('toCsv serialises an object cell instead of printing [object Object]', () => {
  assert.equal(toCsv([{ d: { a: 1 } }], ['d']), 'd\r\n"{""a"":1}"\r\n');
});

test('toCsv of nothing is still a readable file with its header', () => {
  assert.equal(toCsv([], ['a', 'b']), 'a,b\r\n');
});

test('export filenames carry the account and date and survive every platform', () => {
  assert.equal(exportFilename('tester', { extension: 'json', now: NOW }), 'u-tester-2026-10-19.json');
  assert.equal(exportFilename('tester', { table: 'content', extension: 'csv', now: NOW }), 'u-tester-content-2026-10-19.csv');
  // No separators and no colons: both would break the download on Windows.
  const hostile = exportFilename('../../etc/passwd:1', { extension: 'json', now: NOW });
  assert.equal(hostile, 'u-etcpasswd1-2026-10-19.json');
  assert.equal(exportFilename(null, { extension: 'json', now: NOW }), 'u-account-2026-10-19.json');
});

test('the bundle says what the numbers are and counts what it carries', () => {
  const bundle = accountBundle({
    account: { id: 'a', username: 'tester', status: 'active', fingerprint: { userAgent: 'secret' } },
    checks: [{ checked_at: iso(NOW) }],
    content: [],
    alerts: [{ created_at: iso(NOW) }],
    now: NOW,
  });
  assert.equal(bundle.exported_at, iso(NOW));
  assert.match(bundle.source, /logged-out public view/);
  assert.deepEqual(bundle.counts, { checks: 1, content: 0, alerts: 1 });
  assert.equal(bundle.account.username, 'tester');
  assert.equal(bundle.account.fingerprint, undefined, 'the fingerprint is identity config, not history');
});

// ---------------------------------------------------------------- the route


async function seeded() {
  const repo = createMemoryRepo({ now: () => NOW });
  const account = await repo.createAccount({ username: 'tester' });
  await repo.updateAccount(account.id, { status: 'active', risk_score: 42, risk_level: 'elevated' });
  await repo.insertCheck({ account_id: account.id, checked_at: iso(NOW - DAY), status: 'active', risk_score: 40, items_sampled: 9 });
  await repo.insertCheck({ account_id: account.id, checked_at: iso(NOW), status: 'active', risk_score: 42, items_sampled: 11 });
  await repo.upsertContentItems([
    { id: 't3_a', account_id: account.id, kind: 'post', subreddit: 'test', title: 'Hello, world', created_at: iso(NOW - DAY), removal_status: 'visible' },
  ]);
  await repo.insertAlert({ account_id: account.id, created_at: iso(NOW), severity: 'warning', type: 'removal_spike', message: 'three removed' });
  return { repo, account };
}

test('GET export returns the JSON bundle as a download', async () => {
  const { repo, account } = await seeded();
  await withServer({ repo }, async (call) => {
    const res = await call('GET', `/api/accounts/${account.id}/export`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="u-tester-\d{4}-\d{2}-\d{2}\.json"/);
    const bundle = res.body;
    assert.deepEqual(bundle.counts, { checks: 2, content: 1, alerts: 1 });
    assert.equal(bundle.account.username, 'tester');
    assert.equal(bundle.checks[0].checked_at, iso(NOW), 'newest first');
  });
});

test('GET export as CSV returns one table with its declared columns', async () => {
  const { repo, account } = await seeded();
  await withServer({ repo }, async (call) => {
    const checks = await call('GET', `/api/accounts/${account.id}/export?format=csv`);
    assert.match(checks.headers.get('content-type'), /text\/csv/);
    assert.match(checks.headers.get('content-disposition'), /filename="u-tester-checks-\d{4}-\d{2}-\d{2}\.csv"/);
    assert.equal(checks.text.split('\r\n')[0], EXPORT_COLUMNS.checks.join(','));
    assert.equal(checks.text.trimEnd().split('\r\n').length, 3, 'a header and two checks');

    const content = await call('GET', `/api/accounts/${account.id}/export?format=csv&table=content`);
    assert.equal(content.text.split('\r\n')[0], EXPORT_COLUMNS.content.join(','));
    assert.match(content.text, /Hello, world/);

    const alerts = await call('GET', `/api/accounts/${account.id}/export?format=csv&table=alerts`);
    assert.match(alerts.text, /removal_spike/);
  });
});

test('export rejects an unknown table and an unknown account', async () => {
  const { repo, account } = await seeded();
  await withServer({ repo }, async (call) => {
    const bad = await call('GET', `/api/accounts/${account.id}/export?format=csv&table=passwords`);
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /table must be one of/);
    assert.equal((await call('GET', '/api/accounts/00000000-0000-4000-8000-000000000000/export')).status, 404);
  });
});

test('an account with no history exports an empty but valid file', async () => {
  const repo = createMemoryRepo({ now: () => NOW });
  const account = await repo.createAccount({ username: 'fresh' });
  await withServer({ repo }, async (call) => {
    const bundle = (await call('GET', `/api/accounts/${account.id}/export`)).body;
    assert.deepEqual(bundle.counts, { checks: 0, content: 0, alerts: 0 });
    const csv = await call('GET', `/api/accounts/${account.id}/export?format=csv`);
    assert.equal(csv.text, `${EXPORT_COLUMNS.checks.join(',')}\r\n`);
  });
});
