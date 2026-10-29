import assert from 'node:assert/strict';
import test from 'node:test';
import { createChecker } from '../src/checker.js';
import { createHtmlRedditClient } from '../src/redditHtml.js';
import { createScheduler } from '../src/scheduler.js';
import { HOUR, NOW, createMemoryRepo, silentLog } from './helpers.js';
import { withServer } from './harness.js';

// Exercise the real HTML reader/checker/API boundary with local responses.
// A successful check establishes the history that a later access failure
// must leave intact; these tests never navigate to Reddit or use credentials.
const PROFILE = `<html><head><title>tester (u/tester) - Reddit</title></head><body>
  <faceplate-tooltip><span data-testid="karma-number">3,200</span> 800 post karma, 2400 comment karma</faceplate-tooltip>
  <time datetime="2020-01-01T00:00:00.000Z" data-testid="cake-day">6 y</time>
</body></html>`;
const POST_DATE = new Date(NOW - 2 * HOUR).toISOString();
const COMMENT_DATE = new Date(NOW - HOUR).toISOString();
const POSTS = `<html><body><shreddit-post id="t3_abc123" post-title="A useful post" score="12"
  created-timestamp="${POST_DATE}" subreddit-prefixed-name="r_test" author="tester"
  domain="self.test" permalink="/r/test/comments/abc123/a_useful_post/">
</shreddit-post></body></html>`;
const COMMENTS = `<html><body><article aria-label="A useful discussion">
  <shreddit-profile-comment comment-id="t1_def456" author-name="tester"
    comment-created-timestamp="${COMMENT_DATE}" href="/r/test/comments/abc123/discussion/def456/">
    <div id="-post-rtjson-content"><p>A helpful public comment.</p></div>
  </shreddit-profile-comment>
</article></body></html>`;

function readerFixture() {
  let clock = NOW;
  let failure = null;
  let profileHtml = PROFILE;
  const calls = { launches: 0, reads: 0, closes: 0 };
  const reddit = createHtmlRedditClient({
    now: () => clock,
    sleep: async () => {},
    minIntervalMs: 0,
    settleMs: 0,
    createBrowser: async () => {
      calls.launches++;
      return {
        async newPage() {
          let current;
          return {
            async goto(url) {
              calls.reads++;
              const path = new URL(url).pathname;
              const which = path.endsWith('/submitted/') ? 'submitted' : path.endsWith('/comments/') ? 'comments' : 'profile';
              current = failure?.which === which
                ? failure
                : { status: 200, html: which === 'submitted' ? POSTS : which === 'comments' ? COMMENTS : profileHtml };
              if (current.error) throw new Error(current.error);
              return { status: () => current.status, headers: () => current.headers ?? {} };
            },
            async waitForTimeout() {},
            async content() {
              if (current.contentError) throw new Error(current.contentError);
              return current.html;
            },
            async title() { return current.title ?? null; },
            async close() {},
          };
        },
        async close() { calls.closes++; },
      };
    },
  });
  return {
    reddit,
    calls,
    now: () => clock,
    advance: (ms) => { clock += ms; },
    fail: (response) => { failure = { which: 'profile', status: 200, ...response }; },
    recover: () => { failure = null; },
    setProfile: (html) => { profileHtml = html; },
  };
}

const failures = [
  ['rate limit', 'rate_limited', { status: 429, headers: { 'retry-after': '60' }, html: '<title>Too Many Requests</title>' }],
  ['access denial', 'access_denied', { status: 403, html: '<title>Forbidden</title>Access denied' }],
  ['browser challenge', 'browser_challenge', { html: '<title>Just a moment...</title><div>Verify you are human</div>' }],
  ['login page', 'login_required', { html: '<title>Log in - Reddit</title><form action="/login"><input type="password"></form>' }],
  ['server failure', 'server_error', { status: 500, html: '<title>Internal Server Error</title>' }],
  ['unknown profile markup', 'unexpected_page', { html: '<title>Reddit</title><main>Unknown profile markup</main>' }],
  ['unknown comments markup', 'unexpected_page', { which: 'comments', html: '<title>Reddit</title><main>Unknown comment listing</main>' }],
  ['page read failure', 'navigation_error', { status: 200, html: '', title: 'Reddit', contentError: 'Execution context destroyed' }],
  ['navigation timeout', 'navigation_error', { error: 'page.goto: Timeout 30000ms exceeded' }],
];

for (const [name, code, response] of failures) {
  test(`an HTML ${name} preserves account health, content, and successful history`, async (t) => {
    const fixture = readerFixture();
    t.after(() => fixture.reddit.close());
    const repo = createMemoryRepo({ now: fixture.now });
    const notified = [];
    const warnings = [];
    const checker = createChecker({ repo, reddit: fixture.reddit, now: fixture.now,
      log: { ...silentLog, warn: (...args) => warnings.push(args) }, notify: async (alert) => notified.push(alert) });
    const account = await repo.createAccount({ username: 'tester' });
    const first = await checker.checkAccount(account);
    assert.equal(first.check.error, null);
    assert.equal(first.account.status, 'active');
    assert.equal(first.account.link_karma, 800);
    assert.equal(first.account.comment_karma, 2400);
    assert.equal(typeof first.account.risk_score, 'number');
    assert.equal(repo.content.size, 2);
    const previousContent = structuredClone([...repo.content.values()]);
    const successfulCheck = structuredClone(first.check);
    const previousHealth = Object.fromEntries([
      'status', 'risk_score', 'risk_level', 'link_karma', 'comment_karma',
      'items_sampled', 'items_removed', 'last_seen_active_at', 'early_risk_level',
    ].map((key) => [key, first.account[key]]));

    fixture.advance(HOUR);
    fixture.fail(response);
    await withServer({ repo, checker, reddit: fixture.reddit }, async (call) => {
      const checked = await call('POST', `/api/accounts/${account.id}/check`);
      assert.equal(checked.status, 200);
      assert.equal(checked.body.check.status, 'error');
      const factor = checked.body.check.factors.find((item) => item.key === 'reader_error');
      assert.equal(factor?.diagnostics.code, code);
      assert.equal(factor.diagnostics.http_status, response.error ? null : response.status ?? 200);
      if (response.title) assert.equal(factor.diagnostics.page_title, response.title);
      const failureLog = warnings.find(([message]) => message.startsWith('Check failed for '));
      assert.deepEqual(failureLog?.[1], { reader: factor.diagnostics }, 'local failure logs expose the same safe diagnostic allowlist');
      assert.equal(factor.points, 0);
      for (const [key, value] of Object.entries(previousHealth)) {
        assert.equal(checked.body.account[key], value, `${key} changed after ${name}`);
      }
      assert.deepEqual([...repo.content.values()], previousContent);
      assert.deepEqual(repo.checks.find((item) => item.id === successfulCheck.id), successfulCheck);
      assert.equal(checked.body.check.newly_removed, 0);
      assert.deepEqual(checked.body.alerts, []);
      assert.deepEqual(notified, []);

      const detail = await call('GET', `/api/accounts/${account.id}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.body.stale, true);
      assert.equal(detail.body.last_successful_check_at, successfulCheck.checked_at);
      assert.equal(detail.body.lastError.diagnostics.code, code);
      assert.deepEqual(detail.body.lastError.diagnostics, factor.diagnostics, 'observed HTTP details survive storage and the account API');
      assert.deepEqual(detail.body.latestCheck, successfulCheck);
      assert.equal(detail.body.history.length, 1);
      assert.equal(detail.body.recent.length, 2);
    });
  });
}

test('unknown HTML karma preserves known totals while an explicit zero updates normally', async (t) => {
  const fixture = readerFixture();
  t.after(() => fixture.reddit.close());
  const repo = createMemoryRepo({ now: fixture.now });
  const checker = createChecker({ repo, reddit: fixture.reddit, now: fixture.now, log: silentLog });
  const account = await repo.createAccount({ username: 'tester' });
  const first = await checker.checkAccount(account);
  assert.equal(first.account.link_karma, 800);
  assert.equal(first.account.comment_karma, 2400);

  fixture.advance(HOUR);
  fixture.setProfile(`<html><head><title>tester - Reddit</title></head><body>
    <time datetime="2020-01-01T00:00:00.000Z" data-testid="cake-day">6 y</time>
  </body></html>`);
  const partial = await checker.checkAccount(await repo.getAccount(account.id));
  assert.equal(partial.check.error, null);
  assert.equal(partial.account.link_karma, 800);
  assert.equal(partial.account.comment_karma, 2400);
  assert.equal(partial.check.link_karma, null, 'unknown karma must stay distinguishable from zero in history');
  assert.equal(partial.check.comment_karma, null);

  fixture.advance(HOUR);
  fixture.setProfile(PROFILE.replace('3,200', '0').replace('800 post karma, 2400 comment karma', '0 post karma, 0 comment karma'));
  const zero = await checker.checkAccount(await repo.getAccount(account.id));
  assert.equal(zero.check.error, null);
  assert.equal(zero.account.link_karma, 0);
  assert.equal(zero.account.comment_karma, 0);
  assert.equal(zero.check.link_karma, 0);
  assert.equal(zero.check.comment_karma, 0);
});

test('status polling reports an unverified HTML reader without launching or reading', async (t) => {
  const fixture = readerFixture();
  t.after(() => fixture.reddit.close());
  let verified = 0;
  fixture.reddit.verify = async () => { verified++; throw new Error('Routine status must use cached diagnostics'); };
  await withServer({ repo: createMemoryRepo(), reddit: fixture.reddit }, async (call) => {
    for (let i = 0; i < 3; i++) {
      const result = await call('GET', '/api/status');
      assert.equal(result.status, 200);
      assert.equal(result.body.reddit.ok, null);
      assert.equal(result.body.reddit.reader.state, 'unverified');
      assert.equal(result.body.reddit.reader.readable, null);
      assert.equal(result.body.reddit.reader.browser.state, 'not_started');
    }
  });
  assert.equal(verified, 0);
  assert.deepEqual(fixture.calls, { launches: 0, reads: 0, closes: 0 });
});

test('status distinguishes browser readiness, a readable page, and an access cooldown', async (t) => {
  const fixture = readerFixture();
  t.after(() => fixture.reddit.close());
  await fixture.reddit.verify();
  await withServer({ repo: createMemoryRepo(), reddit: fixture.reddit }, async (call) => {
    let result = await call('GET', '/api/status');
    assert.equal(result.body.reddit.ok, null);
    assert.equal(result.body.reddit.reader.browser.state, 'ready');
    assert.equal(result.body.reddit.reader.readable, null);
    await fixture.reddit.getUserAbout('tester');
    const reads = fixture.calls.reads;
    result = await call('GET', '/api/status');
    assert.equal(result.body.reddit.ok, true);
    assert.equal(result.body.reddit.reader.last_success_at, new Date(NOW).toISOString());
    assert.equal(fixture.calls.reads, reads);

    fixture.advance(HOUR);
    fixture.fail(failures[0][2]);
    await assert.rejects(() => fixture.reddit.getUserAbout('tester'));
    const failedReads = fixture.calls.reads;
    result = await call('GET', '/api/status');
    assert.equal(result.body.reddit.ok, false);
    assert.equal(result.body.reddit.reader.paused, true);
    assert.equal(result.body.reddit.reader.state, 'paused');
    assert.equal(result.body.reddit.reader.last_error.code, 'rate_limited');
    assert.equal(result.body.reddit.reader.last_success_at, new Date(NOW).toISOString());
    assert.equal(fixture.calls.reads, failedReads);
  });
});

const flushRun = () => new Promise((resolve) => setImmediate(resolve));

test('the scheduler skips a reader cooldown and resumes when the reader can retry', async (t) => {
  const fixture = readerFixture();
  t.after(() => fixture.reddit.close());
  fixture.fail(failures[0][2]);
  await assert.rejects(() => fixture.reddit.getUserAbout('tester'));
  const repo = createMemoryRepo({ now: fixture.now });
  const account = await repo.createAccount({ username: 'tester' });
  const checker = createChecker({ repo, reddit: fixture.reddit, now: fixture.now, log: silentLog });
  const scheduler = createScheduler({ repo, reddit: fixture.reddit, checker, intervalMinutes: 60, now: fixture.now, sleep: async () => {}, log: silentLog });
  t.after(() => scheduler.stop());
  scheduler.trigger();
  await flushRun();
  assert.equal(repo.checks.length, 0, 'a cooldown must not write failed checks for every due account');
  assert.equal(fixture.calls.reads, 1);
  assert.equal(scheduler.status().readerPaused, true);
  const retryAt = scheduler.status().retryAt;
  assert.ok(retryAt);

  fixture.advance(Date.parse(retryAt) - fixture.now() + 1);
  fixture.recover();
  scheduler.trigger();
  // The real checker crosses several asynchronous boundaries. Wait for the
  // scheduler to finish without a real timer or Reddit request.
  for (let i = 0; i < 10 && scheduler.status().running; i++) await flushRun();
  assert.equal(repo.checks.length, 1);
  assert.equal((await repo.getAccount(account.id)).status, 'active');
  assert.equal(scheduler.status().readerPaused, false);
  assert.equal(scheduler.status().retryAt, null);
});

test('the scheduler stops the current sweep when its first check starts a reader cooldown', async () => {
  const repo = createMemoryRepo({ now: () => NOW });
  await repo.createAccount({ username: 'first' });
  await repo.createAccount({ username: 'second' });
  let paused = false;
  const checked = [];
  const reddit = { getDiagnostics: () => ({ mode: 'html', paused, retry_at: paused ? new Date(NOW + HOUR).toISOString() : null }) };
  const scheduler = createScheduler({
    repo, reddit, intervalMinutes: 60, now: () => NOW, sleep: async () => {}, log: silentLog,
    checker: { async checkAccount(account) { checked.push(account.username); paused = true; } },
  });
  scheduler.trigger();
  await flushRun();
  scheduler.stop();
  assert.deepEqual(checked, ['first']);
  assert.equal(scheduler.status().readerPaused, true);
});
