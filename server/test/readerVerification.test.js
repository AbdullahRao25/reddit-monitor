import assert from 'node:assert/strict';
import test from 'node:test';
import { createHtmlRedditClient } from '../src/redditHtml.js';
import { readerErrorDetails } from '../src/readerErrors.js';

const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const PROFILE = '<html><head><title>fixture_user - Reddit</title></head><body><span data-testid="contribution-count">3</span><time data-testid="cake-day" datetime="2020-01-01T00:00:00.000Z"></time></body></html>';
const CHALLENGE = '<html><head><title>Reddit - Prove your humanity</title></head><body><h1>Verify you are human</h1></body></html>';
const MISSING = '<html><head><title>Reddit</title></head><body><h1>Sorry, nobody on Reddit goes by that name.</h1></body></html>';
const EMPTY_POSTS = '<html><body><div id="empty-feed-content">u/fixture_user does not have any posts yet</div></body></html>';
const HIDDEN_COMMENTS = '<html><body><div id="empty-feed-content">u/fixture_user likes to keep their comments hidden</div></body></html>';
const POSTS = '<html><body><shreddit-post id="t3_abc123" post-title="Fixture post" subreddit-prefixed-name="r/fixtures" permalink="/r/fixtures/comments/abc123/fixture_post/"></shreddit-post></body></html>';
const COMMENTS = '<html><body><shreddit-profile-comment comment-id="t1_abc123" href="/r/fixtures/comments/abc123/fixture_post/def456/"><div id="-post-rtjson-content">Fixture comment</div></shreddit-profile-comment></body></html>';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(steps = [{ html: CHALLENGE }], options = {}) {
  let time = NOW;
  const browser = { launches: 0, navigations: 0, closes: 0, pages: [], options: [] };
  const driver = {
    async newPage() {
      let closeListener;
      const page = {
        html: '', address: 'about:blank', closed: false, contentReads: 0, focuses: 0, closes: 0,
        async goto(url) {
          browser.navigations++;
          const step = steps.shift() ?? { html: PROFILE };
          page.html = step.html ?? CHALLENGE;
          page.address = step.url ?? url;
          page.contentError = step.contentError;
          if (step.gotoGate) await step.gotoGate.promise;
          return { status: () => step.status ?? 200, headerValue: async () => step.retryAfter ?? null };
        },
        async waitForTimeout() {},
        async content() {
          page.contentReads++;
          if (page.contentGate) await page.contentGate.promise;
          if (page.contentError) throw page.contentError;
          return page.html;
        },
        url: () => page.address,
        isClosed: () => page.closed,
        on(event, listener) { if (event === 'close') closeListener = listener; },
        async bringToFront() {
          page.focuses++;
          if (page.focusGate) await page.focusGate.promise;
          if (page.closed) throw new Error('Target page has been closed');
        },
        async close() {
          page.closes++;
          if (page.closeError) throw page.closeError;
          page.closed = true;
          closeListener?.();
        },
      };
      browser.pages.push(page);
      return page;
    },
    async close() {
      browser.closes++;
      for (const page of browser.pages) { page.closed = true; }
    },
  };
  const reddit = createHtmlRedditClient({
    createBrowser: async launchOptions => { browser.launches++; browser.options.push(launchOptions); return driver; },
    manualVerification: true, settleMs: 0, minIntervalMs: 0, challengeGraceMs: 0,
    now: () => time, accessCooldownMs: 5_000, ...options,
  });
  return { reddit, browser, advance: ms => { time += ms; } };
}

async function retain(reddit) {
  await assert.rejects(reddit.getUserAbout('fixture_user'), err => err.code === 'browser_challenge' && err.diagnostics.attempts === 1);
}

test('manual verification is opt-in and never starts a browser when unavailable', async () => {
  const { reddit, browser } = fixture([], { manualVerification: false });
  assert.equal(reddit.getDiagnostics().manual_verification, undefined);
  for (const action of ['openVerification', 'completeVerification']) {
    await assert.rejects(reddit[action](), err => err.code === 'verification_unavailable' && err.diagnostics.attempts === 0);
  }
  assert.equal(browser.launches, 0);
  assert.equal(browser.navigations, 0);
});

test('desktop verification uses the configured engine in a headed browser without mutating options', async t => {
  const browserOptions = { executablePath: 'fixture-browser', headless: true, viewport: null };
  const { reddit, browser } = fixture([{ html: PROFILE }], { browserOptions });
  t.after(() => reddit.close());
  await reddit.getUserAbout('fixture_user');
  assert.deepEqual(browser.options, [{ executablePath: 'fixture-browser', headless: false, viewport: null }]);
  assert.equal(browserOptions.headless, true);
  assert.deepEqual(reddit.getDiagnostics().manual_verification, { available: true, active: false });
  assert.equal(browser.pages[0].closed, true, 'ordinary readable pages still close');
});

test('one real HTTP 200 challenge is retained, focused without network, and pauses reads after cooldown expiry', async t => {
  const { reddit, browser, advance } = fixture();
  t.after(() => reddit.close());
  await retain(reddit);
  const page = browser.pages[0];
  assert.equal(page.closed, false);
  const deadline = reddit.getDiagnostics().retry_at;
  assert.equal(deadline, new Date(NOW + 5_000).toISOString());
  assert.deepEqual(reddit.getDiagnostics().manual_verification, { available: true, active: true });
  assert.deepEqual(await reddit.openVerification(), { opened: true, active: true });
  assert.equal(page.focuses, 1);
  advance(5_001);
  const diagnostics = reddit.getDiagnostics();
  assert.equal(diagnostics.paused, true);
  assert.equal(diagnostics.state, 'paused');
  assert.equal(diagnostics.retry_at, null, 'expired deadlines are not presented as future retries');
  for (const action of [() => reddit.getUserAbout('another_user'), () => reddit.getUserListing('fixture_user', 'comments')]) {
    await assert.rejects(action(), err => err.code === 'browser_challenge' && err.diagnostics.attempts === 0 && err.diagnostics.retry_at === null);
  }
  assert.deepEqual(await reddit.openVerification(), { opened: true, active: true });
  assert.equal(browser.navigations, 1);
  assert.equal(browser.pages.length, 1);
  assert.equal(page.contentReads, 1, 'focusing and diagnostics never reread Reddit');
});

test('a known Reddit challenge title is sufficient without invented profile data', async t => {
  const { reddit, browser } = fixture([{ html: '<html><head><title>Reddit - Prove your humanity</title></head><body></body></html>' }]);
  t.after(() => reddit.close());
  await retain(reddit);
  assert.equal(browser.pages[0].closed, false);
  assert.equal(reddit.getDiagnostics().readable, false);
});

test('transport denial, unknown pages and the default reader never retain challenge windows', async t => {
  for (const [step, options, code] of [
    [{ status: 403, html: CHALLENGE }, {}, 'access_denied'],
    [{ html: '<html><body>Unrecognized document</body></html>' }, {}, 'unexpected_page'],
    [{ html: CHALLENGE }, { manualVerification: false }, 'browser_challenge'],
  ]) {
    const { reddit, browser } = fixture([step], options);
    t.after(() => reddit.close());
    await assert.rejects(reddit.getUserAbout('fixture_user'), err => err.code === code);
    assert.equal(browser.pages[0].closed, true);
    assert.notEqual(reddit.getDiagnostics().manual_verification?.active, true);
  }
});

test('unfinished confirmation reads the existing document once without reloading or extending cooldown', async t => {
  const { reddit, browser, advance } = fixture();
  t.after(() => reddit.close());
  await retain(reddit);
  const deadline = reddit.getDiagnostics().retry_at;
  const failure = reddit.getDiagnostics().last_failure_at;
  advance(2_000);
  await assert.rejects(reddit.completeVerification(), err => err.code === 'browser_challenge' && err.diagnostics.attempts === 0 && err.diagnostics.retry_at === deadline);
  assert.equal(browser.pages[0].contentReads, 2);
  assert.equal(browser.navigations, 1);
  assert.equal(browser.pages[0].closed, false);
  assert.equal(reddit.getDiagnostics().retry_at, deadline);
  assert.equal(reddit.getDiagnostics().last_failure_at, failure);
  advance(4_000);
  await assert.rejects(reddit.completeVerification(), err => err.diagnostics.attempts === 0 && err.diagnostics.retry_at === null);
  assert.equal(reddit.getDiagnostics().paused, true);
});

test('human fixture mutation verifies public data, closes the page and reuses the same browser session', async t => {
  const { reddit, browser } = fixture([{ html: CHALLENGE }, { html: PROFILE }]);
  t.after(() => reddit.close());
  await retain(reddit);
  const page = browser.pages[0];
  page.html = PROFILE;
  assert.deepEqual(await reddit.completeVerification(), { verified: true, username: 'fixture_user' });
  assert.equal(page.contentReads, 2);
  assert.equal(page.closed, true);
  assert.equal(reddit.getDiagnostics().paused, false);
  assert.equal(reddit.getDiagnostics().retry_at, null);
  assert.equal(reddit.getDiagnostics().readable, true);
  assert.deepEqual(reddit.getDiagnostics().manual_verification, { available: true, active: false });
  assert.equal((await reddit.getUserAbout('fixture_user')).state, 'active');
  assert.equal(browser.launches, 1);
  assert.equal(browser.navigations, 2);
});

test('human completion preserves an explicit server wait without fabricating a new failed read', async t => {
  for (const retryAfter of ['7200', new Date(NOW + 7_200_000).toUTCString()]) {
    const { reddit, browser, advance } = fixture([{ html: CHALLENGE, retryAfter }, { html: PROFILE }]);
    t.after(() => reddit.close());
    await retain(reddit);
    const failure = reddit.getDiagnostics().last_failure_at;
    const deadline = new Date(NOW + 7_200_000).toISOString();
    advance(10_000);
    browser.pages[0].html = PROFILE;
    assert.deepEqual(await reddit.completeVerification(), { verified: true, username: 'fixture_user' });
    const diagnostics = reddit.getDiagnostics();
    assert.equal(diagnostics.readable, true);
    assert.equal(diagnostics.paused, true);
    assert.equal(diagnostics.retry_at, deadline);
    assert.equal(diagnostics.pause_reason.code, 'rate_limited');
    assert.equal(diagnostics.pause_reason.attempts, 0);
    assert.equal(diagnostics.pause_reason.retry_at, deadline);
    assert.equal(diagnostics.manual_verification.active, false);
    assert.equal(diagnostics.last_failure_at, failure);
    assert.equal(diagnostics.last_error.code, 'browser_challenge', 'the original failure remains historical');
    await assert.rejects(reddit.getUserAbout('fixture_user'), err => err.code === 'rate_limited' && err.diagnostics.attempts === 0 && err.diagnostics.retry_at === deadline);
    assert.equal(browser.navigations, 1);
    assert.equal(reddit.getDiagnostics().readable, true);
    advance(7_190_001);
    assert.equal(reddit.getDiagnostics().paused, false);
    assert.equal(reddit.getDiagnostics().pause_reason, undefined);
    assert.equal((await reddit.getUserAbout('fixture_user')).state, 'active');
    assert.equal(browser.navigations, 2);
    assert.equal(browser.launches, 1);
  }
});

test('explicit missing-user UI is readable verification evidence rather than a healthy profile', async t => {
  const { reddit, browser } = fixture();
  t.after(() => reddit.close());
  await retain(reddit);
  browser.pages[0].html = MISSING;
  assert.deepEqual(await reddit.completeVerification(), { verified: true, username: 'fixture_user' });
  assert.equal(reddit.getDiagnostics().readable, true);
});

test('confirmation rejects another origin or profile path and preserves the retained page', async t => {
  const { reddit, browser } = fixture();
  t.after(() => reddit.close());
  await retain(reddit);
  const page = browser.pages[0];
  page.html = PROFILE;
  for (const address of [
    'https://other.example/user/fixture_user/',
    'https://www.reddit.com/user/another_user/',
    'https://www.reddit.com/login/',
    'https://www.reddit.com/user/fixture_user/comments/',
  ]) {
    page.address = address;
    await assert.rejects(reddit.completeVerification(), err => err.code === 'verification_unavailable' && err.diagnostics.attempts === 0);
  }
  assert.equal(page.contentReads, 1, 'wrong pages are rejected before reading their document');
  assert.equal(page.closed, false);
  assert.equal(reddit.getDiagnostics().readable, false);
});

test('confirmation cannot turn a login form, empty document or unreadable card into success', async t => {
  const { reddit, browser } = fixture();
  t.after(() => reddit.close());
  await retain(reddit);
  const page = browser.pages[0];
  for (const html of [
    '<html><head><title>Log in to Reddit</title></head><body><form action="/login"><input type="password"></form></body></html>',
    '<html><head></head><body></body></html>',
    '<html><body><span data-testid="karma-number">unknown</span><time data-testid="cake-day" datetime="invalid"></time></body></html>',
  ]) {
    page.html = html;
    await assert.rejects(reddit.completeVerification(), err => err.code === 'browser_challenge' && err.diagnostics.attempts === 0);
    assert.equal(reddit.getDiagnostics().readable, false);
  }
  assert.equal(page.closed, false);
  assert.equal(browser.navigations, 1);
});

test('navigation during confirmation cannot validate a document from another origin', async t => {
  const { reddit, browser } = fixture();
  t.after(() => reddit.close());
  await retain(reddit);
  const page = browser.pages[0];
  page.html = PROFILE;
  page.contentGate = deferred();
  const completion = reddit.completeVerification();
  await Promise.resolve();
  page.address = 'https://other.example/user/fixture_user/';
  page.contentGate.resolve();
  await assert.rejects(completion, err => err.code === 'verification_unavailable' && err.diagnostics.attempts === 0);
  assert.equal(reddit.getDiagnostics().readable, false);
  assert.equal(page.closed, false);
  assert.equal(browser.navigations, 1);
});

test('a listing challenge retains that original public profile path for confirmation', async t => {
  const { reddit, browser } = fixture();
  t.after(() => reddit.close());
  await assert.rejects(reddit.getUserListing('fixture_user', 'submitted'), err => err.code === 'browser_challenge');
  const page = browser.pages[0];
  assert.equal(page.address, 'https://www.reddit.com/user/fixture_user/submitted/');
  page.html = POSTS;
  assert.deepEqual(await reddit.completeVerification(), { verified: true, username: 'fixture_user' });
  assert.equal(browser.navigations, 1);
});

test('human completion accepts recognized empty, owner-hidden and populated listings without a profile card', async t => {
  for (const [kind, html] of [
    ['submitted', EMPTY_POSTS],
    ['comments', EMPTY_POSTS.replaceAll('posts', 'comments')],
    ['comments', HIDDEN_COMMENTS],
    ['submitted', HIDDEN_COMMENTS.replaceAll('comments', 'posts')],
    ['submitted', POSTS],
    ['comments', COMMENTS],
  ]) {
    const { reddit, browser } = fixture();
    t.after(() => reddit.close());
    await assert.rejects(reddit.getUserListing('fixture_user', kind), err => err.code === 'browser_challenge');
    const page = browser.pages[0];
    page.html = html;
    assert.deepEqual(await reddit.completeVerification(), { verified: true, username: 'fixture_user' });
    assert.equal(page.closed, true);
    assert.equal(reddit.getDiagnostics().readable, true);
    assert.equal(browser.navigations, 1);
    assert.equal(page.contentReads, 2);
  }
});

test('human completion rejects malformed cards and arbitrary empty listings on the retained listing path', async t => {
  for (const [kind, html] of [
    ['submitted', '<html><body><shreddit-post id="t3_abc123"></shreddit-post></body></html>'],
    ['comments', '<html><body><shreddit-profile-comment comment-id="t1_abc123"></shreddit-profile-comment></body></html>'],
    ['comments', '<html><body><div id="empty-feed-content">Unknown feed error</div></body></html>'],
    ['submitted', '<html><body></body></html>'],
    ['submitted', PROFILE],
  ]) {
    const { reddit, browser } = fixture();
    t.after(() => reddit.close());
    await assert.rejects(reddit.getUserListing('fixture_user', kind), err => err.code === 'browser_challenge');
    const page = browser.pages[0];
    page.html = html;
    await assert.rejects(reddit.completeVerification(), err => err.code === 'browser_challenge' && err.diagnostics.attempts === 0);
    assert.equal(page.closed, false);
    assert.equal(reddit.getDiagnostics().readable, false);
    assert.equal(browser.navigations, 1);
  }
});

test('a manually closed page stops being active without erasing its real cooldown', async t => {
  const { reddit, browser, advance } = fixture([{ html: CHALLENGE }, { html: PROFILE }]);
  t.after(() => reddit.close());
  await retain(reddit);
  await browser.pages[0].close();
  assert.deepEqual(reddit.getDiagnostics().manual_verification, { available: true, active: false });
  assert.equal(reddit.getDiagnostics().paused, true);
  await assert.rejects(reddit.openVerification(), err => err.diagnostics.attempts === 0);
  assert.equal(browser.navigations, 1);
  advance(5_001);
  assert.deepEqual(await reddit.openVerification(), { opened: true, active: false, verified: true, username: 'fixture_user' });
  assert.equal(browser.navigations, 2);
  assert.equal(browser.launches, 1);
});

test('opening verification can initiate one ordinary profile check and concurrent opens share it', async t => {
  const { reddit, browser } = fixture();
  t.after(() => reddit.close());
  const first = reddit.openVerification();
  const second = reddit.openVerification();
  assert.strictEqual(first, second);
  assert.deepEqual(await first, { opened: true, active: true });
  assert.equal(browser.navigations, 1);
  assert.equal(browser.pages[0].address, 'https://www.reddit.com/user/reddit/');
  assert.equal(browser.pages[0].focuses, 1);
});

test('concurrent regular checks retain at most one challenge page', async t => {
  const { reddit, browser } = fixture();
  t.after(() => reddit.close());
  const results = await Promise.allSettled([reddit.getUserAbout('fixture_user'), reddit.getUserAbout('another_user')]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[0].reason.diagnostics.attempts, 1);
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.diagnostics.attempts, 0);
  assert.equal(browser.pages.length, 1);
  assert.equal(browser.navigations, 1);
});

test('concurrent confirmations share a single document read and cleanup', async t => {
  const { reddit, browser } = fixture();
  t.after(() => reddit.close());
  await retain(reddit);
  browser.pages[0].html = PROFILE;
  const first = reddit.completeVerification();
  const second = reddit.completeVerification();
  assert.strictEqual(first, second);
  assert.deepEqual(await first, { verified: true, username: 'fixture_user' });
  assert.equal(browser.pages[0].contentReads, 2);
  assert.equal(browser.pages[0].closes, 1);
});

test('closing the client closes its retained window and invalidates pending confirmation', async () => {
  const { reddit, browser } = fixture();
  await retain(reddit);
  const page = browser.pages[0];
  page.html = PROFILE;
  page.contentGate = deferred();
  const confirmation = reddit.completeVerification();
  await Promise.resolve();
  await reddit.close();
  page.contentGate.resolve();
  await assert.rejects(confirmation, err => err.code === 'verification_unavailable' && err.diagnostics.attempts === 0);
  assert.equal(page.closed, true);
  assert.equal(browser.closes, 1);
  assert.equal(reddit.getDiagnostics().manual_verification.active, false);
  assert.equal(reddit.getDiagnostics().readable, false);
});

test('closing during an ordinary read cannot retain a late challenge page', async () => {
  const gotoGate = deferred();
  const { reddit, browser } = fixture([{ html: CHALLENGE, gotoGate }]);
  const attempt = reddit.getUserAbout('fixture_user');
  while (browser.navigations === 0) await new Promise(resolve => setImmediate(resolve));
  await reddit.close();
  gotoGate.resolve();
  await assert.rejects(attempt);
  assert.equal(reddit.getDiagnostics().manual_verification.active, false);
  assert.equal(browser.pages[0].closed, true);
});

test('closing during an open operation does not start a replacement browser', async () => {
  const { reddit, browser } = fixture();
  const opening = reddit.openVerification();
  await reddit.close();
  await assert.rejects(opening, err => err.code === 'verification_unavailable');
  assert.equal(browser.launches, 0);
});

test('unreadable human-verification pages return safe errors without exporting browser details', async t => {
  const { reddit, browser } = fixture();
  t.after(() => reddit.close());
  await retain(reddit);
  browser.pages[0].contentError = new Error('Cookie: session=private https://reddit.example/?access_token=secret C:\\private\\profile');
  await assert.rejects(reddit.completeVerification(), err => {
    assert.equal(err.code, 'verification_unavailable');
    assert.equal(err.diagnostics.attempts, 0);
    assert.doesNotMatch(JSON.stringify(readerErrorDetails(err)), /private|secret|access_token|Cookie/);
    return true;
  });
  assert.equal(browser.navigations, 1);
  assert.equal(browser.pages[0].closed, false);
});

test('failure to close a verified page disposes its browser instead of leaking a retained page', async () => {
  const { reddit, browser } = fixture();
  await retain(reddit);
  browser.pages[0].html = PROFILE;
  browser.pages[0].closeError = new Error('Cannot close fixture page');
  await assert.rejects(reddit.completeVerification(), err => err.code === 'browser_error');
  assert.equal(browser.closes, 1);
  assert.equal(reddit.getDiagnostics().manual_verification.active, false);
  assert.notEqual(reddit.getDiagnostics().readable, true);
  await reddit.close();
});
