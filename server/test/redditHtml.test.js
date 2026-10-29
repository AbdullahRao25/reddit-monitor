import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseAttributes,
  collectTags,
  isRedditSuspended,
  parseProfile,
  parsePosts,
  parseComments,
  createHtmlRedditClient,
  toMs,
  toUnixSeconds,
  RedditHtmlError,
} from '../src/redditHtml.js';
import { ReaderError, readerErrorDetails } from '../src/readerErrors.js';
import { createChecker } from '../src/checker.js';
import { createMemoryRepo, NOW, silentLog } from './helpers.js';

// ---------- attribute parsing ----------

test('parseAttributes reads values and decodes entities', () => {
  const attrs = parseAttributes('<x a="1" b="hi &amp; there" c="&quot;quoted&quot;"></x>');
  assert.equal(attrs.a, '1');
  assert.equal(attrs.b, 'hi & there');
  assert.equal(attrs.c, '"quoted"');
});

// ---------- profile ----------

const PROFILE_HTML = `
<html><head><title>spez (u/spez) - Reddit</title></head><body>
  <span data-testid="karma-number" class="x">
    941,063
  </span> 184554 post karma, 756509 comment karma
  <faceplate-tooltip><span slot="trigger"><time datetime="2005-06-06T00:00:00.000Z" data-testid="cake-day">21 y</time></span></faceplate-tooltip>
  <div class="verified">Email verified</div>
</body></html>`;

test('parseProfile reads karma split and cake day; email verification is unknown', () => {
  const { state, profile } = parseProfile(PROFILE_HTML, 'spez');
  assert.equal(state, 'active');
  assert.equal(profile.linkKarma, 184554);
  assert.equal(profile.commentKarma, 756509);
  assert.equal(new Date(profile.createdAt).toISOString(), '2005-06-06T00:00:00.000Z');
  // The HTML page shows a generic verifications badge, not an email-specific one.
  assert.equal(profile.hasVerifiedEmail, null);
});

test('parseProfile reads the Contributions count (which includes content hidden from the public)', () => {
  // Profile card markup from a live page, Oct 2026.
  const html = `<html><head><title>example_user (u/example_user) - Reddit</title></head><body>
    <activate-feature name="ProfileContributionsModal_gUGjh9" route-params="{&quot;username&quot;:&quot;example_user&quot;}" activation="action" render-mode="contents" reactivatable="" is-bot="false"> <p class="m-0 text-neutral-content-strong text-14 font-semibold whitespace-nowrap"> <span class="m-0 text-neutral-content-strong text-14 font-semibold whitespace-nowrap" data-testid="contribution-count">1</span> </p> <p class="m-0 text-neutral-content-weak text-12 whitespace-nowrap truncate">Contributions</p> <!----></activate-feature>
  </body></html>`;
  assert.equal(parseProfile(html, 'example_user').profile.contributions, 1);
  assert.equal(parseProfile(PROFILE_HTML, 'spez').profile.contributions, undefined);
  assert.equal(parseProfile(html.replace('>1</span>', '>1,204</span>'), 'x').profile.contributions, 1204);
  assert.equal(parseProfile(html.replace('>1</span>', '>12.3k</span>'), 'x').profile.contributions, 12300);
});

test('parseProfile requires explicit missing-user evidence rather than a 404 title', () => {
  const html = '<html><head><title>404 - Reddit</title></head><body>Sorry, nobody on Reddit goes by that name.</body></html>';
  assert.equal(parseProfile(html, 'nobody').state, 'not_found');
  assert.notEqual(parseProfile('<title>404 - Reddit</title><body>unavailable</body>', 'nobody').state, 'not_found');
});

// ---------- posts ----------

const POSTS_HTML = `
<html><body>
  <shreddit-post id="t3_1vgbkge" post-title="Modernizing infrastructure" score="357"
    comment-count="480" created-timestamp="2026-10-18T16:03:56.264000+0000"
    subreddit-prefixed-name="u_spez" author="spez" domain="self.spez"
    permalink="/user/spez/comments/1vgbkge/modernizing/" content-href="https://www.reddit.com/r/u_spez/comments/1vgbkge/x/">
  </shreddit-post>
  <shreddit-post id="t3_abc123" post-title="Second post" score="10"
    comment-count="2" created-timestamp="2026-10-19T08:00:00.000000+0000"
    subreddit-prefixed-name="r_programmerhumor" author="spez" domain="example.com"
    permalink="/user/spez/comments/abc123/second/">
  </shreddit-post>
</body></html>`;

test('parsePosts extracts id, title, score, subreddit and time', () => {
  const posts = parsePosts(POSTS_HTML);
  assert.equal(posts.length, 2);
  const [first, second] = posts;
  assert.equal(first.name, 't3_1vgbkge');
  assert.equal(first.title, 'Modernizing infrastructure');
  assert.equal(first.score, 357);
  assert.equal(first.subreddit, 'spez');
  assert.equal(first.kind, 'post');
  // API-shaped: unix seconds (sub-second precision is dropped, matching the API).
  assert.equal(first.created_utc, Math.floor(Date.parse('2026-10-18T16:03:56.264000+0000') / 1000));
  assert.equal(first.is_self, true);
  assert.equal(second.subreddit, 'programmerhumor');
  assert.equal(second.is_self, false);
});

test('parsePosts deduplicates by id', () => {
  const html = POSTS_HTML.replace('</shreddit-post>', '</shreddit-post><shreddit-post id="t3_1vgbkge" post-title="dup">');
  assert.equal(parsePosts(html).length, 2);
});

// ---------- comments ----------

const COMMENTS_HTML = `
<html><body>
  <article aria-label="Modernizing Reddit's infrastructure with you">
    <shreddit-profile-comment comment-id="t1_p1wosm9" author-name="spez"
      comment-created-timestamp="2026-10-18T18:31:50.140000+0000"
      href="/user/spez/comments/1vgbkge/comment/p1wosm9/?context=3">
      <div>u/spez · Modernizing Reddit's infrastructure with you</div>
      <div id="-post-rtjson-content" class="md" dir="auto"><p>That was the thinking.</p></div>
      <div>3 mo. ago</div>
    </shreddit-profile-comment>
  </article>
</body></html>`;

test('parseComments extracts id, author, time, post title and body excerpt', () => {
  const comments = parseComments(COMMENTS_HTML);
  assert.equal(comments.length, 1);
  const c = comments[0];
  assert.equal(c.name, 't1_p1wosm9');
  assert.equal(c.author, 'spez');
  assert.equal(c.kind, 'comment');
  assert.equal(c.link_title, "Modernizing Reddit's infrastructure with you");
  assert.equal(c.body, 'That was the thinking.');
  // created_utc is unix seconds (API-shaped), so sub-second precision is dropped.
  assert.equal(new Date(c.created_utc * 1000).toISOString(), '2026-10-18T18:31:50.000Z');
});

// Empty-feed states from live pages, Oct 2026: one owner hides their activity,
// the other simply has none.
const emptyFeed = (text) => `<html><body><shreddit-feed class="nd:visible"> <div class="mt-[100px] flex justify-center items-center flex-col" id="empty-feed-content" data-cuj-omit=""> <div class="max-w-[480px] flex flex-col items-center text-center"> <div class="text-title-2 text-neutral-content-strong" role="heading" aria-level="2"> Welcome! </div> <div class="text-body-1 text-neutral-content-weak">${text}</div> </div> </div> </shreddit-feed></body></html>`;
const HIDDEN_COMMENTS_HTML = emptyFeed('u/x likes to keep their comments hidden, but check out their stats to learn more about them.');
const NO_COMMENTS_HTML = emptyFeed("u/x doesn't have any comments yet, but check out their stats to learn more about them.");

// ---------- client wiring (with a fake browser) ----------

function makeFakeBrowser({ profile = 200, submitted = 200, comments = 200, html = {} } = {}) {
  const pages = {
    '/user/x/': { status: profile, html: html.profile ?? PROFILE_HTML },
    '/user/x/submitted/': { status: submitted, html: html.submitted ?? POSTS_HTML },
    '/user/x/comments/': { status: comments, html: html.comments ?? COMMENTS_HTML },
  };
  const fake = { calls: [] };
  fake.newPage = async () => {
    let current = null;
    return {
      async goto(url) {
        const u = new URL(url);
        fake.calls.push(u.pathname);
        current = pages[u.pathname] ?? { status: 404, html: '<html><head><title>404</title></head></html>' };
        return { status: () => current.status };
      },
      async waitForTimeout() {},
      async content() {
        return current.html;
      },
      async close() {},
    };
  };
  fake.close = async () => {};
  return fake;
}

test('client maps the three page types to the checker contract', async () => {
  const fake = makeFakeBrowser();
  const client = createHtmlRedditClient({ createBrowser: async () => fake, minIntervalMs: 0, settleMs: 0 });

  const about = await client.getUserAbout('x');
  assert.equal(about.state, 'active');
  assert.equal(about.profile.linkKarma, 184554);

  const posts = await client.getUserListing('x', 'submitted');
  assert.equal(posts.length, 2);
  assert.equal(posts[0].name, 't3_1vgbkge');

  const comments = await client.getUserListing('x', 'comments');
  assert.equal(comments.length, 1);
  assert.equal(comments[0].name, 't1_p1wosm9');

  const info = await client.getInfo(['t3_1vgbkge']);
  assert.deepEqual(info, []);

  await client.close();
});

test('a profile page without the profile card fails the check instead of reading as an empty profile', async () => {
  const blocked = '<html><head><title>Reddit - Prevented</title></head><body><main>Please wait</main></body></html>';
  const client = createHtmlRedditClient({
    createBrowser: async () => makeFakeBrowser({ html: { profile: blocked } }),
    minIntervalMs: 0,
    settleMs: 0,
  });
  await assert.rejects(client.getUserAbout('x'), err => err.code === 'unexpected_page' && err.diagnostics.page_title === 'Reddit - Prevented');

  // Through the checker: an error row, and the account keeps its last result.
  const repo = createMemoryRepo({ now: () => NOW });
  const account = await repo.createAccount({ username: 'x' });
  await repo.updateAccount(account.id, { status: 'active', risk_score: 26, risk_level: 'elevated', link_karma: 1 });
  const checker = createChecker({ repo, reddit: client, now: () => NOW, log: silentLog });
  const result = await checker.checkAccount(await repo.getAccount(account.id));
  assert.equal(result.check.status, 'error');
  assert.deepEqual([result.account.risk_score, result.account.link_karma], [26, 1]);
  await client.close();
});

test('a listing the owner hid is unavailable (null), an empty one is empty ([])', async () => {
  const hidden = createHtmlRedditClient({
    createBrowser: async () => makeFakeBrowser({ html: { comments: HIDDEN_COMMENTS_HTML } }),
    minIntervalMs: 0,
    settleMs: 0,
  });
  assert.equal(await hidden.getUserListing('x', 'comments'), null);
  const empty = createHtmlRedditClient({
    createBrowser: async () => makeFakeBrowser({ html: { comments: NO_COMMENTS_HTML } }),
    minIntervalMs: 0,
    settleMs: 0,
  });
  assert.deepEqual(await empty.getUserListing('x', 'comments'), []);
  await hidden.close();
  await empty.close();
});

// A fake browser whose pages fail once it is closed, like Playwright's do.
function closableBrowser({ newPageFails = false } = {}) {
  const fake = makeFakeBrowser();
  const browser = { closed: false };
  browser.newPage = async () => {
    if (newPageFails || browser.closed) throw new Error('browser.newPage: Target page, context or browser has been closed');
    const page = await fake.newPage();
    return {
      ...page,
      async waitForTimeout() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (browser.closed) throw new Error('page.waitForTimeout: Target page, context or browser has been closed');
      },
    };
  };
  browser.close = async () => {
    browser.closed = true;
  };
  return browser;
}

test('a status check (verify) during a running check does not close the browser under it', async () => {
  const browsers = [];
  const createBrowser = async () => browsers[browsers.push(closableBrowser()) - 1];
  const client = createHtmlRedditClient({ createBrowser, minIntervalMs: 0, settleMs: 0 });

  const listing = client.getUserListing('x', 'comments');
  // GET /api/status calls verify() on every dashboard poll, mid-check included.
  await client.verify();
  assert.equal((await listing).length, 1);
  assert.equal(browsers.length, 1, 'one shared browser, not one per caller');
  assert.equal(browsers[0].closed, false);

  await client.close();
  assert.equal(browsers[0].closed, true);
});

test('a browser that died is replaced on the next request', async () => {
  const browsers = [closableBrowser({ newPageFails: true }), closableBrowser()];
  let launches = 0;
  const client = createHtmlRedditClient({ createBrowser: async () => browsers[launches++], minIntervalMs: 0, settleMs: 0 });

  await assert.rejects(client.getUserAbout('x'), /closed/);
  assert.equal((await client.getUserAbout('x')).state, 'active');
  assert.equal(launches, 2);
  await client.close();
});

test('client reports not_found only for a recognized Reddit missing-user response', async () => {
  const fake = makeFakeBrowser({ profile: 404, html: { profile: '<title>Reddit</title><h1>Sorry, nobody on Reddit goes by that name.</h1>' } });
  const client = createHtmlRedditClient({ createBrowser: async () => fake, minIntervalMs: 0, settleMs: 0 });
  const about = await client.getUserAbout('x');
  assert.equal(about.state, 'not_found');
  await client.close();
});

// ---------- end-to-end: real checker + HTML client (real markup) ----------

test('checker runs end-to-end with the HTML client (real markup -> health check)', async () => {
  const repo = createMemoryRepo({ now: () => NOW });
  const client = createHtmlRedditClient({ createBrowser: async () => makeFakeBrowser(), minIntervalMs: 0, settleMs: 0 });
  const checker = createChecker({ repo, reddit: client, now: () => NOW, log: silentLog });

  const account = await repo.createAccount({ username: 'x' });
  const result = await checker.checkAccount(account);

  assert.equal(result.account.status, 'active');
  assert.equal(result.account.risk_level, 'low');
  // 2 posts + 1 comment, all within the 30-day window.
  assert.equal(result.check.items_sampled, 3);
  // Karma from the profile page made it onto the check.
  assert.equal(result.check.link_karma, 184554);
  assert.equal(result.check.comment_karma, 756509);

  // The HTML items were normalized to proper content rows.
  const rows = [...repo.content.values()];
  assert.equal(rows.length, 3);
  const post = rows.find((r) => r.id === 't3_1vgbkge');
  assert.equal(post.kind, 'post');
  assert.equal(post.title, 'Modernizing infrastructure');
  assert.equal(post.subreddit, 'spez');
  assert.equal(post.removal_status, 'visible');
  assert.ok(post.created_at, 'post created_at is set');
  const comment = rows.find((r) => r.id === 't1_p1wosm9');
  assert.equal(comment.kind, 'comment');
  assert.equal(comment.excerpt, 'That was the thinking.');
  assert.equal(comment.title, "Modernizing Reddit's infrastructure with you");

  await client.close();
});

// ---------- Reddit's current markup (regression: comment times came back null) ----------

// Trimmed from a live /user/<name>/comments/ page (October 2026). There is no
// timestamp attribute on <shreddit-profile-comment>: the time is only in the
// card's "commented" meta row, as <faceplate-timeago ts> around <time datetime>.
const TIMEAGO =
  '<faceplate-timeago ts="2026-10-12T04:28:30.964000+0000" short="">' +
  '<time datetime="2026-10-12T04:28:30.964Z" title="Monday, October 12, 2026 at 4:28:30 AM UTC">12 days ago</time>' +
  '</faceplate-timeago>';

const currentCommentCard = ({ id = 'pfdvo3f', path = '/r/corporate/comments/1x2j6rx', time = TIMEAGO } = {}) => `
  <article class="w-full m-0" aria-label="Is it normal to hear nothing back after an interview?">
    <shreddit-profile-comment data-ks-item="" href="${path}/comment/${id}/?context=3"
      class="w-full nd:visible rounded-4 my-2xs" telemetry-noun="comment" telemetry-source="comment"
      comment-id="t1_${id}" data-feed-element-id="t1_${id}" reload-url="/svc/shreddit/comment/t1_${id}?isProfile=true"
      user-id="" mod-tools-host="false" item-state="UNMODERATED">
      <div class="flex gap-xs items-center">
        <faceplate-hovercard><a href="/user/example_user/" aria-haspopup="dialog"><span dir="auto">example_user</span></a>
          <div slot="content" hidden=""><faceplate-partial src="/svc/shreddit/user-hover-card/example_user" loading="programmatic"></faceplate-partial></div>
        </faceplate-hovercard>
        <shreddit-comment-author-modifier-icon thing-id="t1_${id}"></shreddit-comment-author-modifier-icon> commented
        ${time}
        <shreddit-comment-badges thing-id="t1_${id}" icon-size="xs"></shreddit-comment-badges>
      </div>
      <div id="-post-rtjson-content" class="md text-14" dir="auto"><p>Totally normal, follow up after a week.</p></div>
    </shreddit-profile-comment>
  </article>`;
const page = (...cards) => `<html><body>${cards.join('\n')}</body></html>`;
const iso = (seconds) => new Date(seconds * 1000).toISOString();

test('toMs/toUnixSeconds read both Reddit timestamp formats and reject junk', () => {
  const expected = Date.parse('2026-10-12T04:28:30.964Z');
  assert.equal(toMs('2026-10-12T04:28:30.964000+0000'), expected); // faceplate-timeago ts / created-timestamp
  assert.equal(toMs('2026-10-12T04:28:30.964Z'), expected); // <time datetime>
  assert.equal(toMs('2026-10-12T09:28:30.964000+0500'), expected); // non-UTC offset
  assert.equal(toMs('2026-10-12T04:28:30+0000'), Date.parse('2026-10-12T04:28:30Z')); // no fraction
  assert.equal(toUnixSeconds('2026-10-12T04:28:30.964000+0000'), 1791779310);
  for (const junk of [null, undefined, '', '   ', 'yesterday', '12 days ago', '1970-01-01T00:00:00Z', '0']) {
    assert.equal(toMs(junk), null, `toMs(${JSON.stringify(junk)})`);
    assert.equal(toUnixSeconds(junk), null);
  }
});

test('parseComments reads the time from the current card markup (no timestamp attribute)', () => {
  const [c] = parseComments(page(currentCommentCard()));
  assert.equal(c.name, 't1_pfdvo3f');
  assert.equal(iso(c.created_utc), '2026-10-12T04:28:30.000Z');
  assert.equal(c.subreddit, 'corporate');
  assert.equal(c.permalink, '/r/corporate/comments/1x2j6rx/comment/pfdvo3f/?context=3');
  assert.equal(c.link_title, 'Is it normal to hear nothing back after an interview?');
  assert.equal(c.body, 'Totally normal, follow up after a week.');
});

test('parseComments falls back to <time datetime> when the timeago has no usable ts', () => {
  for (const ts of ['', ' ts=""', ' ts="not a date"']) {
    const time = `<faceplate-timeago${ts} short=""><time datetime="2026-10-12T04:28:30.964Z">12 days ago</time></faceplate-timeago>`;
    const [c] = parseComments(page(currentCommentCard({ time })));
    assert.equal(iso(c.created_utc), '2026-10-12T04:28:30.000Z', `ts attribute: ${JSON.stringify(ts)}`);
  }
});

test('parseComments reports a missing or invalid time as null, never 0 / 1970', () => {
  const cases = {
    'no time element': '<span>12 days ago</span>',
    'unparseable values': '<faceplate-timeago ts="soon"><time datetime="whenever">?</time></faceplate-timeago>',
  };
  for (const [label, time] of Object.entries(cases)) {
    const [c] = parseComments(page(currentCommentCard({ time })));
    assert.equal(c.created_utc, null, label);
  }
});

test('parseComments keeps each card\'s time to itself', () => {
  const comments = parseComments(
    page(
      currentCommentCard({ id: 'aaa', time: '<span>no time here</span>' }),
      currentCommentCard({ id: 'bbb' }),
    ),
  );
  assert.deepEqual(
    comments.map((c) => ({ id: c.name, date: c.created_utc && iso(c.created_utc) })),
    [
      { id: 't1_aaa', date: null },
      { id: 't1_bbb', date: '2026-10-12T04:28:30.000Z' },
    ],
  );
});

test('parseComments: a comment under a profile post takes the profile name as its subreddit', () => {
  const [c] = parseComments(page(currentCommentCard({ path: '/user/spez/comments/1vgbkge' })));
  assert.equal(c.subreddit, 'spez');
});

test('parsePosts reads the current "r/name" prefix and reports unusable times as null', () => {
  const html = `<html><body>
    <shreddit-post id="t3_live1" post-title="Q3 results" created-timestamp="2026-10-12T04:28:30.964000+0000"
      subreddit-prefixed-name="r/redditstock" author="spez" domain="self.redditstock" permalink="/r/redditstock/comments/live1/q3/"></shreddit-post>
    <shreddit-post id="t3_nots" post-title="No time" subreddit-prefixed-name="u_spez" author="spez" domain="self.spez"></shreddit-post>
    <shreddit-post id="t3_bad" post-title="Bad time" created-timestamp="tomorrow" subreddit-prefixed-name="r/pics" domain="i.redd.it"></shreddit-post>
  </body></html>`;
  const [live, noTime, badTime] = parsePosts(html);
  assert.equal(live.subreddit, 'redditstock');
  assert.equal(iso(live.created_utc), '2026-10-12T04:28:30.000Z');
  assert.equal(noTime.subreddit, 'spez');
  assert.equal(noTime.created_utc, null);
  assert.equal(badTime.created_utc, null);
});

test('parseProfile takes the cake day, not the first <time> in the activity feed', () => {
  const html = `<html><head><title>example_user (u/example_user) - Reddit</title></head><body>
    <shreddit-profile-comment comment-id="t1_x" href="/r/corporate/comments/1/comment/x/">
      commented ${TIMEAGO}
    </shreddit-profile-comment>
    <faceplate-tooltip><span slot="trigger"><time datetime="2026-10-09T00:00:00.000Z" data-testid="cake-day"> 2 w </time></span> Cake day: Oct 9, 2026</faceplate-tooltip>
  </body></html>`;
  assert.equal(new Date(parseProfile(html, 'example_user').profile.createdAt).toISOString(), '2026-10-09T00:00:00.000Z');

  // No cake day on the page: account age is unknown rather than taken from a post.
  const noCake = html.replace(/<faceplate-tooltip>[\s\S]*<\/faceplate-tooltip>/, '');
  assert.equal(parseProfile(noCake, 'example_user').profile.createdAt, undefined);
});

test('checker counts a current-markup comment as recent activity and stores its real date', async () => {
  const repo = createMemoryRepo({ now: () => NOW });
  const html = { submitted: emptyFeed("u/x doesn't have any posts yet, but check out their stats to learn more about them."), comments: page(currentCommentCard()) };
  const client = createHtmlRedditClient({ createBrowser: async () => makeFakeBrowser({ html }), minIntervalMs: 0, settleMs: 0 });
  const checker = createChecker({ repo, reddit: client, now: () => NOW, log: silentLog });

  const result = await checker.checkAccount(await repo.createAccount({ username: 'x' }));
  // NOW is 2026-10-19, so the 2026-10-12 comment is inside the 30-day window.
  assert.equal(result.check.items_sampled, 1);
  assert.equal(result.account.items_sampled, 1);
  const row = repo.content.get('t1_pfdvo3f');
  assert.equal(row.created_at, '2026-10-12T04:28:30.000Z');
  assert.equal(row.subreddit, 'corporate');
  assert.equal(row.permalink, 'https://www.reddit.com/r/corporate/comments/1x2j6rx/comment/pfdvo3f/?context=3');
  assert.ok(!result.check.factors.some((f) => f.key === 'undated_items'));
  await client.close();
});

test('checker leaves an undated comment out of the counts and says so, instead of storing 1970', async () => {
  const repo = createMemoryRepo({ now: () => NOW });
  const warnings = [];
  const html = {
    submitted: emptyFeed("u/x doesn't have any posts yet, but check out their stats to learn more about them."),
    comments: page(currentCommentCard({ id: 'dated' }), currentCommentCard({ id: 'undated', time: '<span>just now</span>' })),
  };
  const client = createHtmlRedditClient({ createBrowser: async () => makeFakeBrowser({ html }), minIntervalMs: 0, settleMs: 0 });
  const log = { ...silentLog, warn: (message) => warnings.push(message) };
  const checker = createChecker({ repo, reddit: client, now: () => NOW, log });

  const result = await checker.checkAccount(await repo.createAccount({ username: 'x' }));
  assert.equal(result.check.items_sampled, 1);
  assert.deepEqual([...repo.content.keys()], ['t1_dated']);
  assert.ok(![...repo.content.values()].some((row) => row.created_at.startsWith('1970')));
  const factor = result.check.factors.find((f) => f.key === 'undated_items');
  assert.equal(factor.points, 0);
  assert.match(factor.detail, /^1 post\/comment .* left out of the 30-day activity/);
  assert.match(warnings.join('\n'), /u\/x: 1 listed item\(s\) had no readable timestamp/);
  await client.close();
});

// Responses are consumed on navigation, not on page creation. This lets the
// tests prove rejected cooldown/backlog calls do not contact the fixture at all.
function scriptedBrowser(steps = []) {
  const browser = { navigations: 0, pagesClosed: 0, closes: 0, settles: 0, titleReads: 0 };
  browser.newPage = async () => {
    let step;
    return {
      async goto() {
        step = steps[browser.navigations++] ?? { html: PROFILE_HTML };
        if (step.gotoError) throw step.gotoError;
        return step.noResponse ? null : { status: () => step.status ?? 200, headers: () => step.headers ?? {} };
      },
      async waitForTimeout() {
        browser.settles++;
        if (step.settleError) throw step.settleError;
      },
      async content() {
        if (step.contentError) throw step.contentError;
        return Object.hasOwn(step, 'html') ? step.html : PROFILE_HTML;
      },
      async title() {
        browser.titleReads++;
        if (step.titleError) throw step.titleError;
        return step.title ?? '';
      },
      url: () => step?.url ?? 'https://www.reddit.com/user/x/',
      async close() { browser.pagesClosed++; },
    };
  };
  browser.close = async () => { browser.closes++; };
  return browser;
}

function fixtureClient(browser, options = {}) {
  return createHtmlRedditClient({ createBrowser: async () => browser, minIntervalMs: 0, settleMs: 0, ...options });
}

test('cached diagnostics never launch or navigate, and browser startup alone is unverified', async () => {
  const browser = scriptedBrowser();
  let launches = 0;
  const client = fixtureClient(browser, { createBrowser: async () => { launches++; return browser; }, now: () => NOW });
  assert.deepEqual(client.getDiagnostics(), {
    mode: 'html', browser: { state: 'not_started' }, state: 'unverified', readable: null,
    last_success_at: null, last_failure_at: null, last_error: null, paused: false, retry_at: null,
  });
  assert.equal(launches, 0);
  await client.verify();
  assert.equal(client.getDiagnostics().browser.state, 'ready');
  assert.equal(client.getDiagnostics().readable, null);
  assert.equal(client.getDiagnostics().state, 'unverified');
  assert.equal(browser.navigations, 0);
  await client.getUserAbout('x');
  assert.equal(client.getDiagnostics().state, 'ready');
  assert.equal(client.getDiagnostics().last_success_at, new Date(NOW).toISOString());
  const copy = client.getDiagnostics();
  copy.browser.state = 'error';
  assert.equal(client.getDiagnostics().browser.state, 'ready');
  await client.close();
  assert.equal(client.getDiagnostics().browser.state, 'closed');
});

test('valid Reddit empty posts and comments are distinct from unrecognized empty documents', async () => {
  for (const [which, noun] of [['submitted', 'posts'], ['comments', 'comments']]) {
    const browser = scriptedBrowser([
      { html: emptyFeed(`u/x doesn't have any ${noun} yet, but check out their stats to learn more about them.`) },
      { html: '<html><body><shreddit-feed></shreddit-feed></body></html>' },
      { html: emptyFeed(`u/x likes to keep their ${noun} hidden, but check out their stats to learn more about them.`) },
    ]);
    const client = fixtureClient(browser);
    assert.deepEqual(await client.getUserListing('x', which), []);
    await assert.rejects(client.getUserListing('x', which), err => err.code === 'unexpected_page');
    assert.equal(await client.getUserListing('x', which), null);
    assert.equal(browser.pagesClosed, 3);
    await client.close();
  }
});

test('status errors precede page content, including misleading 404 and challenge markers', async () => {
  const cases = [[429, 'rate_limited'], [403, 'access_denied'], [401, 'access_denied'], [500, 'server_error'], [503, 'server_error']];
  for (const [status, code] of cases) {
    for (const listing of [false, true]) {
      const browser = scriptedBrowser([{ status, html: '<title>404 - Reddit</title><h1>Verify you are human</h1><div class="profile-not-found"></div>' }]);
      const client = fixtureClient(browser, { now: () => NOW });
      await assert.rejects(listing ? client.getUserListing('x', 'submitted') : client.getUserAbout('x'), err => {
        assert.ok(err instanceof RedditHtmlError);
        assert.ok(err instanceof ReaderError);
        assert.equal(err.code, code);
        assert.equal(err.status, status);
        assert.equal(err.diagnostics.attempts, 1);
        assert.equal(err.diagnostics.temporary, true);
        assert.equal(err.diagnostics.occurred_at, new Date(NOW).toISOString());
        return true;
      });
      assert.equal(browser.pagesClosed, 1);
      assert.equal(client.getDiagnostics().state, 'paused');
      assert.equal(client.getDiagnostics().last_error.code, code);
      await client.close();
    }
  }
});

test('challenges and login responses are classified before apparent missing profiles', async () => {
  const cases = [
    ['browser_challenge', '<title>404 - Reddit</title><h1>Verify you are human</h1>', undefined],
    ['browser_challenge', '<title>Reddit</title><script>document.forms[0].submit()</script>', undefined],
    ['login_required', '<title>Log in to Reddit</title><div class="profile-not-found"></div>', undefined],
    ['login_required', '<title>Reddit</title><form action="/login"><input type="password"></form>', undefined],
    ['login_required', '<title>Reddit</title>', 'https://www.reddit.com/login/?return_to=private'],
  ];
  for (const [code, html, url] of cases) {
    const client = fixtureClient(scriptedBrowser([{ html, url }]));
    await assert.rejects(client.getUserAbout('x'), err => err.code === code);
    await client.close();
  }
});

test('ordinary Snoo SVG and styles do not override recognized empty, hidden or missing pages', async () => {
  const illustration = '<style>.snoo-cls-1 { fill: #ff4500; }</style><svg aria-hidden="true"><path class="snoo-cls-1"></path></svg>';
  const browser = scriptedBrowser([
    { html: emptyFeed("u/x doesn't have any posts yet") + illustration },
    { html: emptyFeed('u/x likes to keep their comments hidden') + illustration },
    { status: 404, html: '<title>Reddit</title><h1>Sorry, nobody on Reddit goes by that name.</h1>' + illustration },
    { html: '<title>Reddit</title><main>Unrecognized page</main>' + illustration },
  ]);
  const client = fixtureClient(browser);
  assert.deepEqual(await client.getUserListing('x', 'submitted'), []);
  assert.equal(await client.getUserListing('x', 'comments'), null);
  assert.deepEqual(await client.getUserAbout('x'), { state: 'not_found' });
  await assert.rejects(client.getUserAbout('x'), err => err.code === 'unexpected_page');
  assert.equal(client.getDiagnostics().paused, false);
  assert.equal(browser.navigations, 4);
  assert.equal(browser.pagesClosed, 4);
  await client.close();
});

test('explicit challenge evidence remains authoritative alongside ordinary Snoo CSS', async () => {
  for (const evidence of [
    '<h1>Verify you are human</h1>',
    '<script>document.forms[0].submit()</script>',
    '<div class="g-recaptcha"></div>',
    '<div class="h-captcha"></div>',
    '<div id="cf-chl-widget"></div>',
  ]) {
    const browser = scriptedBrowser([{ html: '<title>Reddit</title><style>.snoo-cls-1 { fill: red; }</style>' + evidence }]);
    const client = fixtureClient(browser);
    await assert.rejects(client.getUserAbout('x'), err => err.code === 'browser_challenge' && err.status === 200);
    assert.equal(client.getDiagnostics().paused, true);
    assert.equal(browser.navigations, 1);
    assert.equal(browser.pagesClosed, 1);
    await client.close();
  }
});

test('arbitrary 404 pages cannot become account restriction evidence or empty listings', async () => {
  for (const html of ['<title>404 - Reddit</title><body>Service unavailable</body>', PROFILE_HTML]) {
    const client = fixtureClient(scriptedBrowser([{ status: 404, html }, { status: 404, html }]));
    await assert.rejects(client.getUserAbout('x'), err => err.code === 'unexpected_page');
    await assert.rejects(client.getUserListing('x', 'comments'), err => err.code === 'unexpected_page');
    await client.close();
  }
});

test('profile text mentioning a missing user does not override its readable card', async () => {
  const client = fixtureClient(scriptedBrowser([{ html: PROFILE_HTML.replace('</body>', "<p>This user doesn't exist is a message users sometimes see.</p></body>") }]));
  assert.equal((await client.getUserAbout('x')).state, 'active');
  await client.close();
});

test('a definitive HTTP rate limit survives an unreadable error document', async () => {
  const browser = scriptedBrowser([{ status: 429, contentError: new Error('execution context destroyed'), title: '<b>Rate limited</b> https://example.test/private?token=secret', headers: { 'retry-after': '75' } }]);
  const client = fixtureClient(browser, { now: () => NOW });
  await assert.rejects(client.getUserAbout('x'), err => err.code === 'rate_limited' && err.status === 429 &&
    err.diagnostics.page_title === 'Rate limited [address]' && err.diagnostics.retry_at === new Date(NOW + 75_000).toISOString());
  assert.equal(browser.titleReads, 1);
  assert.equal(browser.pagesClosed, 1);
  await client.close();
});

test('definitive HTTP failures retain status and cooldown when both document and title are unreadable', async () => {
  for (const [status, code] of [[401, 'access_denied'], [403, 'access_denied'], [429, 'rate_limited'], [500, 'server_error'], [503, 'server_error']]) {
    for (const document of [{ contentError: new Error('execution context destroyed Cookie: secret') }, { html: null }]) {
      const browser = scriptedBrowser([{
        status, ...document, titleError: new Error('Title unavailable https://example.test/?token=secret'),
        settleError: new Error('Definitive HTTP failures must skip settling'), headers: { 'retry-after': '75' },
      }]);
      const client = fixtureClient(browser, { now: () => NOW, settleMs: 5_000, cooldownMs: 1_000, accessCooldownMs: 2_000 });
      await assert.rejects(client.getUserAbout('x'), err => {
        assert.equal(err.code, code);
        assert.equal(err.status, status);
        assert.equal(err.diagnostics.page_title, null);
        assert.equal(err.diagnostics.retry_at, new Date(NOW + 75_000).toISOString());
        assert.ok(!JSON.stringify(readerErrorDetails(err)).includes('secret'));
        return true;
      });
      await assert.rejects(client.getUserAbout('x'), err => err.code === code && err.diagnostics.attempts === 0 && err.status === status);
      assert.equal(browser.navigations, 1);
      assert.equal(browser.settles, 0);
      assert.equal(browser.titleReads, 1);
      assert.equal(browser.pagesClosed, 1);
      await client.close();
    }
  }
});

test('observed HTTP status and a safe title survive later content or settling failures', async () => {
  for (const status of [200, 404]) {
    for (const failure of ['contentError', 'settleError']) {
      const browser = scriptedBrowser([{
        status, [failure]: new Error('execution context destroyed https://example.test/private?token=secret'),
        title: '<b>Unavailable</b> https://example.test/private?token=secret',
      }]);
      const client = fixtureClient(browser, { settleMs: 1 });
      await assert.rejects(client.getUserAbout('x'), err => {
        assert.equal(err.code, 'navigation_error');
        assert.equal(err.status, status);
        assert.equal(err.diagnostics.page_title, 'Unavailable [address]');
        assert.ok(!JSON.stringify(readerErrorDetails(err)).includes('secret'));
        return true;
      });
      assert.equal(client.getDiagnostics().last_error.http_status, status);
      assert.equal(browser.navigations, 1);
      assert.equal(browser.titleReads, 1);
      assert.equal(browser.pagesClosed, 1);
      assert.equal(browser.closes, 0);
      await client.close();
    }
  }
});

test('malformed profile metrics and listing cards produce parsing errors', async () => {
  const client = fixtureClient(scriptedBrowser([
    { html: '<title>Reddit</title><span data-testid="karma-number">unknown</span><time data-testid="cake-day" datetime="invalid"></time>' },
    { html: '<shreddit-post post-title="missing ID"></shreddit-post>' },
    { html: '<shreddit-profile-comment comment-id="wrong-prefix"></shreddit-profile-comment>' },
    { html: '<span data-testid="contribution-count">0</span>' },
  ]));
  await assert.rejects(client.getUserAbout('x'), err => err.code === 'parsing_error');
  await assert.rejects(client.getUserListing('x', 'submitted'), err => err.code === 'parsing_error');
  await assert.rejects(client.getUserListing('x', 'comments'), err => err.code === 'parsing_error');
  assert.equal((await client.getUserAbout('x')).profile.contributions, 0, 'a legitimate contribution-only profile stays supported');
  await client.close();
});

test('Retry-After seconds and HTTP dates pause immediately, reject queued requests, and recover after expiry', async () => {
  for (const retryAfter of ['120', new Date(NOW + 120_000).toUTCString()]) {
    let time = NOW;
    const browser = scriptedBrowser([{ status: 429, html: '<title>Rate limited</title>', headers: { 'retry-after': retryAfter } }, { html: PROFILE_HTML }]);
    const client = fixtureClient(browser, { now: () => time, sleep: async ms => { time += ms; } });
    const results = await Promise.allSettled([client.getUserAbout('x'), client.getUserListing('x', 'comments')]);
    assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected']);
    assert.equal(results[1].reason.diagnostics.attempts, 0, 'queued work is rejected without another attempt');
    assert.equal(browser.navigations, 1);
    const diagnostics = client.getDiagnostics();
    assert.equal(diagnostics.retry_at, new Date(NOW + 120_000).toISOString());
    await assert.rejects(client.getUserAbout('x'), err => err.code === 'rate_limited' && err.diagnostics.attempts === 0);
    assert.equal(browser.navigations, 1);
    time += 120_000;
    assert.equal(client.getDiagnostics().paused, false);
    assert.equal(client.getDiagnostics().readable, false, 'expiry alone does not prove the reader works');
    assert.equal((await client.getUserAbout('x')).state, 'active');
    assert.equal(client.getDiagnostics().readable, true);
    assert.equal(browser.navigations, 2);
    await client.close();
  }
});

test('a new format failure does not inherit the expired challenge retry deadline', async (t) => {
  let time = NOW;
  const browser = scriptedBrowser([
    { html: '<title>Reddit - Prove your humanity</title><h1>Verify you are human</h1>' },
    { html: '<html><body><main>Unrecognized page</main></body></html>' },
  ]);
  const client = fixtureClient(browser, { now: () => time });
  t.after(() => client.close());
  await assert.rejects(client.getUserAbout('x'), err => err.code === 'browser_challenge');
  const deadline = client.getDiagnostics().retry_at;
  assert.ok(deadline);
  time = Date.parse(deadline) + 1;
  const expired = client.getDiagnostics();
  assert.equal(expired.paused, false);
  assert.equal(expired.retry_at, null);
  assert.equal(expired.last_error.retry_at, deadline, 'the original failure retains its historical deadline');
  assert.equal(expired.readable, false, 'cooldown expiry does not prove recovery');

  await assert.rejects(client.getUserAbout('x'), err => {
    assert.equal(err.code, 'unexpected_page');
    assert.equal(err.status, 200);
    assert.equal(err.diagnostics.retry_at, null, 'a new failure needs its own retry evidence');
    return true;
  });
  assert.equal(client.getDiagnostics().last_error.retry_at, null);
  assert.equal(client.getDiagnostics().paused, false);
  assert.equal(browser.navigations, 2);
});

test('cooldown defaults are bounded and long valid server pauses are never shortened', async () => {
  for (const [retryAfter, expected] of [[undefined, 2_000], ['invalid', 2_000], ['-9', 2_000], ['999999999999999', 2_000], ['9'.repeat(400), 2_000], ['7200', 7_200_000]]) {
    const browser = scriptedBrowser([{ status: 403, headers: { 'retry-after': retryAfter } }]);
    const client = fixtureClient(browser, { now: () => NOW, accessCooldownMs: 5_000, maxCooldownMs: 2_000 });
    await assert.rejects(client.getUserAbout('x'));
    assert.equal(client.getDiagnostics().retry_at, new Date(NOW + expected).toISOString());
    await client.close();
  }
});

test('listing fullnames without supported content fields cannot overwrite stored history', async () => {
  const repo = createMemoryRepo({ now: () => NOW });
  const account = await repo.createAccount({ username: 'x' });
  const healthy = fixtureClient(makeFakeBrowser());
  const initial = createChecker({ repo, reddit: healthy, now: () => NOW, log: silentLog });
  const first = await initial.checkAccount(account);
  assert.equal(first.check.error, null);
  const before = [...repo.content.values()].map(row => ({ ...row }));
  const cases = [
    ['submitted', '<shreddit-post id="t3_1vgbkge"></shreddit-post>'],
    ['submitted', '<shreddit-post id="t3_1vgbkge" post-title="Changed layout" subreddit-prefixed-name="u_spez"></shreddit-post>'],
    ['comments', '<shreddit-profile-comment comment-id="t1_p1wosm9"></shreddit-profile-comment>'],
    ['comments', '<shreddit-profile-comment comment-id="t1_p1wosm9" href="/r/test/comments/abc123/comment/p1wosm9/"></shreddit-profile-comment>'],
  ];
  for (const [which, html] of cases) {
    const client = fixtureClient(makeFakeBrowser({ html: { [which]: html } }));
    const checker = createChecker({ repo, reddit: client, now: () => NOW, log: silentLog });
    const result = await checker.checkAccount(await repo.getAccount(account.id));
    assert.equal(result.check.status, 'error');
    assert.equal(client.getDiagnostics().last_error.code, 'parsing_error');
    assert.deepEqual([...repo.content.values()], before);
    await client.close();
  }
  await healthy.close();
});

test('supported listing validation accepts profile posts from usernames containing hyphens', async () => {
  const client = fixtureClient(scriptedBrowser([{ html: POSTS_HTML.replaceAll('u_spez', 'u_example-user').replaceAll('/user/spez/', '/user/example-user/') }]));
  assert.equal((await client.getUserListing('example-user', 'submitted')).length, 2);
  await client.close();
});

test('reader queue is bounded without dropping the running request', async () => {
  let release;
  const blocker = new Promise(resolve => { release = resolve; });
  const browser = scriptedBrowser();
  const client = fixtureClient(browser, { maxPending: 1, createBrowser: async () => { await blocker; return browser; } });
  const first = client.getUserAbout('x');
  await assert.rejects(client.getUserAbout('x'), err => err.code === 'reader_busy' && err.diagnostics.attempts === 0);
  release();
  assert.equal((await first).state, 'active');
  assert.equal(browser.navigations, 1);
  await client.close();
});

test('navigation timeout closes the page, preserves the browser, and never exports raw exception text', async () => {
  const browser = scriptedBrowser([{ gotoError: new Error('page.goto Timeout https://reddit.test/user/private/?token=secret Cookie: session=secret') }, { html: PROFILE_HTML }]);
  const client = fixtureClient(browser);
  await assert.rejects(client.getUserAbout('x'), err => err.code === 'navigation_error' && !JSON.stringify(readerErrorDetails(err)).includes('secret'));
  assert.equal(browser.pagesClosed, 1);
  assert.equal(browser.closes, 0);
  assert.equal((await client.getUserAbout('x')).state, 'active');
  assert.equal(browser.pagesClosed, 2);
  await client.close();
});

test('a browser crash during content reading is disposed and replaced on the next request', async () => {
  const broken = scriptedBrowser([{ contentError: new Error('Target page, context or browser has been closed'), title: 'Reddit' }]);
  const healthy = scriptedBrowser();
  let launches = 0;
  const client = fixtureClient(null, { createBrowser: async () => launches++ === 0 ? broken : healthy });
  await assert.rejects(client.getUserAbout('x'), err => err.code === 'browser_error' && err.status === 200 && err.diagnostics.page_title === 'Reddit');
  assert.equal(broken.pagesClosed, 1);
  assert.equal(broken.closes, 1);
  assert.equal(client.getDiagnostics().browser.state, 'error');
  assert.equal((await client.getUserAbout('x')).state, 'active');
  assert.equal(launches, 2);
  await client.close();
});

test('browser launch and newPage failures release resources and remain recoverable', async () => {
  const badPage = { newPage: async () => { throw new Error('allocation failed /private/browser-profile'); }, closes: 0, async close() { this.closes++; } };
  const badDriver = { closes: 0, async close() { this.closes++; } };
  const healthy = scriptedBrowser();
  let launches = 0;
  const client = fixtureClient(null, { createBrowser: async () => {
    const attempt = launches++;
    if (attempt === 0) throw new Error('Cannot launch C:\\private\\chrome Cookie: secret');
    return [badDriver, badPage, healthy][attempt - 1];
  } });
  for (let i = 0; i < 3; i++) await assert.rejects(client.getUserAbout('x'), err => err.code === 'browser_error' && !err.message.includes('private'));
  assert.equal(badDriver.closes, 1);
  assert.equal(badPage.closes, 1);
  assert.equal((await client.getUserAbout('x')).state, 'active');
  await client.close();
});

test('missing navigation responses and invalid browser pages fail safely', async () => {
  const browser = scriptedBrowser([{ noResponse: true }]);
  const client = fixtureClient(browser);
  await assert.rejects(client.getUserAbout('x'), err => err.code === 'navigation_error');
  assert.equal(browser.pagesClosed, 1);
  await client.close();
  let disposed = 0;
  const invalid = fixtureClient({ newPage: async () => null, close: async () => { disposed++; } });
  await assert.rejects(invalid.getUserAbout('x'), err => err.code === 'browser_error');
  assert.equal(disposed, 1);
  await invalid.close();
});

test('closing during browser startup finishes with closed diagnostics and no leaked session', async () => {
  let releaseLaunch;
  let signalLaunch;
  const started = new Promise(resolve => { signalLaunch = resolve; });
  const launch = new Promise(resolve => { releaseLaunch = resolve; });
  const browser = scriptedBrowser();
  const client = fixtureClient(null, { createBrowser: async () => { signalLaunch(); await launch; return browser; } });
  const warming = client.verify();
  await started;
  const closing = client.close();
  releaseLaunch();
  await Promise.all([warming, closing]);
  assert.equal(browser.closes, 1);
  assert.equal(client.getDiagnostics().browser.state, 'closed');
  assert.equal(client.getDiagnostics().state, 'unavailable');
});

test('a failed page close disposes its driver and the next read creates a fresh browser', async () => {
  const broken = scriptedBrowser();
  const createPage = broken.newPage;
  broken.newPage = async () => ({ ...await createPage(), close: async () => { throw new Error('page disposal failed'); } });
  const healthy = scriptedBrowser();
  let launches = 0;
  const client = fixtureClient(null, { createBrowser: async () => launches++ === 0 ? broken : healthy });
  assert.equal((await client.getUserAbout('x')).state, 'active', 'the successful read itself remains usable');
  assert.equal(broken.closes, 1);
  assert.equal(client.getDiagnostics().browser.state, 'error');
  assert.equal((await client.getUserAbout('x')).state, 'active');
  assert.equal(launches, 2);
  await client.close();
});

// ---------- challenge grace ----------

const CHALLENGE_HTML = '<html><head><title>Reddit - Prove your humanity</title></head><body><script>document.forms[0].submit()</script></body></html>';

// A single page whose document is supplied per read, so a challenge can be
// scripted to clear (or not) while the reader waits.
function gracePageClient(nextDocument, { onWait, ...options } = {}) {
  const state = { navigations: 0 };
  const page = {
    async goto() { state.navigations++; return { status: () => 200, headers: () => ({}) }; },
    async waitForTimeout() { onWait?.(); },
    async content() { return nextDocument(); },
    async title() { return ''; },
    url: () => 'https://www.reddit.com/user/x/',
    isClosed: () => false,
    async close() {},
  };
  state.reddit = createHtmlRedditClient({
    createBrowser: async () => ({ newPage: async () => page, close: async () => {} }),
    minIntervalMs: 0, settleMs: 0, ...options,
  });
  return state;
}

test('a self-submitting challenge that lands within the grace is read, not reported', async () => {
  // Reddit's interstitial submits itself and the real page follows a few
  // seconds later, so the first document is not yet evidence of a challenge.
  // The reader re-reads the same page — it never clicks, submits or reloads.
  const documents = [CHALLENGE_HTML, CHALLENGE_HTML, PROFILE_HTML];
  let reads = 0;
  const client = gracePageClient(() => { reads++; return documents.shift() ?? PROFILE_HTML; }, { challengeGraceMs: 1_000, challengePollMs: 100 });
  const about = await client.reddit.getUserAbout('x');
  assert.ok(about, 'the page that arrived after the challenge is the one that is read');
  assert.equal(reads, 3, 'one read per poll until the real page lands, and no more');
  assert.equal(client.navigations, 1, 'the challenge is waited out, never reloaded');
  await client.reddit.close();
});

test('a challenge outliving the grace is still reported, after a bounded number of reads', async () => {
  let reads = 0;
  const client = gracePageClient(() => { reads++; return CHALLENGE_HTML; }, { challengeGraceMs: 1_000, challengePollMs: 100 });
  await assert.rejects(client.reddit.getUserAbout('x'), err => err.code === 'browser_challenge');
  assert.equal(reads, 11, 'the initial read plus one per poll across the grace, then it gives up');
  assert.equal(client.navigations, 1);
  await client.reddit.close();
});

test('the challenge grace never delays an ordinary page, including an empty listing', async () => {
  for (const html of [PROFILE_HTML, '<html><body><div id="empty-feed-content">u/x does not have any posts yet</div></body></html>']) {
    let reads = 0, waits = 0;
    const client = gracePageClient(() => { reads++; return html; }, { challengeGraceMs: 60_000, challengePollMs: 100, onWait: () => { waits++; } });
    await (html === PROFILE_HTML ? client.reddit.getUserAbout('x') : client.reddit.getUserListing('x', 'submitted'));
    assert.equal(reads, 1, 'a page that is not a challenge is read once');
    assert.equal(waits, 0, 'and nothing waits on it');
    await client.reddit.close();
  }
});

test('a tag name must end at the tag boundary, not merely at a word boundary', () => {
  // Reddit wraps each card in shreddit-post-flair / -overflow-menu /
  // -text-body. Collecting those as posts fails the id="t3_..." check and
  // condemns the whole listing as unparseable, so the listing must ignore them.
  const html = [
    '<shreddit-post id="t3_aaa111" post-title="Real" subreddit-prefixed-name="r/fixtures" permalink="/r/fixtures/comments/aaa111/real/">',
    '<shreddit-post-flair>flair</shreddit-post-flair>',
    '<shreddit-post-overflow-menu></shreddit-post-overflow-menu>',
    '<shreddit-post-text-body>body</shreddit-post-text-body>',
    '</shreddit-post>',
  ].join('');
  assert.equal(collectTags(html, 'shreddit-post').length, 1, 'only the post itself is a post');
  assert.equal(collectTags(html, 'shreddit-post')[0].id, 't3_aaa111');
  assert.equal(collectTags(html, 'shreddit-post-flair').length, 1, 'and an exact name still matches');

  const posts = parsePosts(html);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].title, 'Real');

  // Self-closing and immediately-closed forms still match.
  assert.equal(collectTags('<shreddit-post/>', 'shreddit-post').length, 1);
  assert.equal(collectTags('<shreddit-post>', 'shreddit-post').length, 1);
});

// ---------- publicly banned accounts ----------

const BANNED_PAGE = "<html><head><title>Reddit - The heart of the internet</title></head><body><h3>u/banned_user</h3><p>This account has been banned</p><textarea id=\"g-recaptcha-response-100000\" name=\"g-recaptcha-response\" class=\"g-recaptcha-response\"></textarea></body></html>";

test('a publicly banned account reads as suspended, not as a browser challenge', async () => {
  // Reddit says so on the profile page itself. The page carries no profile
  // card, so before this it fell through to "unrecognized page" and the check
  // failed instead of reporting the ban that the schema and checker support.
  assert.equal(isRedditSuspended(BANNED_PAGE), true);
  assert.deepEqual(parseProfile(BANNED_PAGE, 'banned_user'), { state: 'suspended' });

  const client = fixtureClient(scriptedBrowser([{ html: BANNED_PAGE }]), { challengeGraceMs: 0 });
  assert.deepEqual(await client.getUserAbout('banned_user'), { state: 'suspended' });
  assert.equal(client.getDiagnostics().readable, true, 'a ban notice is a successful read');
  await client.close();
});

test("reCAPTCHA's response field is not a challenge, but a real widget still is", async () => {
  // The hidden g-recaptcha-response textarea rides along on ordinary Reddit
  // pages; treating it as evidence condemned every card-less page.
  const page = html => fixtureClient(scriptedBrowser([{ html }]), { challengeGraceMs: 0 });

  const benign = page('<html><head><title>Reddit</title></head><body>' +
    '<textarea class="g-recaptcha-response"></textarea>' +
    '<span data-testid="contribution-count">3</span>' +
    '<time data-testid="cake-day" datetime="2020-01-01T00:00:00.000Z"></time></body></html>');
  const about = await benign.getUserAbout('x');
  assert.equal(about.state, 'active', 'the response field alone must not block a real profile');
  await benign.close();

  for (const marker of ['<div class="g-recaptcha" data-sitekey="k"></div>', '<div id="cf-chl-widget"></div>']) {
    const challenged = page('<html><head><title>Reddit</title></head><body>' + marker + '</body></html>');
    await assert.rejects(challenged.getUserAbout('x'), err => err.code === 'browser_challenge',
      'a genuine challenge widget is still reported');
    await challenged.close();
  }
});

test('a healthy profile is never mistaken for a banned one', () => {
  assert.equal(isRedditSuspended(PROFILE_HTML), false);
  // The phrase must be the page's own notice, not a post title mentioning it.
  const posting = '<html><body><shreddit-post id="t3_a" post-title="This account has been banned" ' +
    'subreddit-prefixed-name="r/x" permalink="/r/x/comments/a/t/"></shreddit-post></body></html>';
  assert.equal(isRedditSuspended(posting), false, 'cards on the page mean it is not a ban notice');
});

// ---------- a warm browser that was closed by hand ----------

test('a warm browser closed between checks is replaced without failing the check', async () => {
  // Reddit refuses headless reads, so the reader window is visible on the
  // operator's desktop and can be closed by hand. The first check warms the
  // browser; by the second that same session is dead. That is not a Reddit
  // failure, so the check should succeed on a fresh session rather than
  // report an error the way it did before.
  const healthy = scriptedBrowser();
  let pages = 0;
  const warmThenDead = {
    closes: 0,
    async newPage() {
      // Works once, then the window is gone -- the driver object is still
      // cached, which is exactly what a hand-closed browser looks like.
      if (pages++ > 0) throw new Error('Target page, context or browser has been closed');
      return healthy.newPage();
    },
    async close() { this.closes++; },
  };
  const replacement = scriptedBrowser();
  const order = [warmThenDead, replacement];
  let launches = 0;
  const client = createHtmlRedditClient({ createBrowser: async () => order[launches++], minIntervalMs: 0, settleMs: 0 });

  assert.equal((await client.getUserAbout('x')).state, 'active', 'the first check warms the browser');
  assert.equal(launches, 1);

  assert.equal((await client.getUserAbout('x')).state, 'active', 'the dead session is replaced in-request');
  assert.equal(launches, 2, 'one replacement, no more');
  assert.equal(warmThenDead.closes, 1, 'and the dead one is disposed');
  await client.close();
});

test('a browser failing on a fresh launch is reported, never retried into a second one', async () => {
  // The opposite case: nothing warm to replace, so a failure here is real and
  // retrying would only start a second broken browser.
  let launches = 0;
  const client = createHtmlRedditClient({
    createBrowser: async () => { launches++; return { newPage: async () => { throw new Error('Target page, context or browser has been closed'); }, close: async () => {} }; },
    minIntervalMs: 0, settleMs: 0,
  });
  await assert.rejects(client.getUserAbout('x'), err => err.code === 'browser_error');
  assert.equal(launches, 1, 'one launch, reported as it stands');
  await client.close();
});
