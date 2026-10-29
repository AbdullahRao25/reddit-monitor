import { createBrowserLauncher } from './browser/engines.js';
import { ReaderError, readerErrorDetails, sanitizeReaderText } from './readerErrors.js';
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


const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Allow ordinary client-rendered content to settle once. Challenges are reported,
// never solved or repeatedly reloaded.
const SETTLE_MS = 6000;
// Auto-submitting challenge documents use this marker. Snoo SVG/CSS names also
// appear on ordinary Reddit pages and cannot establish a browser challenge.
const CHALLENGE_MARKERS = ['document.forms[0]'];
// That marker names the mechanism: the challenge document submits itself and
// Reddit returns the real page a few seconds later. SETTLE_MS covers ordinary
// client-rendered content but not that round trip, so a document that still
// looks like a challenge is re-read for up to this long before we call it one.
// Nothing here clicks, submits or reloads anything — it waits for Reddit's own
// form to land, and a challenge outliving the grace is reported untouched.
// Measured against a live profile: headful Chrome clears at ~20 s; headless
// does not clear at all, which is why manual verification runs headful.
const CHALLENGE_GRACE_MS = 35000;
const CHALLENGE_POLL_MS = 2500;

function browserChallenge({ html, title }) {
  const contentCards = hasProfileCard(html) || /<shreddit-(?:post|profile-comment)\b/i.test(html);
  return !contentCards && (CHALLENGE_MARKERS.some((marker) => html.includes(marker)) ||
    /^Reddit\s*[-|]\s*Prove your humanity\s*$/i.test(title ?? '') ||
    /verify (?:that )?you(?:'re| are) human|checking your browser|security verification|complete the (?:captcha|security check)/i.test(visibleText(html)) ||
    /<[^>]+(?:id|class)=["'][^"']*(?:cf-chl-|(?:g-recaptcha|h-captcha)(?!-response))/i.test(html));
}

// The <title> as browserChallenge reads it, without the sanitising readTitle
// applies before a title is stored or reported.
function titleIn(html) {
  return decodeEntities(String(html).match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
}

function loginPage({ html, title, finalUrl }) {
  let redirected = false;
  try { redirected = /^\/(?:login|account\/login)(?:\/|$)/i.test(new URL(finalUrl).pathname); } catch { /* optional browser URL */ }
  return redirected || /^(?:log\s?in|sign in)(?:\s+(?:to|[-|])\s*reddit)?(?:\s*[-|]\s*reddit)?$/i.test(title ?? '') ||
    /<input\b[^>]*type=["']password["']/i.test(html) && /<form\b[^>]*(?:action=["'][^"']*login|id=["'][^"']*login)/i.test(html);
}

export class RedditHtmlError extends ReaderError {
  constructor(message, options = {}) {
    super(message, options);
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

// Grab every occurrence of an opening tag's attribute string. Returns an
// array of attribute maps.
//
// The name must end at the tag boundary. A trailing \b would not do it:
// between "t" and "-" there IS a word boundary, so <shreddit-post\b also
// matches <shreddit-post-overflow-menu>. Reddit wraps every card in
// shreddit-post-flair, -overflow-menu and -text-body, and collecting those as
// posts fails the id="t3_..." check in supportedListingCards, which condemns
// the entire listing as unparseable.
export function collectTags(html, tagName) {
  const re = new RegExp(`<${tagName}(?=[\\s/>])[^>]*>`, 'g');
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
  if (isRedditNotFound(html)) {
    return { state: 'not_found' };
  }
  if (isRedditSuspended(html)) {
    return { state: 'suspended' };
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
  const re = /<shreddit-profile-comment(?=[\s/>])[^>]*>/g;
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

function visibleText(html) {
  return htmlToText(html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' '));
}

// A transport 404 or an arbitrary "404" title alone does not establish that a
// Reddit profile is missing. Require the public site's explicit missing-user UI.
const isRedditNotFound = (html) => !hasProfileCard(html) && !/<shreddit-(?:post|profile-comment)\b/i.test(html) && (
  /<[^>]+(?:id|class|data-testid)=["'][^"']*\bprofile-not-found\b/i.test(html) ||
  /(?:sorry,?\s*)?nobody on reddit goes by that name|this (?:user|account) (?:does not|doesn't) exist/i.test(visibleText(html))
);

// Reddit states a public ban or suspension in the profile page's own UI.
// Like isRedditNotFound, require the absence of real content as well: a page
// still showing a profile card or cards is not a ban notice.
export const isRedditSuspended = (html) => !hasProfileCard(html) &&
  !/<shreddit-(?:post|profile-comment)(?=[\s/>])/i.test(html) &&
  /th(?:is|e) account (?:has been |is |was )?(?:permanently )?(?:banned|suspended)/i.test(visibleText(html));

function emptyListing(html, which) {
  const kind = which === 'submitted' ? 'posts' : 'comments';
  if (!/\bid=["']empty-feed-content["']/i.test(html)) return false;
  const text = visibleText(html);
  return new RegExp(`(?:doesn['’]t|does not) have any ${kind} yet|no ${kind} yet|hasn['’]t ${kind === 'posts' ? 'posted' : 'commented'} yet`, 'i').test(text);
}

function supportedListingCards(html, which) {
  const posts = which === 'submitted';
  const tagName = posts ? 'shreddit-post' : 'shreddit-profile-comment';
  const tags = collectTags(html, tagName);
  const permalink = value => /^\/(?:r|u|user)\/[A-Za-z0-9_-]+\/comments\/[A-Za-z0-9]+(?:\/|$)/i.test(value ?? '');
  if (posts) return tags.every(attrs => /^t3_[a-z0-9]+$/i.test(attrs.id ?? '') &&
    Boolean(attrs['post-title']?.trim()) && /^[ru][\/_][a-z0-9_-]+$/i.test(attrs['subreddit-prefixed-name'] ?? '') && permalink(attrs.permalink));
  // A fullname alone is not a parsed comment. Require the supported permalink
  // and rendered body structure, while allowing missing/invalid timestamps so
  // the checker's existing undated-item handling can preserve known dates.
  const cards = [...html.matchAll(/<shreddit-profile-comment(?=[\s/>])[^>]*>[\s\S]*?<\/shreddit-profile-comment\s*>/g)];
  return cards.length === tags.length && cards.every((match, index) => {
    const attrs = tags[index];
    return /^t1_[a-z0-9]+$/i.test(attrs['comment-id'] || attrs['data-feed-element-id'] || '') &&
      permalink(attrs.href) && /\bid=["']-post-rtjson-content["']/i.test(match[0]);
  });
}

function inspectListing(html, which) {
  if (listingHiddenByOwner(html) && /\bid=["']empty-feed-content["']/i.test(html)) return { state: 'hidden', items: null };
  const items = which === 'submitted' ? parsePosts(html) : parseComments(html);
  const tags = collectTags(html, which === 'submitted' ? 'shreddit-post' : 'shreddit-profile-comment');
  if (!supportedListingCards(html, which) || tags.length && !items.length) return { state: 'parsing_error', items: null };
  if (!items.length && !emptyListing(html, which)) return { state: 'unexpected_page', items: null };
  return { state: 'listing', items };
}

// ---------- browser driver ----------
//
// The engines live in ../browser/engines.js; this is the default one.

// Build a browser driver: { newPage(): Promise<page>, close() }.
// `page` must support goto(url, {waitUntil, timeout}), waitForTimeout(ms),
// content() and close().
export async function launchBrowser(options = {}) {
  return createBrowserLauncher({ engine: 'playwright' })({ userAgent: DEFAULT_UA, ...options });
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createHtmlRedditClient({
  createBrowser = launchBrowser,
  browserOptions = {},
  settleMs = SETTLE_MS,
  challengeGraceMs = CHALLENGE_GRACE_MS,
  challengePollMs = CHALLENGE_POLL_MS,
  minIntervalMs = 800,
  fetchImpl = null,
  manualVerification = false,
  now = () => Date.now(),
  sleep = defaultSleep,
  cooldownMs = 60_000,
  accessCooldownMs = 5 * 60_000,
  maxCooldownMs = 60 * 60_000,
  maxPending = 8,
  // Where the public pages live. Overridable so the whole pipeline — real
  // browser, real parser — can be exercised against a local fixture server
  // without touching Reddit.
  baseUrl = 'https://www.reddit.com',
} = {}) {
  // One shared browser. Callers that arrive together share a single launch
  // instead of each starting (and leaking) a Chromium.
  let driverPromise = null;
  let closePromise = null;
  let queue = Promise.resolve();
  let nextAllowedAt = 0;
  let pending = 0;
  let browserState = 'not_started';
  let readable = null;
  let lastSuccessAt = null;
  let lastFailureAt = null;
  let lastError = null;
  let retryAt = null;
  let pauseReason = null;
  const supportsVerification = manualVerification === true;
  let verificationPage = null;
  let openingVerification = null;
  let completingVerification = null;
  let lastAttemptedUsername = null;
  let sessionGeneration = 0;
  const bounded = (value, fallback, maximum) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(maximum, Number(value))) : fallback;
  const cooldown = bounded(cooldownMs, 60_000, 3_600_000);
  const accessCooldown = bounded(accessCooldownMs, 300_000, 3_600_000);
  const maxCooldown = bounded(maxCooldownMs, 3_600_000, 24 * 3_600_000);
  const queueLimit = Math.max(1, Math.min(100, Number.isInteger(maxPending) ? maxPending : 8));
  const challengeGrace = bounded(challengeGraceMs, CHALLENGE_GRACE_MS, 300_000);
  const challengePoll = Math.max(100, bounded(challengePollMs, CHALLENGE_POLL_MS, 30_000));

  function recordFailure(err) {
    lastError = readerErrorDetails(err);
    lastFailureAt = lastError?.occurred_at ?? new Date(now()).toISOString();
    readable = false;
    return err;
  }

  function error(code, message, details = {}) {
    return new RedditHtmlError(message, { code, occurred_at: now(), ...details });
  }

  function cooldownError() {
    const reason = pauseReason ?? lastError;
    return error(reason?.code ?? 'rate_limited', reason?.message ?? 'The Reddit reader is waiting before another request.', {
      ...reason, occurred_at: now(), retry_at: retryAt, attempts: 0,
    });
  }

  function currentVerification() {
    if (verificationPage) {
      try {
        if (verificationPage.page.isClosed?.()) verificationPage = null;
      } catch { verificationPage = null; }
    }
    return verificationPage;
  }

  const futureRetryAt = () => retryAt !== null && Date.parse(retryAt) > now() ? retryAt : null;

  function serverRetryDeadline(header) {
    const receivedAt = now();
    const value = String(header ?? '').trim();
    const duration = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - receivedAt;
    const deadline = receivedAt + duration;
    return Number.isFinite(duration) && duration > 0 && Number.isFinite(deadline) && deadline <= 8.64e15
      ? new Date(deadline).toISOString() : null;
  }

  function verificationError(message = 'Finish the verification in the reader browser, then confirm it in the dashboard.', code = 'browser_challenge', held = currentVerification()) {
    return error(code, message, {
      http_status: held?.response.status ?? null,
      page_title: held?.response.title ?? null,
      retry_at: futureRetryAt(), attempts: 0,
    });
  }

  function guardCooldown() {
    if (currentVerification()) throw verificationError();
    if (retryAt !== null && Date.parse(retryAt) > now()) throw cooldownError();
  }

  function recordSuccess() {
    readable = true;
    lastSuccessAt = new Date(now()).toISOString();
    retryAt = null;
    pauseReason = null;
  }

  function getDiagnostics() {
    const active = Boolean(currentVerification());
    const futureRetry = futureRetryAt();
    const paused = active || futureRetry !== null;
    return {
      mode: 'html', browser: { state: browserState },
      state: paused ? 'paused' : browserState === 'closed' ? 'unavailable' : readable === null ? 'unverified' : readable ? 'ready' : 'unavailable',
      readable: browserState === 'closed' ? false : readable,
      last_success_at: lastSuccessAt, last_failure_at: lastFailureAt,
      last_error: lastError ? { ...lastError } : null,
      paused, retry_at: futureRetry,
      ...(futureRetry && pauseReason ? { pause_reason: { ...pauseReason } } : {}),
      ...(supportsVerification ? { manual_verification: { available: true, active } } : {}),
    };
  }

  async function disposeDriver(drv) {
    const held = verificationPage;
    verificationPage = null;
    sessionGeneration++;
    driverPromise = null;
    browserState = 'error';
    try { await held?.page.close(); } catch { /* driver disposal also closes its pages */ }
    try { await drv?.close?.(); } catch { /* cleanup must not replace the read failure */ }
  }

  async function ensureBrowser() {
    if (closePromise) await closePromise;
    if (!driverPromise) {
      driverPromise = Promise.resolve()
        .then(async () => {
          const drv = await createBrowser(supportsVerification ? { ...browserOptions, headless: false } : browserOptions);
          if (!drv || typeof drv.newPage !== 'function' || typeof drv.close !== 'function') {
            await disposeDriver(drv);
            throw error('browser_error', 'The public reader browser did not provide a usable session.');
          }
          if (!closePromise) browserState = 'ready';
          return drv;
        })
        .catch(() => {
          driverPromise = null;
          browserState = 'error';
          throw recordFailure(error('browser_error', 'The public reader browser could not start. Check the configured browser installation.'));
        });
    }
    return driverPromise;
  }

  async function getPage(url, username) {
    // Was this about to reuse the warm browser, rather than start one?
    const reused = driverPromise !== null;
    try {
      return await getPageOnce(url, username);
    } catch (err) {
      // A *warm* browser that turns out to be dead is not a Reddit failure.
      // Reddit refuses headless reads, so the reader window is visible on the
      // operator's desktop and can be closed by hand between checks; a
      // long-lived Chromium can also die on its own. The next launch is clean,
      // so replace it once rather than losing the account's result.
      //
      // A browser that fails on a *fresh* launch is a real failure and is
      // reported: retrying it would just start a second broken browser. Only
      // a dead browser is retried at all -- a challenge, a login wall, a rate
      // limit or a parsing failure all mean Reddit answered, and repeating the
      // request would neither change the answer nor be polite.
      if (err?.code !== 'browser_error' || !reused || closePromise || currentVerification()) throw err;
      return getPageOnce(url, username);
    }
  }

  async function getPageOnce(url, username) {
    lastAttemptedUsername = username;
    const drv = await ensureBrowser();
    const generation = sessionGeneration;
    let page;
    try {
      page = await drv.newPage();
      if (!page || typeof page.goto !== 'function' || typeof page.content !== 'function' || typeof page.close !== 'function') {
        try { await page?.close?.(); } catch { /* partially created page */ }
        throw error('browser_error', 'The public reader browser did not provide a usable page.');
      }
    } catch {
      await disposeDriver(drv);
      throw error('browser_error', 'The public reader browser session closed or could not open a page. A fresh session will be used for the next check.');
    }
    let status = null;
    const readTitle = async (html = '') => {
      const parsed = sanitizeReaderText(decodeEntities(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ''), 160);
      if (parsed) return parsed;
      try {
        return typeof page.title === 'function' ? sanitizeReaderText(await page.title(), 160) : null;
      } catch { return null; /* titles are optional; never replace the read failure */ }
    };
    try {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (!res) throw error('navigation_error', 'The public reader received no response while opening Reddit.');
      status = res.status();
      const failedStatus = status === 429 || status === 401 || status === 403 || status >= 500;
      if (settleMs > 0 && !failedStatus) await page.waitForTimeout(settleMs);
      const readDocument = async () => {
        let body;
        try { body = await page.content(); } catch (err) {
          // Keep definitive HTTP access/rate-limit evidence even when the error
          // document itself cannot be read. It must still establish a cooldown.
          if (!failedStatus) throw err;
          return '';
        }
        if (typeof body !== 'string') {
          if (!failedStatus) throw error('parsing_error', 'The public reader could not read the page document.');
          return '';
        }
        return body;
      };
      let html = await readDocument();
      // Wait out a self-submitting challenge (see CHALLENGE_GRACE_MS). Bounded
      // by attempts rather than a clock reading, so an injected frozen `now`
      // in tests cannot spin here.
      if (!failedStatus && challengeGrace > 0) {
        const attempts = Math.ceil(challengeGrace / challengePoll);
        for (let i = 0; i < attempts && browserChallenge({ html, title: titleIn(html) }); i++) {
          if (page.isClosed?.()) break;
          await page.waitForTimeout(challengePoll);
          html = await readDocument();
        }
      }
      let retryAfter = null;
      try {
        if (typeof res.headerValue === 'function') retryAfter = await res.headerValue('retry-after');
        else if (typeof res.headers === 'function') {
          const headers = await res.headers();
          retryAfter = headers?.['retry-after'] ?? headers?.['Retry-After'] ?? null;
        }
      } catch { /* headers are optional; use a conservative default cooldown */ }
      let finalUrl = null;
      try { finalUrl = typeof page.url === 'function' ? page.url() : null; } catch { /* optional diagnostic input */ }
      const response = {
        status, html, retryAfter,
        serverRetryAt: serverRetryDeadline(retryAfter),
        title: await readTitle(html),
        finalUrl,
      };
      // Keep one real challenge document for the operator. The monitor never
      // clicks, submits, reloads or solves it; normal reads stop until the
      // operator finishes or closes this page.
      if (supportsVerification && status === 200 && browserChallenge(response) &&
        generation === sessionGeneration && browserState === 'ready' && !currentVerification() && !page.isClosed?.()) {
        const held = { page, response: { status, title: response.title }, serverRetryAt: response.serverRetryAt, username, requestedUrl: url, driver: drv, generation };
        verificationPage = held;
        try { page.on?.('close', () => { if (verificationPage === held) verificationPage = null; }); } catch { /* isClosed also detects user closure */ }
      }
      return response;
    } catch (err) {
      // A later DOM/settling failure does not erase a response already received.
      // Keep only safe observed metadata, never the browser's exception details.
      const details = { http_status: status, page_title: await readTitle() };
      if (err instanceof ReaderError) throw error(err.code, err.message, { ...err.diagnostics, ...details });
      // Inspect exception text only to classify it. Never persist it: browser
      // exceptions routinely include navigation URLs and local profile paths.
      if (/target (?:page|context|browser).*closed|browser.*(?:closed|crash|disconnect)|context.*closed|page.*crash/i.test(String(err?.message))) {
        await disposeDriver(drv);
        throw error('browser_error', 'The public reader browser session closed during the request. A fresh session will be used for the next check.', details);
      }
      throw error('navigation_error', /timeout|timed out/i.test(String(err?.message))
        ? 'The Reddit public page did not load before the browser timeout. Previous account data is unchanged.'
        : 'The Reddit public page could not be loaded. Check the connection and try again later.', details);
    } finally {
      try { if (verificationPage?.page !== page) await page?.close?.(); } catch {
        // Closing the context/browser is the fallback when an individual page
        // cannot be closed. Never keep a driver that accumulates leaked pages.
        await disposeDriver(drv);
      }
    }
  }

  // Serialize so we don't pile concurrent page loads onto one browser.
  function enqueue(task) {
    try { guardCooldown(); } catch (err) { return Promise.reject(err); }
    if (pending >= queueLimit) return Promise.reject(error('reader_busy', 'The public reader already has several checks waiting. Try again after the current checks finish.', { attempts: 0 }));
    pending++;
    const run = queue.then(async () => {
      guardCooldown();
      const wait = nextAllowedAt - now();
      if (wait > 0) await sleep(wait);
      guardCooldown();
      try {
        return await task();
      } catch (err) {
        throw recordFailure(err instanceof ReaderError ? err : error('parsing_error', 'The Reddit page could not be interpreted. Previous account data is unchanged.'));
      } finally {
        nextAllowedAt = Math.max(nextAllowedAt, now() + minIntervalMs);
      }
    });
    queue = run.catch(() => {});
    return run.finally(() => { pending--; });
  }

  function responseError(code, message, response) {
    // An earlier pause is historical once it expires; a newer error must not
    // inherit its deadline unless this response establishes a fresh cooldown.
    if (retryAt !== null && Date.parse(retryAt) <= now()) { retryAt = null; pauseReason = null; }
    const durations = { rate_limited: cooldown, access_denied: accessCooldown, browser_challenge: accessCooldown, login_required: accessCooldown, server_error: cooldown };
    let duration = durations[code] ?? 0;
    const retryMs = Math.max(0, Date.parse(response.serverRetryAt) - now()) || 0;
    // Default backoff is bounded. A valid server Retry-After is a lower bound:
    // a long server-requested pause must never cause an earlier request.
    if (duration || Number.isFinite(retryMs) && retryMs > 0) {
      duration = Math.max(Math.min(maxCooldown, duration), Number.isFinite(retryMs) ? Math.max(0, retryMs) : 0);
      if (duration > 0 && Number.isFinite(now() + duration) && now() + duration <= 8.64e15) retryAt = new Date(now() + duration).toISOString();
    }
    throw error(code, message, { http_status: response.status, page_title: response.title, retry_at: retryAt });
  }

  function validateResponse(response) {
    const { status, html } = response;
    // Transport evidence takes precedence over all untrusted page content.
    if (status === 429) responseError('rate_limited', 'Reddit temporarily limited public reads. Previous account data is unchanged; wait until the retry time.', response);
    if (status === 401 || status === 403) responseError('access_denied', 'Reddit denied access to the public reader. Previous account data is unchanged; the reader is temporarily paused.', response);
    if (status >= 500) responseError('server_error', 'Reddit returned a server error. Previous account data is unchanged; the reader will wait before another check.', response);
    if (browserChallenge(response)) responseError('browser_challenge', 'Reddit presented a browser challenge. The reader is paused; no challenge bypass is attempted and previous account data is unchanged.', response);
    if (loginPage(response)) {
      responseError('login_required', 'Reddit returned a sign-in page instead of public account data. The reader is paused and previous account data is unchanged.', response);
    }
    if (status === 404 && isRedditNotFound(html)) return 'not_found';
    if (status !== 200) responseError('unexpected_page', 'Reddit returned an unrecognized response. This does not establish an account restriction; previous account data is unchanged.', response);
    if (isRedditNotFound(html)) return 'not_found';
    return 'content';
  }

  async function getUserAbout(username) {
    return enqueue(async () => {
      const response = await getPage(`${baseUrl}/user/${encodeURIComponent(username)}/`, username);
      const { html } = response;
      if (validateResponse(response) === 'not_found') { recordSuccess(); return { state: 'not_found' }; }
      const result = parseProfile(html, username);
      // A public ban notice is a read that succeeded, not one that failed.
      if (result.state === 'suspended') { recordSuccess(); return result; }
      // A missing card alone cannot identify a rate limit or account restriction.
      // Fail the check and preserve the last result when the format is unknown.
      if (result.state === 'active' && !hasProfileCard(html)) {
        responseError('unexpected_page', 'Reddit\'s public profile page could not be recognized. Its page format may have changed; previous account data is unchanged.', response);
      }
      const stats = result.profile;
      if (![stats.linkKarma, stats.commentKarma, stats.createdAt, stats.contributions].some(value => value !== null && value !== undefined)) {
        responseError('parsing_error', 'The Reddit profile card contained no readable statistics. Its page format may have changed; previous account data is unchanged.', response);
      }
      recordSuccess();
      return result;
    });
  }

  async function getUserListing(username, which, limit = 100) {
    return enqueue(async () => {
      const path = which === 'submitted' ? 'submitted' : 'comments';
      const response = await getPage(`${baseUrl}/user/${encodeURIComponent(username)}/${path}/`, username);
      const { html } = response;
      if (validateResponse(response) === 'not_found') { recordSuccess(); return null; }
      const listing = inspectListing(html, which);
      if (listing.state === 'parsing_error') responseError('parsing_error', 'Reddit returned listing cards that the reader could not interpret. Previous content history is unchanged.', response);
      if (listing.state === 'unexpected_page') responseError('unexpected_page', 'Reddit\'s public content listing could not be recognized. It was not recorded as an empty history; previous account data is unchanged.', response);
      recordSuccess();
      // null = the listing itself isn't public, as for a 404 from the API client.
      return listing.items === null ? null : listing.items.slice(0, limit);
    });
  }

  // The HTML client has no separate /api/info endpoint. It returns nothing
  // "current": the checker then falls back to the listing (visible) or, for an
  // id that was stored earlier but is no longer listed, marks it removed when
  // it is newer than the oldest item still listed (so it can't have just
  // scrolled out of the ~25-item window) and otherwise keeps the last stored
  // status. We can't say who removed it, or tell a removal from a deletion.
  async function getInfo() {
    return [];
  }

  async function focusVerification(held) {
    // The window is normally off-screen. A person is about to use it, so put
    // it back on screen first; an engine that cannot do that just gets focus.
    try { await held.driver?.revealWindow?.(held.page); } catch { /* focus below is the fallback */ }
    try { await held.page.bringToFront?.(); } catch {
      throw verificationError('The verification window could not be focused. Check whether the reader browser is still open.', 'verification_unavailable', held);
    }
    if (currentVerification() !== held || held.generation !== sessionGeneration) {
      throw verificationError('The verification window was closed. Open verification again after the reader pause ends.', 'verification_unavailable', null);
    }
    return { opened: true, active: true };
  }

  function openVerification() {
    if (!supportsVerification) return Promise.reject(verificationError('Manual verification is unavailable for this reader.', 'verification_unavailable', null));
    if (openingVerification) return openingVerification;
    const generation = sessionGeneration;
    const operation = Promise.resolve().then(async () => {
      // An in-progress read may be the one that opens the challenge page.
      // Wait for it rather than creating another page or navigating again.
      await queue;
      if (generation !== sessionGeneration) throw verificationError('The reader browser session changed. Open verification again.', 'verification_unavailable', null);
      const held = currentVerification();
      if (held) return focusVerification(held);
      const username = lastAttemptedUsername || 'reddit';
      try {
        await getUserAbout(username);
        if (generation !== sessionGeneration) throw verificationError('The reader browser session changed. Open verification again.', 'verification_unavailable', null);
        return { opened: true, active: false, verified: true, username };
      } catch (err) {
        const opened = currentVerification();
        if (opened && generation === sessionGeneration) return focusVerification(opened);
        throw err;
      }
    });
    const shared = operation.finally(() => { if (openingVerification === shared) openingVerification = null; });
    openingVerification = shared;
    return shared;
  }

  function completeVerification() {
    if (!supportsVerification) return Promise.reject(verificationError('Manual verification is unavailable for this reader.', 'verification_unavailable', null));
    if (completingVerification) return completingVerification;
    const generation = sessionGeneration;
    const operation = queue.then(async () => {
      const held = currentVerification();
      if (!held || generation !== sessionGeneration || held.generation !== generation) {
        throw verificationError('No verification window is open. Open verification and complete the check in the reader browser first.', 'verification_unavailable', null);
      }
      let finalUrl;
      let html;
      try {
        finalUrl = held.page.url();
        const expected = new URL(held.requestedUrl);
        const current = new URL(finalUrl);
        if (current.origin !== expected.origin || current.pathname !== expected.pathname) {
          throw verificationError('Return to the original public page in the verification window before confirming.', 'verification_unavailable', held);
        }
        // This is the only document read. The person, not the monitor, performs
        // all interactions and any navigation in the retained window.
        html = await held.page.content();
      } catch (err) {
        if (err instanceof ReaderError) throw err;
        throw verificationError('The verification page could not be read. Check that the reader browser is still open.', 'verification_unavailable', held);
      }
      if (typeof html !== 'string' || currentVerification() !== held || generation !== sessionGeneration) {
        throw verificationError('The verification window closed or changed. Open verification again.', 'verification_unavailable', null);
      }
      try {
        const expected = new URL(held.requestedUrl);
        const current = new URL(held.page.url());
        if (current.origin !== expected.origin || current.pathname !== expected.pathname) {
          throw verificationError('Return to the original public page in the verification window before confirming.', 'verification_unavailable', held);
        }
      } catch (err) {
        if (err instanceof ReaderError) throw err;
        throw verificationError('The verification window changed while it was being read. Confirm again on the original public page.', 'verification_unavailable', held);
      }
      const title = sanitizeReaderText(decodeEntities(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ''), 160);
      const response = { html, title, finalUrl };
      const profile = parseProfile(html, held.username);
      const validProfile = hasProfileCard(html) &&
        [profile.profile?.linkKarma, profile.profile?.commentKarma, profile.profile?.createdAt, profile.profile?.contributions]
          .some(value => value !== null && value !== undefined);
      const listingKind = new URL(held.requestedUrl).pathname.match(/^\/user\/[^/]+\/(submitted|comments)\/$/)?.[1];
      const listing = listingKind ? inspectListing(html, listingKind) : null;
      const recognizedData = profile.state === 'not_found' || (listing ? ['listing', 'hidden'].includes(listing.state) : validProfile);
      if (browserChallenge(response) || loginPage(response) || !recognizedData) {
        // Do not establish a new deadline for the same document. An unfinished
        // human check never turns into an automated retry of Reddit.
        throw verificationError('Verification is not complete. Finish the verification in the reader browser, then confirm again.', 'browser_challenge', held);
      }
      verificationPage = null;
      try { await held.page.close(); } catch {
        await disposeDriver(held.driver);
        throw verificationError('The verified page could not close safely. The reader browser was stopped; open verification again.', 'browser_error', held);
      }
      if (generation !== sessionGeneration) throw verificationError('The reader browser session changed before verification finished. Open verification again.', 'verification_unavailable', null);
      recordSuccess();
      // A person can resolve the browser challenge, but cannot shorten a wait
      // explicitly requested by Reddit. Keep that deadline without recording
      // another failed read or describing the completed CAPTCHA as unfinished.
      if (held.serverRetryAt && Date.parse(held.serverRetryAt) > now()) {
        retryAt = held.serverRetryAt;
        pauseReason = readerErrorDetails(error('rate_limited', 'Public access is verified. Reddit requested a wait before further automated checks; checks resume after the retry time.', {
          http_status: held.response.status, retry_at: retryAt, attempts: 0,
        }));
      }
      return { verified: true, username: held.username };
    });
    // The retained page shares the same browser as automated reads. Keep DOM
    // confirmation in that queue; its active-page guard blocks queued reads.
    queue = operation.catch(() => {});
    const shared = operation.finally(() => { if (completingVerification === shared) completingVerification = null; });
    completingVerification = shared;
    return shared;
  }

  async function verify() {
    // Compatibility: this warms the browser, never claims Reddit is readable.
    // Routine health polling uses getDiagnostics() and launches nothing.
    await ensureBrowser();
  }

  return {
    getUserAbout,
    getUserListing,
    getInfo,
    verify,
    getDiagnostics,
    openVerification,
    completeVerification,
    async close() {
      if (closePromise) return closePromise;
      const held = verificationPage;
      verificationPage = null;
      sessionGeneration++;
      const pending = driverPromise;
      driverPromise = null;
      browserState = 'closed';
      const closing = Promise.resolve().then(async () => {
        const drv = await pending?.catch(() => null);
        try {
          try { await held?.page.close(); } catch { /* closing the context also closes its pages */ }
          if (drv) await drv.close();
        }
        finally { browserState = 'closed'; }
      });
      closePromise = closing;
      try { await closing; }
      finally { if (closePromise === closing) closePromise = null; }
    },
  };
}
