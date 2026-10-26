import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseAttributes,
  parseProfile,
  parsePosts,
  parseComments,
  createHtmlRedditClient,
  toMs,
  toUnixSeconds,
} from '../src/redditHtml.js';
import { createChecker } from '../src/checker.js';
import { createMemoryRepo, NOW, DAY, silentLog } from './helpers.js';

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

test('parseProfile treats a 404 title as not_found', () => {
  const html = '<html><head><title>404 - Reddit</title></head><body>not here</body></html>';
  assert.equal(parseProfile(html, 'nobody').state, 'not_found');
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
  await assert.rejects(client.getUserAbout('x'), /without the profile card \("Reddit - Prevented"\)/);

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

test('client reports not_found for a 404 profile', async () => {
  const fake = makeFakeBrowser({ profile: 404 });
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
  const html = { submitted: page(), comments: page(currentCommentCard()) };
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
    submitted: page(),
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
