import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { createBrowserLauncher } from '../src/browser/engines.js';
import { createHtmlRedditClient } from '../src/redditHtml.js';
import { silentLog } from './helpers.js';

// End-to-end through a real browser, against a local fixture server.
//
// The unit tests fake the Playwright module, so they prove the dispatch but
// not that a launched browser actually satisfies the contract the scraper
// relies on — goto, waitForTimeout, content, close, and a context that can be
// reused across checks. This drives the real engine through the real parser.
//
// Nothing here touches Reddit. The fixture server serves profile markup in the
// shape the parser expects, which is also what makes it a usable regression
// test: if an engine ever starts returning a document the parser cannot read,
// this fails without anyone having to be blocked first.
//
// Engines are skipped when their package or browser is not installed, so the
// file is safe in CI.

const PROFILE = `<!doctype html>
<html><head><title>fixture_user (u/fixture_user) - Reddit</title></head><body>
  <span data-testid="karma-number">941,063</span> 184554 post karma, 756509 comment karma
  <faceplate-tooltip><span slot="trigger"><time datetime="2005-06-06T00:00:00.000Z" data-testid="cake-day">21 y</time></span></faceplate-tooltip>
</body></html>`;

const NOT_FOUND = `<!doctype html>
<html><head><title>Reddit</title></head><body><h1>Sorry, nobody on Reddit goes by that name.</h1></body></html>`;

// Ordinary Reddit illustrations can use the same Snoo CSS class prefix as
// an access page. The explicit feed state must remain readable without a card.
const EMPTY_FEED = `<!doctype html>
<html><head><title>Reddit</title><style>.snoo-cls-1 { fill: #ff4500; }</style></head><body>
  <svg viewBox="0 0 10 10"><path class="snoo-cls-1" d="M0 0h10v10H0z"/></svg>
  <div id="empty-feed-content">u/fixture_user doesn't have any posts yet</div>
</body></html>`;
const HIDDEN_FEED = EMPTY_FEED.replace("doesn't have any posts yet", 'likes to keep their comments hidden');

async function fixtureServer() {
  const server = http.createServer((req, res) => {
    const known = req.url.startsWith('/user/fixture_user');
    res.writeHead(known ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(!known ? NOT_FOUND : req.url.startsWith('/user/fixture_user/submitted/') ? EMPTY_FEED
      : req.url.startsWith('/user/fixture_user/comments/') ? HIDDEN_FEED : PROFILE);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

// Can this engine actually start here? Returns null when it can, or the reason
// to skip. Keeps an uninstalled engine from failing the suite.
async function unavailable(engine) {
  try {
    const driver = await createBrowserLauncher({ engine, log: silentLog, launchTimeoutMs: 20_000 })({});
    await driver.close();
    return null;
  } catch (err) {
    return err.message.split('\n')[0].slice(0, 120);
  }
}

for (const engine of ['playwright', 'patchright', 'camoufox']) {
  test(`${engine}: drives the real html pipeline end to end`, async (t) => {
    const skip = await unavailable(engine);
    if (skip) return t.skip(`${engine} not available here: ${skip}`);

    const site = await fixtureServer();
    const reddit = createHtmlRedditClient({
      createBrowser: createBrowserLauncher({ engine, log: silentLog }),
      baseUrl: site.base,
      // The real client waits ≥800ms between requests; this keeps the test quick
      // without removing the serialisation it is also exercising.
      minIntervalMs: 10,
      settleMs: 10,
    });
    t.after(async () => {
      await reddit.close?.().catch(() => {});
      site.close();
    });

    const about = await reddit.getUserAbout('fixture_user');
    assert.equal(about.state, 'active', 'a readable profile should parse as active');
    assert.equal(about.profile.linkKarma, 184554);
    assert.equal(about.profile.commentKarma, 756509);
    assert.equal(new Date(about.profile.createdAt).toISOString(), '2005-06-06T00:00:00.000Z');

    assert.deepEqual(await reddit.getUserListing('fixture_user', 'submitted'), [], 'an illustrated empty feed is readable');
    assert.equal(await reddit.getUserListing('fixture_user', 'comments'), null, 'an illustrated hidden feed remains unknown');
    assert.equal(reddit.getDiagnostics().paused, false, 'ordinary feed artwork must not pause the shared reader');

    // A 404 is how a shadowban looks from outside, so it must report a state
    // rather than throw — the checker is what decides shadowbanned vs not_found,
    // from whether the account was ever seen visible.
    const missing = await reddit.getUserAbout('nobody_here');
    assert.deepEqual(missing, { state: 'not_found' });

    // The browser is shared and kept warm: a second check must reuse it rather
    // than launch a second Chromium per check.
    const again = await reddit.getUserAbout('fixture_user');
    assert.equal(again.profile.linkKarma, 184554, 'the warm browser still works');
  });
}

test('the shared browser is launched once for many checks', async (t) => {
  const skip = await unavailable('playwright');
  if (skip) return t.skip(`no browser available: ${skip}`);

  const site = await fixtureServer();
  let launches = 0;
  const base = createBrowserLauncher({ engine: 'playwright', log: silentLog });
  const reddit = createHtmlRedditClient({
    createBrowser: async (options) => { launches++; return base(options); },
    baseUrl: site.base,
    minIntervalMs: 10,
    settleMs: 10,
  });
  t.after(async () => { await reddit.close?.().catch(() => {}); site.close(); });

  // Concurrent callers must share one launch, not race into several.
  await Promise.all([
    reddit.getUserAbout('fixture_user'),
    reddit.getUserAbout('fixture_user'),
    reddit.getUserAbout('fixture_user'),
  ]);
  await reddit.getUserAbout('fixture_user');
  assert.equal(launches, 1, `launched ${launches} browsers for four checks`);
});

test('pages do not pile up: each check closes the page it opened', async (t) => {
  const skip = await unavailable('playwright');
  if (skip) return t.skip(`no browser available: ${skip}`);

  const site = await fixtureServer();
  const open = new Set();
  const base = createBrowserLauncher({ engine: 'playwright', log: silentLog });
  const reddit = createHtmlRedditClient({
    createBrowser: async (options) => {
      const driver = await base(options);
      return {
        async newPage() {
          const page = await driver.newPage();
          open.add(page);
          const close = page.close.bind(page);
          page.close = async (...args) => { open.delete(page); return close(...args); };
          return page;
        },
        close: driver.close,
      };
    },
    baseUrl: site.base,
    minIntervalMs: 10,
    settleMs: 10,
  });
  t.after(async () => { await reddit.close?.().catch(() => {}); site.close(); });

  for (let i = 0; i < 4; i++) await reddit.getUserAbout('fixture_user');
  assert.equal(open.size, 0, `${open.size} pages left open after four checks`);
});

test('an explicit verify() warms the shared browser and never closes it', async (t) => {
  const skip = await unavailable('playwright');
  if (skip) return t.skip(`no browser available: ${skip}`);

  // Explicit browser checks must not close the shared browser underneath an
  // in-progress page read. Routine /api/status polls now read cached reader
  // diagnostics instead; readerIntegration.test.js covers that boundary.
  const site = await fixtureServer();
  let launches = 0;
  let closes = 0;
  const base = createBrowserLauncher({ engine: 'playwright', log: silentLog });
  const reddit = createHtmlRedditClient({
    createBrowser: async (options) => {
      launches++;
      const driver = await base(options);
      return { newPage: driver.newPage, close: async () => { closes++; return driver.close(); } };
    },
    baseUrl: site.base,
    minIntervalMs: 10,
    settleMs: 10,
  });
  t.after(async () => { await reddit.close?.().catch(() => {}); site.close(); });

  for (let i = 0; i < 5; i++) await reddit.verify();
  assert.equal(launches, 1, 'five explicit verifications launched more than one browser');
  assert.equal(closes, 0, 'verification closed the browser checks are using');

  // And a check still works against the browser those polls warmed.
  const about = await reddit.getUserAbout('fixture_user');
  assert.equal(about.profile.linkKarma, 184554);
  assert.equal(closes, 0);
});

test('a check still works after the browser is closed and relaunched', async (t) => {
  const skip = await unavailable('playwright');
  if (skip) return t.skip(`no browser available: ${skip}`);

  // The client drops its cached driver when the browser dies; the next check
  // must start a fresh one rather than keep handing out the dead handle.
  const site = await fixtureServer();
  const reddit = createHtmlRedditClient({
    createBrowser: createBrowserLauncher({ engine: 'playwright', log: silentLog }),
    baseUrl: site.base,
    minIntervalMs: 10,
    settleMs: 10,
  });
  t.after(async () => { await reddit.close?.().catch(() => {}); site.close(); });

  assert.equal((await reddit.getUserAbout('fixture_user')).profile.linkKarma, 184554);
  await reddit.close();
  assert.equal((await reddit.getUserAbout('fixture_user')).profile.linkKarma, 184554, 'did not recover from a closed browser');
});
