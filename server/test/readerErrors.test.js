import assert from 'node:assert/strict';
import test from 'node:test';
import { ReaderError, readerErrorDetails, sanitizeReaderText } from '../src/readerErrors.js';

test('reader errors expose a safe, stable diagnostics allowlist', () => {
  const err = new ReaderError('Reddit denied this request.', {
    code: 'access_denied', http_status: 403, page_title: '<b>Denied</b> https://example.test/private?token=secret',
    occurred_at: 1792400000000, retry_at: '2026-10-19T12:00:00Z', attempts: 1,
  });
  assert.equal(err.code, 'access_denied');
  assert.equal(err.status, 403);
  assert.equal(err.diagnostics.page_title, 'Denied [address]');
  err.diagnostics.cookie = 'never export';
  const copy = readerErrorDetails(err);
  assert.deepEqual(Object.keys(copy), ['code', 'http_status', 'page_title', 'occurred_at', 'retry_at', 'temporary', 'attempts', 'message']);
  copy.code = 'changed';
  assert.equal(err.code, 'access_denied');
  assert.equal(readerErrorDetails(new Error('unstructured')), null);
});

test('reader diagnostics sanitize markup, credentials and local/navigation paths', () => {
  const text = sanitizeReaderText('<script>secret-script</script><b>Timeout</b> https://example.test/user/private?token=secret C:\\private\\profile /user/private/');
  assert.equal(text, 'Timeout [address] [path] [path]');
  assert.equal(sanitizeReaderText('Cookie: session=secret; csrf=other-secret'), '[redacted]');
  assert.equal(sanitizeReaderText('Authorization: Bearer private-token'), '[redacted]');
  assert.equal(sanitizeReaderText('access_token=private-token password=hunter2'), '[redacted] [redacted]');
  assert.equal(sanitizeReaderText('a'.repeat(500), 20).length, 20);
});

test('object construction normalizes malformed diagnostics without leaking extra fields', () => {
  const err = new ReaderError({ message: 'Unavailable', code: '<script>', http_status: 999, occurred_at: 'invalid', retry_at: 'invalid', temporary: false, attempts: 0 });
  assert.equal(err.code, 'unexpected_page');
  assert.equal(err.status, null);
  assert.equal(err.diagnostics.retry_at, null);
  assert.equal(err.diagnostics.attempts, 0);
  assert.equal(err.diagnostics.temporary, false);
  assert.ok(Date.parse(err.diagnostics.occurred_at));
});
