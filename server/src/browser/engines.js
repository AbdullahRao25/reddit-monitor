// Browser engines for REDDIT_MODE=html.
//
// Reddit serves a block page to traffic it decides is automated, and when it
// does, `hasProfileCard` fails and the check errors out rather than reporting
// a shadowban. The engine is what decides how much of that we attract.
//
// All three produce the same driver — { newPage(), close() } — because that is
// the whole contract createHtmlRedditClient needs. Swapping engines changes
// nothing downstream.
//
//   playwright  (default)  plain playwright-core Chromium. No extra install,
//                          no extra weight, and the easiest to detect: stock
//                          Playwright leaks `Runtime.enable` and friends.
//   patchright             a drop-in Playwright fork with those leaks patched
//                          out. Chromium only. Closest thing to "the same
//                          thing, quieter".
//   camoufox               Apify's JS port of Camoufox: a Firefox build that
//                          spoofs its fingerprint in C++, below the reach of
//                          page scripts. A different engine entirely, so a
//                          different detection surface.
//
// SeleniumBase is deliberately absent: it is Python-only (the `seleniumbase`
// npm package is a 0.0.0 placeholder pointing at the Python repo), so using it
// would mean running a second process in another language and coordinating the
// Reddit rate-limit queue across it. That queue is in-process state by design
// — see the Dockerfile's note about never scaling this service — and its
// UC/CDP modes solve the same problem Patchright already solves inside Node.
//
// Neither patchright nor camoufox-js is a hard dependency: each pulls its own
// browser build (hundreds of MB), so they are installed only if you choose
// them, and selecting one without installing it fails with a message saying
// exactly what to run.

export const ENGINES = ['playwright', 'patchright', 'camoufox'];
export const DEFAULT_ENGINE = 'playwright';

export function normalizeEngine(value) {
  const engine = String(value ?? '').trim().toLowerCase();
  return ENGINES.includes(engine) ? engine : DEFAULT_ENGINE;
}

// Saved engine preferences cannot activate optional drivers without a separate
// opt-in. Direct launcher calls remain available for isolated engine tests.
export function selectRuntimeEngine(value, optionalEnginesEnabled = false) {
  return optionalEnginesEnabled === true ? normalizeEngine(value) : DEFAULT_ENGINE;
}

/**
 * Was a non-empty setting something we recognise?
 *
 * Falling back silently would hand you the most detectable engine precisely
 * when you asked for a quieter one and mistyped it, so the caller warns.
 */
export function isUnknownEngine(value) {
  const engine = String(value ?? '').trim().toLowerCase();
  return engine !== '' && !ENGINES.includes(engine);
}

const INSTALL = {
  patchright: 'npm install patchright && npx patchright install chromium',
  camoufox: 'npm install camoufox-js && npx camoufox-js fetch',
};

// camoufox-js declares a peer dependency on an *older* playwright-core than
// this project uses, and has done consistently (0.12 wanted <1.61, 0.13 wants
// <1.63). npm therefore refuses to install it, and installing it anyway with
// --legacy-peer-deps pairs its Firefox build with a Playwright that may speak a
// different juggler protocol — which surfaces as an opaque launch failure, not
// as a version complaint. So we say it plainly instead.
const CAMOUFOX_PEER_HINT =
  'camoufox-js pins an older playwright-core than this project uses, so npm refuses the install and ' +
  '--legacy-peer-deps can pair it with a Playwright whose protocol its Firefox build does not match. ' +
  'Check `npm view camoufox-js peerDependencies` against `npm ls playwright-core` before relying on this engine.';

async function need(pkg, engine, load) {
  try {
    return await load(pkg);
  } catch (err) {
    throw new Error(
      `REDDIT_BROWSER_ENGINE=${engine} needs the ${pkg} package, which is not installed. ` +
        `Run: ${INSTALL[engine]}` +
        (engine === 'camoufox' ? `
${CAMOUFOX_PEER_HINT}` : '') +
        ` (original error: ${err.message})`,
    );
  }
}

// Runs `build` and, if it throws, disposes whatever was already created.
// Every launcher below allocates something (a browser process, a profile
// directory) before it can know the launch worked; without this, each failed
// launch leaks it — and a scheduler that retries hourly leaks it every hour.
async function orDispose(dispose, build) {
  try {
    return await build();
  } catch (err) {
    for (const item of dispose) await item().catch(() => {});
    throw err;
  }
}

// Reddit refuses headless reads, so the reader browser must be a real one with
// a real window. It does not have to be a window anyone looks at: placed far
// off-screen it behaves exactly the same and simply never appears. This is
// window placement, not a declared fingerprint value -- a real browser has a
// real window position and size too, so nothing here contradicts the engine.
// The size is set to an ordinary one rather than Chromium's 800x600 default.
const OFFSCREEN_ARGS = [
  '--window-position=-32000,-32000',
  '--window-size=1280,860',
  // The profile is reused, and a killed server leaves it looking crashed, so
  // suppress the "Restore pages?" bubble and the first-run prompts that would
  // otherwise sit on top of the page being read.
  '--hide-crash-restore-bubble',
  '--no-first-run',
  '--no-default-browser-check',
];

// Put the window back where a person can use it. Only Chromium-based engines
// can do this, and only through CDP; callers treat its absence as "no reveal".
function revealWith(context) {
  return async function revealWindow(page) {
    const session = await context.newCDPSession(page);
    try {
      const { windowId } = await session.send('Browser.getWindowForTarget');
      await session.send('Browser.setWindowBounds', {
        windowId,
        bounds: { left: 80, top: 60, width: 1280, height: 860, windowState: 'normal' },
      });
    } finally {
      await session.detach().catch(() => {});
    }
  };
}

// Wraps a Playwright BrowserContext in the driver the scraper expects.
// `owned` is anything that must be torn down after the context.
function driverFor(context, owned = [], { reveal = false } = {}) {
  context.setDefaultTimeout(30000);
  return {
    ...(reveal ? { revealWindow: revealWith(context) } : {}),
    async newPage() {
      return context.newPage();
    },
    async close() {
      await context.close().catch(() => {});
      for (const item of owned) await item().catch(() => {});
    },
  };
}

// ---------------------------------------------------------------- playwright

// The original launcher: a stock Chromium told what to claim about itself.
// Everything it overrides (user agent, viewport, locale, Accept-Language) is a
// value a page can read back and compare against the real engine, which is
// exactly why the other two engines override nothing.
async function launchPlaywright({ executablePath, userAgent, viewport, headless, timeout, hidden, load }) {
  const { chromium } = await load('playwright-core');
  const launchOptions = {
    headless, timeout,
    args: ['--disable-blink-features=AutomationControlled', ...(hidden && !headless ? OFFSCREEN_ARGS : [])],
  };
  if (executablePath) launchOptions.executablePath = executablePath;
  const browser = await chromium.launch(launchOptions);
  return orDispose([() => browser.close()], async () => {
    const context = await browser.newContext({
      userAgent,
      viewport,
      locale: 'en-US',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });
    return driverFor(context, [() => browser.close()], { reveal: hidden && !headless });
  });
}

// ---------------------------------------------------------------- patchright

// Patchright's own guidance, which is the opposite of the playwright engine's:
// do not set a user agent, headers or viewport, and use a persistent context.
// Its argument is that a real browser's values already agree with each other,
// so the way to look real is to stop contradicting it — overriding anything
// here re-introduces the mismatch it exists to remove.
//
// It also prefers real Google Chrome over bundled Chromium. We ask for Chrome
// and fall back loudly, because a silent fallback would quietly downgrade the
// stealth you selected this engine for.
async function launchPatchright({ executablePath, headless, channel, timeout, tempDir, profileDir, hidden, log, load }) {
  // Resolve the package before making a profile directory, or a workspace that
  // never installed patchright accrues one per attempt.
  const { chromium } = await need('patchright', 'patchright', load);
  const userDataDir = profileDir ? await keptDir(profileDir) : await tempDir();
  const base = { headless, viewport: null, timeout };
  // Only a visible (headful) browser has a window to hide.
  if (hidden && !headless) base.args = OFFSCREEN_ARGS;
  if (executablePath) base.executablePath = executablePath;

  async function start(options) {
    const context = await chromium.launchPersistentContext(userDataDir.path, options);
    // A persistent context owns its browser process. If driver setup fails
    // after launch, close that process before trying another channel or
    // removing the profile directory it still has open.
    return orDispose([() => context.close()], async () => driverFor(context, [userDataDir.cleanup], { reveal: hidden && !headless }));
  }

  return orDispose([userDataDir.cleanup], async () => {
    const wanted = channel ?? (executablePath ? null : 'chrome');
    if (wanted) {
      try {
        return await start({ ...base, channel: wanted });
      } catch (err) {
        log.warn?.(
          `Patchright could not start the "${wanted}" channel (${err.message}); ` +
            'falling back to its bundled Chromium, which Patchright rates as the weaker option. ' +
            'Install Google Chrome, or set REDDIT_BROWSER_CHANNEL= to silence this.',
        );
      }
    }
    return start(base);
  });
}

// ------------------------------------------------------------------ camoufox

// Camoufox is a patched Firefox: the fingerprint it reports is injected in
// native code, so a page cannot catch it disagreeing with itself the way it can
// with a JS-level override. launchOptions() builds the argv for it and
// BrowserForge fills in whatever we do not pin, drawn from the distribution of
// real devices — so, again, we pin nothing.
async function launchCamoufox({ headless, timeout, load }) {
  const { launchOptions } = await need('camoufox-js', 'camoufox', load);
  const { firefox } = await load('playwright-core');
  let browser;
  try {
    browser = await firefox.launch({ ...(await launchOptions({ headless })), timeout });
  } catch (err) {
    // A version mismatch lands here looking like anything but a version
    // mismatch, so attach the explanation rather than leave it to guesswork.
    throw new Error(`Camoufox failed to launch: ${err.message}
${CAMOUFOX_PEER_HINT}`);
  }
  return orDispose([() => browser.close()], async () => driverFor(await browser.newContext(), [() => browser.close()]));
}

/**
 * Builds the `createBrowser` factory createHtmlRedditClient takes.
 *
 * `load` and `tempDir` are injected so the dispatch, the fallbacks and the
 * error messages can be tested without installing a browser.
 */
export function createBrowserLauncher({
  engine = DEFAULT_ENGINE,
  channel = null,
  // Patchright only. Empty keeps the throwaway profile; a path reuses it, so a
  // solved verification outlives a restart.
  profileDir = null,
  // Keep the headful window off-screen. The read is identical and no window
  // ever appears; the driver's revealWindow() brings it back when a person
  // has to finish a challenge by hand.
  hidden = true,
  // A browser that never finishes starting would wedge every check behind it:
  // createHtmlRedditClient caches the launch promise, and a hang is not an
  // error it can recover from.
  launchTimeoutMs = 60_000,
  log = console,
  load = (name) => import(name),
  tempDir = defaultTempDir,
} = {}) {
  const chosen = normalizeEngine(engine);
  return async function createBrowser(options = {}) {
    const {
      executablePath = null,
      userAgent,
      viewport = { width: 1366, height: 900 },
      headless = true,
    } = options;

    if (chosen === 'patchright') {
      return launchPatchright({ executablePath, headless, channel, timeout: launchTimeoutMs, tempDir, profileDir, hidden, log, load });
    }
    if (chosen === 'camoufox') {
      return launchCamoufox({ headless, timeout: launchTimeoutMs, load });
    }
    return launchPlaywright({ executablePath, userAgent, viewport, headless, timeout: launchTimeoutMs, hidden, load });
  };
}

// A profile directory that is reused instead of discarded. A verification a
// person solved lives in that profile's cookies, so throwing it away means the
// next launch meets a fresh cold profile and a fresh challenge. Never cleaned
// up: that is the entire point. One process at a time — Chromium locks it.
async function keptDir(path) {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path, { recursive: true });
  return { path, cleanup: async () => {} };
}

// A throwaway profile directory for the persistent context, removed on close.
async function defaultTempDir() {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const path = await mkdtemp(join(tmpdir(), 'reddit-monitor-'));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}
