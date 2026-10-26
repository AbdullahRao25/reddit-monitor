// Reddit client that needs no API credentials.
//
// Instead of the OAuth .json endpoints (which 403 for unauthenticated
// requests) it drives a headless Chromium against Reddit's public web pages
// and reads the data Reddit server-renders into the HTML:
//
//   /user/<name>/             -> karma totals, contributions, account age,
//                                verified-email badge, flair
//   /user/<name>/submitted/    -> posts, as <shreddit-post> elements
//   /user/<name>/comments/     -> comments, as <shreddit-profile-comment>
//
// It returns the same shape as createRedditClient(), so the checker is
// agnostic to which one is in use. Trade-offs vs the OAuth client:
//   - shadowban detection still works (a logged-out profile that 404s to
//     everyone else is the signature);
//   - removal detail is weaker: posts that vanish from the listing are
//     caught, but we can't always tell WHO removed them (no removed_by_category).
//
// A browser is only launched once and kept warm between checks. The fetch
// machinery is injectable (createBrowser) so tests can run with a fake.

import { classifyRemoval } from './content.js';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Long enough for Reddit's anti-bot interstitial to resolve into the real page.
const SETTLE_MS = 6000;
// The anti-bot page is small and contains this marker.
const CHALLENGE_MARKERS = ['document.forms[0]', 'snoo-cls-'];

export class RedditHtmlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RedditHtmlError';
  }
}

// ---------- HTML helpers (exported for tests) ----------

// Parse the attribute map of an opening tag. Tolerates the HTML entities
// Reddit leaves in the markup (&amp; etc.) and attribute values with quotes.
export function parseAttributes(tag) {
  const attrs = {};
  const re = /([a-zA-Z0-9_:.-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(tag))) {
    attrs[m[1]] = decodeEntities(m[2]);
  }
  return attrs;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ');
}

// Grab every occurrence of an opening tag's attribute string, e.g.
// html.matchAll(/<shreddit-post\b[^>]*>/g). Returns an array of attribute maps.
export function collectTags(html, tagName) {
  const re = new RegExp(`<${tagName}\\b[^>]*>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push(parseAttributes(m[0]));
  return out;
}

// Text of a tag up to its closing tag, tags stripped and entities decoded.
function tagText(html, openTagRe, closeTag) {
  const m = openTagRe.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length;
  const end = html.indexOf(closeTag, start);
  if (end === -1) return null;
  return htmlToText(html.slice(start, end));
}

function htmlToText(fragment) {
  return decodeEntities(fragment.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

const toInt = (v) => {
  const n = Number.parseInt(String(v ?? '').replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};

// "1,234" -> 1234. Reddit abbreviates large counts ("12.3k"); those are
// rounded, which is fine because only small counts are compared exactly.
export function parseCount(text) {
  const m = String(text ?? '').trim().replace(/,/g, '').match(/^(\d+(?:\.\d+)?)\s*([km])?$/i);
  if (!m) return null;
  const multiplier = { k: 1e3, m: 1e6 }[m[2]?.toLowerCase()] ?? 1;
  return Math.round(Number(m[1]) * multiplier);
}

// Reddit's timestamps -> epoch ms, or null when missing or unusable. Attributes
// carry "2026-10-12T04:28:30.964000+0000" (microseconds, colon-less offset),
// <time datetime> carries "2026-10-12T04:28:30.964Z". The first form is outside
// the ECMAScript date format, so normalise it instead of relying on the
// engine's lenient fallback parser. Anything before Reddit existed is rejected.
const REDDIT_LAUNCH_MS = Date.UTC(2005, 5, 1);
export const toMs = (v) => {
  if (!v) return null;
  const iso = String(v)
    .trim()
    .replace(/(\.\d{3})\d+/, '$1')
    .replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= REDDIT_LAUNCH_MS ? t : null;
};

// Unix seconds, the API's created_utc unit (sub-second precision dropped), or null.
export const toUnixSeconds = (v) => {
  const ms = toMs(v);
  return ms === null ? null : Math.floor(ms / 1000);
};

// "r/pics" (current markup) or "r_pics" -> "pics"; a profile post's "u_spez" -> "spez".
const subredditName = (prefixed) => (prefixed ? prefixed.replace(/^[ru][_/]/, '') : null);

// ---------- profile parsing ----------

// The profile card exposes a few data-testid hooks we lean on.
export function parseProfile(html, username) {
  if (html.includes('profile-not-found') || /404/i.test(html.match(/<title>(.*?)<\/title>/s)?.[1] ?? '')) {
    return { state: 'not_found' };
  }

  const profile = { name: username };

  const karmaText = tagText(html, /data-testid="karma-number"[^>]*>/, '</faceplate-tooltip>') ??
    tagText(html, /data-testid="karma-number"[^>]*>/, '</span>');
  if (karmaText) {
    // "941,063\n184554 post karma, 756509 comment karma"
    const nums = karmaText.match(/\d[\d,]*/g) ?? [];
    const clean = (s) => toInt(s?.replace(/,/g, ''));
    profile.linkKarma = clean(nums[1]);
    profile.commentKarma = clean(nums[2]);
  }

  // Account creation is the <time data-testid="cake-day"> in the profile card.
  // Not the first <time> on the page: on an active profile that belongs to the
  // newest post or comment in the feed, which made old accounts look new.
  const cakeTag = html.match(/<time\b[^>]*data-testid="cake-day"[^>]*>/)?.[0];
  const createdAt = toMs(cakeTag ? parseAttributes(cakeTag).datetime : null);
  if (createdAt !== null) profile.createdAt = createdAt;

  // "Contributions" in the profile card counts the account's posts and
  // comments, including ones the public can't see (filtered by AutoModerator
  // or Reddit's spam filter, removed). Compared with what the listings show,
  // it is the only public trace of content that was hidden as it was posted.
  const contributions = parseCount(html.match(/data-testid="contribution-count"[^>]*>([^<]*)</)?.[1]);
  if (contributions !== null) profile.contributions = contributions;

  // The HTML profile shows a generic "User has verifications" badge but not a
  // dedicated email-verified pill, so we can't tell that one apart. Report
  // null (unknown) rather than guess; risk scoring treats null as neutral.
  profile.hasVerifiedEmail = null;

  return { state: 'active', profile };
}

// Whether the page carries the profile card that parseProfile reads from.
export const hasProfileCard = (html) => /data-testid="(?:karma-number|cake-day|contribution-count)"/.test(html);

// ---------- listing parsing ----------

// Posts: <shreddit-post> elements carry everything as attributes.
export function parsePosts(html) {
  const seen = new Set();
  const out = [];
  for (const a of collectTags(html, 'shreddit-post')) {
    const id = a.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      name: id,
      kind: 'post',
      title: a['post-title'] ?? null,
      subreddit: subredditName(a['subreddit-prefixed-name']),
      author: a.author ?? null,
      score: toInt(a.score),
      // API-shaped field (unix seconds) so content.js's toContentItem() works.
      created_utc: toUnixSeconds(a['created-timestamp']),
      permalink: a.permalink ?? null,
      // The listing shows only what is currently visible, so no removal category.
      removed_by_category: null,
      selftext: null,
      body: null,
      link_title: null,
      url: a['content-href'] ?? null,
      domain: a.domain ?? null,
      is_self: a.domain?.startsWith('self.') ? true : false,
    });
  }
  return out;
}

// When a comment was posted, as unix seconds (null if the card has no usable
// time). Reddit's current markup puts no timestamp attribute on
// <shreddit-profile-comment>; it is in the card's "commented" meta row:
//   <faceplate-timeago ts="2026-10-12T04:28:30.964000+0000">
//     <time datetime="2026-10-12T04:28:30.964Z">12 days ago</time>
// The attributes are still read first in case Reddit brings them back. `card`
// is only this comment's own markup, so a time can't leak in from a neighbour.
function commentCreatedUtc(attrs, card) {
  const timeago = card.match(/<faceplate-timeago\b[^>]*>/)?.[0];
  const time = card.match(/<time\b[^>]*>/)?.[0];
  const candidates = [
    attrs['comment-created-timestamp'],
    attrs['created-timestamp'],
    timeago && parseAttributes(timeago).ts,
    time && parseAttributes(time).datetime,
  ];
  for (const value of candidates) {
    const seconds = toUnixSeconds(value);
    if (seconds !== null) return seconds;
  }
  return null;
}

// "/r/corporate/comments/…" -> "corporate"; a comment under a profile post
// ("/user/spez/comments/…") -> "spez", matching parsePosts' "u_spez" -> "spez".
const subredditFromPath = (path) => path?.match(/^\/(?:r|u|user)\/([^/]+)\//)?.[1] ?? null;

// Comments: <shreddit-profile-comment> elements. The body sits in the card
// text after the author / post title; we keep it as an excerpt.
export function parseComments(html) {
  const seen = new Set();
  const out = [];
  const re = /<shreddit-profile-comment\b[^>]*>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = parseAttributes(m[0]);
    const id = attrs['comment-id'] || attrs['data-feed-element-id'];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const start = m.index + m[0].length;
    const end = html.indexOf('</shreddit-profile-comment>', start);
    const card = end === -1 ? html.slice(start) : html.slice(start, end);

    // Post title comes from the aria-label on the <article> that wraps this
    // comment, which sits just before the comment element.
    const before = html.slice(Math.max(0, m.index - 400), m.index);
    const article = [...before.matchAll(/aria-label="([^"]*)"/g)].pop();
    // The rendered comment body lives in a markdown content div.
    const bodyMatch = card.match(/id="-post-rtjson-content"[^>]*>([\s\S]*?)<\/div>/);
    let excerpt = null;
    if (bodyMatch) {
      excerpt = htmlToText(bodyMatch[1]);
      if (excerpt) excerpt = excerpt.slice(0, 280);
    }
    const authorMatch = card.match(/author-name="([^"]*)"/);
    out.push({
      name: id,
      kind: 'comment',
      subreddit: subredditFromPath(attrs.href),
      author: attrs['author-name'] ?? authorMatch?.[1] ?? null,
      score: null,
      created_utc: commentCreatedUtc(attrs, card),
      permalink: attrs.href ?? null,
      removed_by_category: null,
      selftext: null,
      body: excerpt,
      link_title: article ? decodeEntities(article[1]) : null,
    });
  }
  return out;
}

// The owner can hide their posts and/or comments from the profile (Reddit's
// profile privacy settings). The listing then renders an empty state saying so
// ("u/x likes to keep their comments hidden"), which must not be read as "no
// activity": an account with no comments says "doesn't have any comments yet".
export const listingHiddenByOwner = (html) => /likes to keep their (?:posts|comments) hidden/i.test(html);

// ---------- browser driver ----------

// Build a browser driver: { newPage(): Promise<page>, close() }.
// `page` must support goto(url, {waitUntil, timeout}), waitForTimeout(ms),
// content() and close().
export async function launchBrowser({ executablePath = null, userAgent = DEFAULT_UA, viewport = { width: 1366, height: 900 } } = {}) {
  const { chromium } = await import('playwright-core');
  const launchOptions = {
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  };
  if (executablePath) launchOptions.executablePath = executablePath;
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    userAgent,
    viewport,
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  context.setDefaultTimeout(30000);
  return {
    async newPage() {
      return context.newPage();
    },
    async close() {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createHtmlRedditClient({
  createBrowser = launchBrowser,
  browserOptions = {},
  settleMs = SETTLE_MS,
  minIntervalMs = 800,
  fetchImpl = null,
} = {}) {
  // One shared browser. Callers that arrive together share a single launch
  // instead of each starting (and leaking) a Chromium.
  let driverPromise = null;
  let queue = Promise.resolve();
  let nextAllowedAt = 0;

  function ensureBrowser() {
    if (!driverPromise) {
      driverPromise = Promise.resolve()
        .then(() => createBrowser(browserOptions))
        .catch((err) => {
          driverPromise = null;
          throw err;
        });
    }
    return driverPromise;
  }

  async function getPage(url) {
    const drv = await ensureBrowser();
    let page;
    try {
      page = await drv.newPage();
    } catch (err) {
      // The browser is gone (crashed or killed): launch a fresh one next time.
      driverPromise = null;
      throw err;
    }
    try {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // Give the anti-bot interstitial time to turn into the real page.
      await page.waitForTimeout(settleMs);
      let html = await page.content();
      // If we're still on the challenge page, wait a bit more and re-read.
      if (CHALLENGE_MARKERS.some((mk) => html.includes(mk)) && !html.includes('data-testid="karma-number"')) {
        await page.waitForTimeout(settleMs);
        html = await page.content();
      }
      return { status: res ? res.status() : 200, html };
    } finally {
      await page.close().catch(() => {});
    }
  }

  // Serialize so we don't pile concurrent page loads onto one browser.
  function enqueue(task) {
    const run = queue.then(async () => {
      const wait = nextAllowedAt - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        return await task();
      } finally {
        nextAllowedAt = Math.max(nextAllowedAt, Date.now() + minIntervalMs);
      }
    });
    queue = run.catch(() => {});
    return run;
  }

  const isChallenge = (html) => CHALLENGE_MARKERS.some((mk) => html.includes(mk)) && !html.includes('data-testid="karma-number"');

  async function getUserAbout(username) {
    return enqueue(async () => {
      const { status, html } = await getPage(`https://www.reddit.com/user/${encodeURIComponent(username)}/`);
      if (status === 404 || /<title>\s*404/i.test(html)) return { state: 'not_found' };
      if (isChallenge(html)) throw new RedditHtmlError('Reddit served an anti-bot page for the profile; try again in a moment.');
      const result = parseProfile(html, username);
      // A real profile page always has the profile card. Without it Reddit served
      // something else (a block or rate-limit page), and reading that as an empty
      // profile wiped the stored karma and age and dropped the risk to 0. Failing
      // the check keeps the last known result instead.
      if (result.state === 'active' && !hasProfileCard(html)) {
        const title = html.match(/<title>(.*?)<\/title>/s)?.[1]?.trim();
        throw new RedditHtmlError(
          `Reddit returned a page without the profile card${title ? ` ("${title}")` : ''}, ` +
            'possibly because of rate limiting; the last known result is kept.',
        );
      }
      return result;
    });
  }

  async function getUserListing(username, which, limit = 100) {
    return enqueue(async () => {
      const path = which === 'submitted' ? 'submitted' : 'comments';
      const { status, html } = await getPage(`https://www.reddit.com/user/${encodeURIComponent(username)}/${path}/`);
      // null = the listing itself isn't public, as for a 404 from the API client.
      if (status === 404 || listingHiddenByOwner(html)) return null;
      if (isChallenge(html)) throw new RedditHtmlError('Reddit served an anti-bot page for the listing; try again in a moment.');
      const items = which === 'submitted' ? parsePosts(html) : parseComments(html);
      return items.slice(0, limit);
    });
  }

  // The HTML client has no separate /api/info endpoint. It returns nothing
  // "current": the checker then falls back to the listing (visible) or, for an
  // id that was stored earlier but is no longer listed, marks it removed when
  // it is newer than the oldest item still listed (so it can't have just
  // scrolled out of the ~25-item window) and otherwise keeps the last stored
  // status. We can't say who removed it, or tell a removal from a deletion.
  async function getInfo() {
    return enqueue(async () => []);
  }

  async function verify() {
    // A working browser is the only health signal we have without credentials.
    // It stays open for the checks that reuse it: GET /api/status calls this on
    // every dashboard poll, and closing the shared browser here killed any
    // check that was loading a page at that moment.
    await ensureBrowser();
  }

  return {
    getUserAbout,
    getUserListing,
    getInfo,
    verify,
    async close() {
      const pending = driverPromise;
      driverPromise = null;
      const drv = await pending?.catch(() => null);
      if (drv) await drv.close();
    },
  };
}
