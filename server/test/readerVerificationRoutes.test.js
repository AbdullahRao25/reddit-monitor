import assert from 'node:assert/strict';
import test from 'node:test';
import { manualVerificationAvailable } from '../src/readerVerification.js';
import { ReaderError } from '../src/readerErrors.js';
import { createMemoryRepo } from './helpers.js';
import { withServer } from './harness.js';

test('manual browser verification stays off unless explicitly enabled on a local desktop', () => {
  assert.equal(manualVerificationAvailable({ isLoopback: true, platform: 'win32' }), false);
  assert.equal(manualVerificationAvailable({ isLoopback: true, platform: 'win32', setting: '' }), false);
  assert.equal(manualVerificationAvailable({ isLoopback: true, platform: 'win32', setting: 'true' }), true);
  assert.equal(manualVerificationAvailable({ isLoopback: true, platform: 'darwin', setting: 'true' }), true);
  assert.equal(manualVerificationAvailable({ isLoopback: true, platform: 'linux', display: ':0', setting: 'true' }), true);
  assert.equal(manualVerificationAvailable({ isLoopback: true, platform: 'linux', setting: 'true' }), false);
  assert.equal(manualVerificationAvailable({ isLoopback: true, platform: 'linux' }), false);
  assert.equal(manualVerificationAvailable({ isLoopback: false, platform: 'win32', setting: 'true' }), false);
  assert.equal(manualVerificationAvailable({ isLoopback: true, platform: 'win32', setting: 'false' }), false);
});

function verificationReader() {
  let active = false;
  return {
    getDiagnostics: () => ({ mode: 'html', manual_verification: { available: true, active } }),
    async openVerification() { active = true; return { opened: true, active, cookies: 'never export' }; },
    async completeVerification() { active = false; return { verified: true, username: 'tester', token: 'never export' }; },
  };
}

test('verification endpoints return safe status and leave account checks to the normal pipeline', async () => {
  const repo = createMemoryRepo();
  await withServer({ repo, reddit: verificationReader() }, async call => {
    const opened = await call('POST', '/api/reader/verification/open', {});
    assert.equal(opened.status, 200);
    assert.equal(opened.body.active, true);
    assert.equal(opened.body.reader.manual_verification.active, true);
    assert.equal(opened.body.cookies, undefined);
    const completed = await call('POST', '/api/reader/verification/complete', {});
    assert.equal(completed.status, 200);
    assert.equal(completed.body.verified, true);
    assert.equal(completed.body.username, 'tester');
    assert.equal(completed.body.reader.manual_verification.active, false);
    assert.equal(completed.body.token, undefined);
  });
  assert.equal(repo.checks.length, 0, 'verification alone must not invent account observations');
});

test('unsupported readers cannot open a verification browser', async () => {
  let opens = 0;
  const reddit = { getDiagnostics: () => ({ mode: 'oauth' }), openVerification: async () => { opens++; } };
  await withServer({ repo: createMemoryRepo(), reddit }, async call => {
    for (const action of ['open', 'complete']) {
      const result = await call('POST', `/api/reader/verification/${action}`, {});
      assert.equal(result.status, 503);
      assert.match(result.body.error, /local|this computer/);
    }
  });
  assert.equal(opens, 0);
});

test('explicit verification resumes can request fresh checks without changing scheduled cadence', async () => {
  const calls = [];
  const scheduler = { trigger: options => { calls.push(options); return true; }, status: () => ({}) };
  await withServer({ repo: createMemoryRepo(), scheduler }, async call => {
    assert.equal((await call('POST', '/api/check-all', { force: true })).status, 202);
    assert.equal((await call('POST', '/api/check-all')).status, 202);
    assert.equal((await call('POST', '/api/check-all', { force: 'true' })).status, 400);
  });
  assert.deepEqual(calls, [{ force: true }, { force: false }]);
});

test('verification controls remain behind the existing workspace authentication', async () => {
  const reddit = verificationReader();
  let calls = 0;
  reddit.openVerification = async () => { calls++; };
  await withServer({ repo: createMemoryRepo(), reddit,
    auth: (req, res) => res.status(401).json({ error: 'Sign in.' }),
  }, async call => {
    for (const action of ['open', 'complete']) {
      assert.equal((await call('POST', `/api/reader/verification/${action}`, {})).status, 401);
    }
  });
  assert.equal(calls, 0);
});

test('unfinished verification returns sanitized diagnostics without exporting browser exceptions', async () => {
  const reddit = verificationReader();
  reddit.completeVerification = async () => {
    const error = new ReaderError('Finish the CAPTCHA in the monitoring browser.', {
      code: 'browser_challenge', attempts: 0, page_title: 'Reddit https://example.test/?token=private',
    });
    error.diagnostics.cookie = 'private';
    throw error;
  };
  await withServer({ repo: createMemoryRepo(), reddit }, async call => {
    const result = await call('POST', '/api/reader/verification/complete', {});
    assert.equal(result.status, 409);
    assert.equal(result.body.diagnostics.code, 'browser_challenge');
    assert.equal(result.body.diagnostics.attempts, 0);
    assert.equal(result.body.diagnostics.page_title, 'Reddit [address]');
    assert.ok(!result.text.includes('private'));
    reddit.completeVerification = async () => { throw new Error('Cookie: private /local/profile'); };
    const failed = await call('POST', '/api/reader/verification/complete', {});
    assert.equal(failed.status, 502);
    assert.ok(!failed.text.includes('private'));
  });
});
