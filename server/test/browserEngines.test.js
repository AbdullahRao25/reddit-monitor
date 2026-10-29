import assert from 'node:assert/strict';
import test from 'node:test';
import { ENGINES, DEFAULT_ENGINE, createBrowserLauncher, normalizeEngine, selectRuntimeEngine } from '../src/browser/engines.js';
import { silentLog } from './helpers.js';

// No browser is installed in CI, so `load` and `tempDir` are injected: these
// tests cover which engine is chosen, what it is asked to launch with, and
// what it says when the package is missing — not whether Chromium starts.

function fakeContext(record) {
  return {
    setDefaultTimeout(ms) { record.timeout = ms; },
    async newPage() { return { id: 'page' }; },
    async close() { record.contextClosed = true; },
  };
}

function fakePlaywright(record) {
  return {
    chromium: {
      async launch(options) {
        record.launch = options;
        return {
          async newContext(options) { record.newContext = options; return fakeContext(record); },
          async close() { record.browserClosed = true; },
        };
      },
    },
    firefox: {
      async launch(options) {
        record.firefoxLaunch = options;
        return {
          async newContext(options) { record.newContext = options; return fakeContext(record); },
          async close() { record.browserClosed = true; },
        };
      },
    },
  };
}

function fakePatchright(record, { failChannels = [] } = {}) {
  return {
    chromium: {
      async launchPersistentContext(dir, options) {
        record.persistent = { dir, options };
        record.attempts = [...(record.attempts ?? []), options.channel ?? null];
        if (failChannels.includes(options.channel)) throw new Error(`no ${options.channel} here`);
        return fakeContext(record);
      },
    },
  };
}

const fakeTempDir = (record) => async () => ({
  path: '/tmp/fake-profile',
  cleanup: async () => { record.cleaned = true; },
});

function harness({ modules, ...opts } = {}) {
  const record = {};
  const load = async (name) => {
    const mod = modules(record)[name];
    if (!mod) throw new Error(`Cannot find package '${name}'`);
    return mod;
  };
  const launcher = createBrowserLauncher({ log: silentLog, load, tempDir: fakeTempDir(record), ...opts });
  return { record, launcher };
}

// ------------------------------------------------------------------ dispatch

test('the engine list and default are what the config validates against', () => {
  assert.deepEqual(ENGINES, ['playwright', 'patchright', 'camoufox']);
  assert.equal(DEFAULT_ENGINE, 'playwright');
});

test('an unknown, empty or malformed engine falls back to playwright', () => {
  for (const value of ['', null, undefined, 'selenium', 'SeleniumBase', 'chrome', 42, {}]) {
    assert.equal(normalizeEngine(value), 'playwright', JSON.stringify(value));
  }
});

test('engine names are matched case- and whitespace-insensitively', () => {
  assert.equal(normalizeEngine('  PatchRight '), 'patchright');
  assert.equal(normalizeEngine('CAMOUFOX'), 'camoufox');
});

test('saved optional engine selections stay disabled without an explicit boolean opt-in', () => {
  for (const engine of ['patchright', 'camoufox', '  PatchRight ', 'CAMOUFOX']) {
    assert.equal(selectRuntimeEngine(engine), 'playwright');
    for (const enabled of [undefined, false, null, '', 'false', 'true', 0, 1]) {
      assert.equal(selectRuntimeEngine(engine, enabled), 'playwright');
    }
    assert.equal(selectRuntimeEngine(engine, true), normalizeEngine(engine));
  }
});

test('runtime selection normalizes ordinary, unknown and malformed engine settings', () => {
  for (const engine of ['playwright', ' PLAYWRIGHT ', '', undefined, null, 'SeleniumBase', 'typo', 42, {}]) {
    assert.equal(selectRuntimeEngine(engine), 'playwright');
    assert.equal(selectRuntimeEngine(engine, false), 'playwright');
    assert.equal(selectRuntimeEngine(engine, true), 'playwright');
  }
});

test('disabled optional engines launch only Playwright and never load their packages', async () => {
  for (const engine of ['patchright', 'camoufox']) {
    for (const enabled of [undefined, false]) {
      const record = {};
      const loaded = [];
      const launcher = createBrowserLauncher({
        engine: selectRuntimeEngine(engine, enabled),
        log: silentLog,
        load: async (name) => {
          loaded.push(name);
          assert.equal(name, 'playwright-core');
          return fakePlaywright(record);
        },
        tempDir: async () => assert.fail('disabled engines must not allocate a persistent profile'),
      });
      const driver = await launcher();
      assert.deepEqual(loaded, ['playwright-core']);
      assert.ok(record.launch, 'the standard Chromium launcher was used');
      assert.equal(record.persistent, undefined);
      assert.equal(record.firefoxLaunch, undefined);
      await driver.close();
      assert.equal(record.browserClosed, true);
    }
  }
});

// ---------------------------------------------------------------- playwright

test('the playwright engine declares a user agent, viewport and language', () => {
  return (async () => {
    const { record, launcher } = harness({ engine: 'playwright', modules: (r) => ({ 'playwright-core': fakePlaywright(r) }) });
    const driver = await launcher({ userAgent: 'UA/1.0', viewport: { width: 800, height: 600 } });
    assert.equal(record.newContext.userAgent, 'UA/1.0');
    assert.deepEqual(record.newContext.viewport, { width: 800, height: 600 });
    assert.equal(record.newContext.locale, 'en-US');
    assert.ok(record.newContext.extraHTTPHeaders['Accept-Language']);
    assert.ok(record.launch.args.includes('--disable-blink-features=AutomationControlled'));
    assert.equal(record.timeout, 30000);
    assert.deepEqual(await driver.newPage(), { id: 'page' });
  })();
});

test('the playwright engine honours an explicit executable path', async () => {
  const { record, launcher } = harness({ engine: 'playwright', modules: (r) => ({ 'playwright-core': fakePlaywright(r) }) });
  await launcher({ executablePath: '/usr/bin/chromium' });
  assert.equal(record.launch.executablePath, '/usr/bin/chromium');
});

test('closing the playwright driver closes the context and the browser', async () => {
  const { record, launcher } = harness({ engine: 'playwright', modules: (r) => ({ 'playwright-core': fakePlaywright(r) }) });
  await (await launcher({})).close();
  assert.equal(record.contextClosed, true);
  assert.equal(record.browserClosed, true);
});

// ---------------------------------------------------------------- patchright

test('the patchright engine overrides nothing and uses a persistent context', async () => {
  const { record, launcher } = harness({ engine: 'patchright', modules: (r) => ({ patchright: fakePatchright(r) }) });
  await launcher({ userAgent: 'UA/1.0', viewport: { width: 800, height: 600 } });
  const { options } = record.persistent;
  // The whole point of this engine: a real browser's values already agree with
  // each other, so contradicting them is what gets you caught.
  assert.equal(options.userAgent, undefined, 'must not claim a user agent');
  assert.equal(options.extraHTTPHeaders, undefined, 'must not inject headers');
  assert.equal(options.viewport, null, 'must not pin a viewport');
  assert.equal(record.persistent.dir, '/tmp/fake-profile');
});

test('a configured profile directory is reused and never cleaned up', async (t) => {
  // What a person solves in the reader browser lives in that profile's
  // cookies. Deleting it on close would ask them again after every restart.
  const { mkdtemp, rm, stat } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const parent = await mkdtemp(join(tmpdir(), 'engine-profile-'));
  const dir = join(parent, 'reader-profile');
  t.after(() => rm(parent, { recursive: true, force: true }));

  const { record, launcher } = harness({
    engine: 'patchright', profileDir: dir,
    modules: (r) => ({ patchright: fakePatchright(r) }),
  });
  const driver = await launcher();
  assert.equal(record.persistent.dir, dir, 'the configured directory is the profile');
  assert.ok((await stat(dir)).isDirectory(), 'and it is created if it does not exist');
  await driver.close();
  assert.equal(record.cleaned, undefined, 'the throwaway cleanup must not run on it');
  assert.ok((await stat(dir)).isDirectory(), 'so the profile survives the close');
});

test('without a profile directory patchright still uses a throwaway one', async () => {
  const { record, launcher } = harness({ engine: 'patchright', modules: (r) => ({ patchright: fakePatchright(r) }) });
  const driver = await launcher();
  assert.equal(record.persistent.dir, '/tmp/fake-profile');
  await driver.close();
  assert.equal(record.cleaned, true, 'a throwaway profile is still removed on close');
});

test('patchright asks for real Chrome first, as its docs recommend', async () => {
  const { record, launcher } = harness({ engine: 'patchright', modules: (r) => ({ patchright: fakePatchright(r) }) });
  await launcher({});
  assert.deepEqual(record.attempts, ['chrome']);
});

test('a missing Chrome channel falls back to bundled Chromium, loudly', async () => {
  const warnings = [];
  const record = {};
  const launcher = createBrowserLauncher({
    engine: 'patchright',
    log: { ...silentLog, warn: (m) => warnings.push(m) },
    load: async () => fakePatchright(record, { failChannels: ['chrome'] }),
    tempDir: fakeTempDir(record),
  });
  await launcher({});
  assert.deepEqual(record.attempts, ['chrome', null], 'tried Chrome, then the bundled build');
  assert.equal(warnings.length, 1, 'a silent downgrade would hide the weaker setup you did not choose');
  assert.match(warnings[0], /bundled Chromium/);
  assert.match(warnings[0], /REDDIT_BROWSER_CHANNEL/);
});

test('an explicit channel is used instead of guessing', async () => {
  const { record, launcher } = harness({ engine: 'patchright', channel: 'chrome-beta', modules: (r) => ({ patchright: fakePatchright(r) }) });
  await launcher({});
  assert.deepEqual(record.attempts, ['chrome-beta']);
});

test('an explicit executable path skips the channel guess entirely', async () => {
  const { record, launcher } = harness({ engine: 'patchright', modules: (r) => ({ patchright: fakePatchright(r) }) });
  await launcher({ executablePath: '/opt/chrome' });
  assert.deepEqual(record.attempts, [null]);
  assert.equal(record.persistent.options.executablePath, '/opt/chrome');
});

test('closing the patchright driver removes its throwaway profile', async () => {
  const { record, launcher } = harness({ engine: 'patchright', modules: (r) => ({ patchright: fakePatchright(r) }) });
  await (await launcher({})).close();
  assert.equal(record.contextClosed, true);
  assert.equal(record.cleaned, true, 'a leaked profile dir per launch would fill the disk');
});

test('selecting patchright without installing it says what to run', async () => {
  const { launcher } = harness({ engine: 'patchright', modules: () => ({}) });
  await assert.rejects(() => launcher({}), (err) => {
    assert.match(err.message, /REDDIT_BROWSER_ENGINE=patchright/);
    assert.match(err.message, /npm install patchright/);
    assert.match(err.message, /npx patchright install chromium/);
    return true;
  });
});

// ------------------------------------------------------------------ camoufox

test('the camoufox engine launches Firefox with its generated options', async () => {
  const { record, launcher } = harness({
    engine: 'camoufox',
    modules: (r) => ({
      'playwright-core': fakePlaywright(r),
      'camoufox-js': { async launchOptions(opts) { r.camoufoxOptions = opts; return { args: ['--camoufox'], headless: opts.headless }; } },
    }),
  });
  await launcher({ userAgent: 'UA/1.0', viewport: { width: 800, height: 600 } });
  assert.deepEqual(record.camoufoxOptions, { headless: true });
  assert.deepEqual(record.firefoxLaunch.args, ['--camoufox']);
  // Same rule as patchright: the fingerprint is injected below JS, so pinning
  // anything here would only create a contradiction.
  assert.equal(record.newContext, undefined, 'no context overrides');
});

test('camoufox ignores an executable path, since it ships its own Firefox', async () => {
  const { record, launcher } = harness({
    engine: 'camoufox',
    modules: (r) => ({
      'playwright-core': fakePlaywright(r),
      'camoufox-js': { async launchOptions() { return { args: [] }; } },
    }),
  });
  await launcher({ executablePath: '/usr/bin/chromium' });
  assert.equal(record.firefoxLaunch.executablePath, undefined);
  assert.equal(record.launch, undefined, 'never starts Chromium');
});

test('selecting camoufox without installing it says what to run, and why it may not install', async () => {
  const { launcher } = harness({ engine: 'camoufox', modules: (r) => ({ 'playwright-core': fakePlaywright(r) }) });
  await assert.rejects(() => launcher({}), (err) => {
    assert.match(err.message, /REDDIT_BROWSER_ENGINE=camoufox/);
    assert.match(err.message, /npm install camoufox-js/);
    assert.match(err.message, /npx camoufox-js fetch/);
    // camoufox-js pins an older playwright-core than this project uses, so the
    // install is refused; without this the user just sees npm's ERESOLVE wall.
    assert.match(err.message, /pins an older playwright-core/);
    return true;
  });
});

test('a camoufox launch failure explains the version mismatch it usually is', async () => {
  const { launcher } = harness({
    engine: 'camoufox',
    modules: (r) => ({
      'playwright-core': { firefox: { async launch() { throw new Error('Protocol error: connection closed'); } } },
      'camoufox-js': { async launchOptions() { return {}; } },
    }),
  });
  await assert.rejects(() => launcher({}), (err) => {
    assert.match(err.message, /Camoufox failed to launch: Protocol error/);
    assert.match(err.message, /pins an older playwright-core/, 'an opaque protocol error is the symptom, not the cause');
    return true;
  });
});

// ------------------------------------------------------------------ contract

test('every engine returns the same driver the scraper expects', async () => {
  const cases = [
    ['playwright', (r) => ({ 'playwright-core': fakePlaywright(r) })],
    ['patchright', (r) => ({ patchright: fakePatchright(r) })],
    ['camoufox', (r) => ({ 'playwright-core': fakePlaywright(r), 'camoufox-js': { async launchOptions() { return {}; } } })],
  ];
  for (const [engine, modules] of cases) {
    const { launcher } = harness({ engine, modules });
    const driver = await launcher({});
    assert.equal(typeof driver.newPage, 'function', engine);
    assert.equal(typeof driver.close, 'function', engine);
    assert.deepEqual(await driver.newPage(), { id: 'page' }, engine);
    await driver.close();
  }
});

test('headless is overridable for debugging, on every engine', async () => {
  const { record: a, launcher: playwright } = harness({ engine: 'playwright', modules: (r) => ({ 'playwright-core': fakePlaywright(r) }) });
  await playwright({ headless: false });
  assert.equal(a.launch.headless, false);

  const { record: b, launcher: patchright } = harness({ engine: 'patchright', modules: (r) => ({ patchright: fakePatchright(r) }) });
  await patchright({ headless: false });
  assert.equal(b.persistent.options.headless, false);

  const { record: c, launcher: camoufox } = harness({
    engine: 'camoufox',
    modules: (r) => ({ 'playwright-core': fakePlaywright(r), 'camoufox-js': { async launchOptions(o) { r.camoufoxOptions = o; return {}; } } }),
  });
  await camoufox({ headless: false });
  assert.equal(c.camoufoxOptions.headless, false);
});

// ------------------------------------------------------------------- leaks
//
// Every launcher allocates something before it can know the launch worked.
// The scheduler retries hourly, so anything left behind by a failure is left
// behind every hour, forever.

test('a temp profile is not created before patchright is known to be installed', async () => {
  let made = false;
  const launcher = createBrowserLauncher({
    engine: 'patchright',
    log: silentLog,
    load: async () => { throw new Error("Cannot find package 'patchright'"); },
    tempDir: async () => { made = true; return { path: '/tmp/x', cleanup: async () => {} }; },
  });
  await assert.rejects(() => launcher({}));
  assert.equal(made, false, 'a workspace without patchright would collect one dir per attempt');
});

test('a temp profile is removed when every launch attempt fails', async () => {
  let cleaned = false;
  const launcher = createBrowserLauncher({
    engine: 'patchright',
    log: silentLog,
    load: async () => ({ chromium: { async launchPersistentContext() { throw new Error('no browser'); } } }),
    tempDir: async () => ({ path: '/tmp/x', cleanup: async () => { cleaned = true; } }),
  });
  await assert.rejects(() => launcher({}), /no browser/);
  assert.equal(cleaned, true);
});

test('patchright closes a partially initialized context before fallback and profile cleanup', async () => {
  const events = [];
  const launcher = createBrowserLauncher({
    engine: 'patchright',
    log: silentLog,
    load: async () => ({
      chromium: {
        async launchPersistentContext(dir, options) {
          const name = options.channel ?? 'bundled';
          events.push(`launch ${name}`);
          return {
            setDefaultTimeout() { throw new Error('context initialization failed'); },
            async close() { events.push(`close ${name}`); },
          };
        },
      },
    }),
    tempDir: async () => ({ path: '/tmp/x', cleanup: async () => events.push('cleanup') }),
  });

  await assert.rejects(() => launcher({}), /context initialization failed/);
  assert.deepEqual(events, ['launch chrome', 'close chrome', 'launch bundled', 'close bundled', 'cleanup']);
});

test('the browser is closed when creating its context throws', async () => {
  const brokenBrowser = (state) => {
    const browser = { async newContext() { throw new Error('context failed'); }, async close() { state.closed = true; } };
    return { chromium: { async launch() { return browser; } }, firefox: { async launch() { return browser; } } };
  };
  for (const engine of ['playwright', 'camoufox']) {
    const state = { closed: false };
    const modules = { 'playwright-core': brokenBrowser(state), 'camoufox-js': { async launchOptions() { return {}; } } };
    const launcher = createBrowserLauncher({ engine, log: silentLog, load: async (n) => modules[n] });
    await assert.rejects(() => launcher({}), /context failed/, engine);
    assert.equal(state.closed, true, `${engine} left a browser process running`);
  }
});

test('a launch timeout is passed to every engine, so a hang cannot wedge the monitor', async () => {
  const seen = {};
  const run = async (engine, modules) => {
    const launcher = createBrowserLauncher({ engine, launchTimeoutMs: 1234, log: silentLog, load: async (n) => modules[n], tempDir: async () => ({ path: '/tmp/x', cleanup: async () => {} }) });
    await launcher({});
  };
  await run('playwright', { 'playwright-core': { chromium: { async launch(o) { seen.playwright = o.timeout; return { async newContext() { return fakeContext({}); }, async close() {} }; } } } });
  await run('patchright', { patchright: { chromium: { async launchPersistentContext(d, o) { seen.patchright = o.timeout; return fakeContext({}); } } } });
  await run('camoufox', {
    'playwright-core': { firefox: { async launch(o) { seen.camoufox = o.timeout; return { async newContext() { return fakeContext({}); }, async close() {} }; } } },
    'camoufox-js': { async launchOptions() { return {}; } },
  });
  assert.deepEqual(seen, { playwright: 1234, patchright: 1234, camoufox: 1234 });
});

// ---------------------------------------------------- the off-screen window

// Reddit refuses headless reads, so the reader needs a real window -- but not
// one anybody has to look at, and not one anybody can close by accident.

test('a headful browser is placed off-screen and can be brought back', async () => {
  const { record, launcher } = harness({ engine: 'patchright', modules: (r) => ({ patchright: fakePatchright(r) }) });
  const driver = await launcher({ headless: false });
  const args = record.persistent.options.args ?? [];
  assert.ok(args.includes('--window-position=-32000,-32000'), 'the window is moved off-screen');
  assert.ok(args.includes('--hide-crash-restore-bubble'), 'and the restore bubble cannot cover the page');
  assert.equal(typeof driver.revealWindow, 'function', 'a person can still be shown the window');
});

test('a visible browser is left where it is, with nothing to reveal', async () => {
  const { record, launcher } = harness({ engine: 'patchright', hidden: false, modules: (r) => ({ patchright: fakePatchright(r) }) });
  const driver = await launcher({ headless: false });
  assert.equal(record.persistent.options.args, undefined, 'no window placement is forced');
  assert.equal(driver.revealWindow, undefined, 'and there is no window to bring back');
});

test('a headless browser is never given window placement', async () => {
  // There is no window, so placing one would be meaningless.
  const { record, launcher } = harness({ engine: 'patchright', modules: (r) => ({ patchright: fakePatchright(r) }) });
  const driver = await launcher({ headless: true });
  assert.equal(record.persistent.options.args, undefined);
  assert.equal(driver.revealWindow, undefined);
});

test('the playwright engine hides its window the same way', async () => {
  const { record, launcher } = harness({ engine: 'playwright', modules: (r) => ({ 'playwright-core': fakePlaywright(r) }) });
  await launcher({ headless: false });
  const args = record.launch.args;
  assert.ok(args.includes('--window-position=-32000,-32000'));
  // Its own anti-automation flag must survive alongside the placement.
  assert.ok(args.includes('--disable-blink-features=AutomationControlled'));
});
