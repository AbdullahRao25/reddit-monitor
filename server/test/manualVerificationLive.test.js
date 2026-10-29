import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { createBrowserLauncher } from '../src/browser/engines.js';
import { createHtmlRedditClient } from '../src/redditHtml.js';
import { silentLog } from './helpers.js';

// This is a local fixture button, not a real CAPTCHA. It simulates a human
// completing verification and the site retaining its result in the same session.
const PROFILE = '<html><head><title>fixture_user - Reddit</title></head><body>' +
  '<span data-testid="karma-number">100</span> 40 post karma, 60 comment karma' +
  '<time data-testid="cake-day" datetime="2020-01-01T00:00:00Z">6 y</time></body></html>';
const CHALLENGE = '<html><head><title>Reddit - Prove your humanity</title></head><body>' +
  '<h1>Verify you are human</h1><button id="fixture-human-action">Finish fixture verification</button>' +
  '<script>document.querySelector("button").onclick = async () => {' +
  'await fetch("/fixture-human-action", {method:"POST"}); location.reload();};</script></body></html>';

test('human verification preserves a real browser session for later public reads', async t => {
  const launch = createBrowserLauncher({ engine: 'playwright', log: silentLog, launchTimeoutMs: 20_000 });
  let browser;
  try { browser = await launch({ headless: true }); }
  catch { return t.skip('Local Chromium is not installed.'); }
  t.after(() => browser.close());
  let reads = 0;
  let humanActions = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (req.url === '/fixture-human-action' && req.method === 'POST') {
      humanActions++;
      res.writeHead(200, { 'set-cookie': 'fixture_verified=yes; Path=/; HttpOnly' });
      res.end('ok');
      return;
    }
    reads++;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(req.headers.cookie?.includes('fixture_verified=yes') ? PROFILE : CHALLENGE);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  let page;
  let launches = 0;
  const reddit = createHtmlRedditClient({
    manualVerification: true,
    minIntervalMs: 0,
    settleMs: 0,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    createBrowser: async options => {
      assert.equal(options.headless, false, 'production manual mode requests a visible browser');
      launches++;
      return {
        newPage: async () => { page = await browser.newPage(); return page; },
        close: () => browser.close(),
      };
    },
  });
  t.after(() => reddit.close());
  await assert.rejects(reddit.getUserAbout('fixture_user'), error => error.code === 'browser_challenge');
  assert.equal(reddit.getDiagnostics().manual_verification.active, true);
  assert.equal(page.isClosed(), false, 'the challenge tab stays open for the human');
  await reddit.openVerification();
  await assert.rejects(reddit.completeVerification());
  assert.equal(reads, 1, 'opening and unfinished completion do not reload the site');
  assert.equal(humanActions, 0, 'the monitor does not interact with the challenge');

  // Only this test's explicit simulated human action releases its local fixture.
  await page.locator('#fixture-human-action').click();
  await page.locator('[data-testid="karma-number"]').waitFor();
  const verified = await reddit.completeVerification();
  assert.equal(verified.verified, true);
  assert.equal(verified.username, 'fixture_user');
  assert.equal(reddit.getDiagnostics().paused, false);
  assert.equal(reddit.getDiagnostics().readable, true);
  assert.equal(page.isClosed(), true);
  assert.equal((await reddit.getUserAbout('fixture_user')).state, 'active');
  assert.equal(launches, 1, 'checks reuse the browser that the human verified');
  assert.equal(humanActions, 1);
});
