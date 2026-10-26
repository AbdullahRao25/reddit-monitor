import { interventionFor } from './shield/policy.js';
// Runs one health check for one account: fetch the public view of the
// account and its recent content, detect removals, score the risk, persist
// the result and raise alerts.

import { deriveAlerts } from './alerts.js';
import { classifyRemoval, isPlaceholderText, REMOVED_STATUSES, toContentItem } from './content.js';
import { assessRisk } from './risk.js';
import { assessEarlyRisk, earlyRiskRecommendations } from './stealth/earlyRisk.js';
import { stealthRecommendations } from './stealth/warmup.js';

const DAY = 24 * 60 * 60 * 1000;
// How far back stored posts/comments keep being re-checked for removal.
const RECHECK_DAYS = 30;
// An open alert of the same type suppresses a repeat for this long.
const ALERT_DEDUPE_MS = DAY;

const CONTENT_FIELDS = [
  'id', 'account_id', 'kind', 'subreddit', 'permalink', 'title', 'excerpt',
  'url_domain', 'link_url', 'score', 'created_at',
];
const contentFields = (row) => Object.fromEntries(CONTENT_FIELDS.map((key) => [key, row[key]]));

// A listing this long may be cut off (the HTML page server-renders only the
// newest ~25 items), and then older visible items also make up a difference.
const LISTING_WINDOW = 20;

// How many of the account's posts/comments the public can't see: the profile's
// Contributions count minus every item known to exist. A post or comment that
// AutoModerator or Reddit's spam filter hid as it was posted never shows up in
// any listing, so this gap is its only public trace. null when it can't be
// told: no count (only the HTML client reads it), a listing that isn't public
// (null: the owner hid it, so its items would all look "hidden"), or one that
// may be cut off.
export function hiddenItemCount({ contributions, posts, comments, known }) {
  if (!Number.isFinite(contributions) || posts === null || comments === null) return null;
  if ((posts?.length ?? 0) >= LISTING_WINDOW || (comments?.length ?? 0) >= LISTING_WINDOW) return null;
  return Math.max(0, contributions - known);
}

// Which listings aren't public at all (null from the client), so their
// activity can't be counted: 'posts', 'comments', both or neither.
const unlistedKinds = (posts, comments) => [posts === null && 'posts', comments === null && 'comments'].filter(Boolean);

// Listed items without a readable timestamp can't be placed in the 30-day
// window. They are left out of the counts instead of being guessed at, and
// this 0-point factor says so next to the score.
function undatedFactor(count) {
  return {
    key: 'undated_items',
    label: 'Some activity has no readable date',
    points: 0,
    detail:
      `${count === 1 ? '1 post/comment' : `${count} posts/comments`} on the public profile had no timestamp ` +
      `that could be read, so ${count === 1 ? 'it is' : 'they are'} left out of the 30-day activity and removal counts.`,
  };
}

// Run the full pipeline against the live Reddit API for a username that is
// not (or need not be) a stored account: profile -> newest 100 posts and
// comments -> /api/info -> risk assessment. Nothing is persisted and no
// alerts fire. Returns the same shape as an assessRisk result plus the
// resolved profile and the sampled items.
export async function checkLiveProfile({ reddit, username, now = Date.now() }) {
  const about = await reddit.getUserAbout(username);
  if (about.state === 'not_found') {
    return {
      status: 'not_found',
      profile: null,
      items: [],
      assessment: assessRisk({ username, status: 'not_found', now }),
    };
  }
  if (about.state === 'suspended') {
    return {
      status: 'suspended',
      profile: null,
      items: [],
      assessment: assessRisk({ username, status: 'suspended', now }),
    };
  }

  const [posts, comments] = await Promise.all([
    reddit.getUserListing(username, 'submitted'),
    reddit.getUserListing(username, 'comments'),
  ]);
  const ids = [...new Set([...(posts ?? []), ...(comments ?? [])].map((raw) => raw.name))];
  const info = new Map((await reddit.getInfo(ids)).map((raw) => [raw.name, raw]));
  const hidden = hiddenItemCount({ contributions: about.profile?.contributions, posts, comments, known: ids.length });

  const items = [];
  let undated = 0;
  for (const raw of [...(posts ?? []), ...(comments ?? [])]) {
    // /api/info is the public view of the item, so it decides removal.
    const view = info.get(raw.name) ?? raw;
    const removalStatus = classifyRemoval(view);
    const item = toContentItem(view, username);
    if (!item.created_at) {
      undated++;
      continue;
    }
    items.push({
      id: item.id,
      kind: item.kind,
      subreddit: item.subreddit,
      permalink: item.permalink,
      title: item.title,
      excerpt: item.excerpt,
      createdAt: Date.parse(item.created_at),
      score: item.score,
      domain: item.url_domain,
      url: item.link_url,
      text: raw.body ?? raw.selftext ?? null,
      removalStatus,
    });
  }

  // A profile that was never seen before: every removal counts, same as the
  // first stored check.
  const newlyRemoved = items.filter((item) => REMOVED_STATUSES.has(item.removalStatus)).length;
  const window = items.filter((item) => now - item.createdAt <= RECHECK_DAYS * DAY);
  const assessment = assessRisk({
    username,
    status: 'active',
    profile: about.profile,
    items,
    previous: null,
    newlyRemoved,
    hiddenItems: hidden,
    unlisted: unlistedKinds(posts, comments),
    lastSeenActiveAt: null,
    now,
  });
  if (undated) assessment.factors.push(undatedFactor(undated));

  return {
    status: 'active',
    profile: about.profile,
    items,
    assessment,
    sampled: window.length,
    removed: window.filter((item) => REMOVED_STATUSES.has(item.removalStatus)).length,
    hidden,
    undated,
  };
}

export function createChecker({
  repo,
  reddit,
  notify = async () => {},
  now = () => Date.now(),
  log = console,
}) {
  const inProgress = new Set();

  async function refreshContent(account, checkedAt, profile) {
    const [posts, comments] = await Promise.all([
      reddit.getUserListing(account.username, 'submitted'),
      reddit.getUserListing(account.username, 'comments'),
    ]);
    const listed = new Map([...(posts ?? []), ...(comments ?? [])].map((raw) => [raw.name, raw]));

    // Items from earlier checks that have since dropped off the listing are
    // re-checked as well: that's how removals after posting get caught.
    const since = new Date(now() - RECHECK_DAYS * DAY).toISOString();
    const stored = new Map((await repo.getContentItems(account.id, since)).map((row) => [row.id, row]));

    const ids = [...new Set([...listed.keys(), ...stored.keys()])];
    const current = new Map((await reddit.getInfo(ids)).map((raw) => [raw.name, raw]));
    const hidden = hiddenItemCount({ contributions: profile?.contributions, posts, comments, known: ids.length });

    // Without a public view of an item (the HTML client has no /api/info), an
    // item that is no longer listed is only known to be gone when it is newer
    // than the oldest item still in the listing: then it can't have scrolled
    // out of the newest-first window, so it was removed or deleted. The tail
    // of each listing is used, not its minimum, because pinned posts sit at
    // the top whatever their age.
    const listingTail = { post: null, comment: null };
    for (const [kind, listing] of [['post', posts], ['comment', comments]]) {
      for (const raw of listing ?? []) {
        const createdAt = toContentItem(raw, account.id).created_at;
        if (createdAt) listingTail[kind] = Date.parse(createdAt);
      }
    }
    const vanished = (prev) =>
      prev.removal_status === 'visible' &&
      listingTail[prev.kind] !== null &&
      Date.parse(prev.created_at) > listingTail[prev.kind];

    const rows = [];
    const items = [];
    const newlyRemoved = [];
    let undated = 0;

    for (const id of ids) {
      const listedRaw = listed.get(id);
      const infoRaw = current.get(id);
      const prev = stored.get(id);
      const source = listedRaw ?? infoRaw;
      const base = source ? toContentItem(source, account.id) : contentFields(prev);

      // No readable timestamp: keep the date from an earlier check if there is
      // one. Otherwise the item can't be placed in the 30-day window, so it is
      // left out and reported rather than stored with a made-up date.
      if (!base.created_at) {
        if (!prev?.created_at) {
          undated++;
          continue;
        }
        base.created_at = prev.created_at;
      }

      // /api/info is the public view of the item, so it decides removal.
      const removalStatus = infoRaw
        ? classifyRemoval(infoRaw)
        : listedRaw
          ? classifyRemoval(listedRaw)
          : vanished(prev)
            ? 'removed'
            : prev.removal_status;
      const removed = REMOVED_STATUSES.has(removalStatus);
      const wasRemoved = prev ? REMOVED_STATUSES.has(prev.removal_status) : false;

      const row = {
        ...base,
        // Keep the original text of something that has since been removed.
        excerpt:
          (!base.excerpt || isPlaceholderText(base.excerpt)) && prev?.excerpt
            ? prev.excerpt
            : base.excerpt,
        score: typeof infoRaw?.score === 'number' ? infoRaw.score : base.score,
        removal_status: removalStatus,
        removed_by_category:
          infoRaw?.removed_by_category ?? listedRaw?.removed_by_category ?? prev?.removed_by_category ?? null,
        last_checked_at: checkedAt,
        removal_detected_at: removed ? (prev?.removal_detected_at ?? checkedAt) : null,
      };
      rows.push(row);

      // Only count removals that happened while being monitored; otherwise
      // the first check would report the account's entire history as new.
      if (removed && !wasRemoved && (prev || account.last_checked_at)) newlyRemoved.push(row);

      items.push({
        id,
        kind: row.kind,
        subreddit: row.subreddit,
        createdAt: Date.parse(row.created_at),
        score: row.score,
        domain: row.url_domain,
        url: row.link_url,
        text: listedRaw ? (listedRaw.body ?? listedRaw.selftext ?? null) : null,
        removalStatus,
      });
    }

    await repo.upsertContentItems(rows);
    if (undated) {
      log.warn(
        `Check for u/${account.username}: ${undated} listed item(s) had no readable timestamp ` +
          'and were left out of the 30-day counts.',
      );
    }
    return { items, newlyRemoved, undated, hidden, unlisted: unlistedKinds(posts, comments) };
  }

  async function run(account) {
    const checkedAt = new Date(now()).toISOString();
    let status = null;
    let profile = null;
    let items = [];
    let newlyRemoved = [];
    let undated = 0;
    let hidden = null;
    let unlisted = [];
    let error = null;

    try {
      const about = await reddit.getUserAbout(account.username);
      if (about.state === 'not_found') {
        // Visible before and "not found" now: that's the shadowban signature.
        status = account.last_seen_active_at ? 'shadowbanned' : 'not_found';
      } else if (about.state === 'suspended') {
        status = 'suspended';
      } else {
        status = 'active';
        profile = about.profile;
        ({ items, newlyRemoved, undated, hidden, unlisted } = await refreshContent(account, checkedAt, profile));
      }
    } catch (err) {
      error = err.message || String(err);
      log.warn(`Check failed for u/${account.username}: ${error}`);
    }

    const recentChecks = await repo.getRecentChecks(account.id, 5);
    const previousCheck = recentChecks.find((check) => !check.error) ?? null;
    const assessment = error
      ? null
      : assessRisk({
          username: account.username,
          status,
          profile,
          items,
          previous: previousCheck,
          newlyRemoved: newlyRemoved.length,
          hiddenItems: hidden,
          unlisted,
          lastSeenActiveAt: account.last_seen_active_at,
          now: now(),
          account,
        });

    // Stealth mode: add evasion-layer recommendations to the compliance ones.
    let stealthRecs = [];
    const early =
      account.stealth_mode && assessment && !error
        ? assessEarlyRisk({ account, profile, items, now: now() })
        : null;
    if (account.stealth_mode && assessment && !error) {
      const warmupLog = await repo.getWarmupLog(account.id, 20).catch(() => []);
      stealthRecs = [
        ...earlyRiskRecommendations(early),
        ...stealthRecommendations(account, profile, assessment, warmupLog),
      ];
    }
    const allRecs = [...(assessment?.recommendations ?? []), ...stealthRecs];
    // Append the early-risk signals to the persisted factors so the
    // dashboard's "Why this score" view covers both layers.
    const allFactors = [
      ...(assessment?.factors ?? []),
      ...(undated ? [undatedFactor(undated)] : []),
      ...(early?.signals ?? []).map((signal) => ({
        key: signal.key,
        label: signal.label,
        points: signal.points,
        detail: signal.detail,
      })),
    ];

    const window = items.filter((item) => now() - item.createdAt <= RECHECK_DAYS * DAY);
    const itemsRemoved = window.filter((item) => REMOVED_STATUSES.has(item.removalStatus)).length;
    const check = await repo.insertCheck({
      account_id: account.id,
      checked_at: checkedAt,
      status: error ? 'error' : status,
      link_karma: profile?.linkKarma ?? null,
      comment_karma: profile?.commentKarma ?? null,
      account_created_at: profile?.createdAt ? new Date(profile.createdAt).toISOString() : null,
      has_verified_email: profile?.hasVerifiedEmail ?? null,
      items_sampled: window.length,
      items_removed: itemsRemoved,
      newly_removed: newlyRemoved.length,
      risk_score: assessment?.score ?? null,
      risk_level: assessment?.level ?? null,
      factors: allFactors,
      early_risk: early ? { score: early.score, level: early.level, top: early.top } : null,
      recommendations: allRecs,
      error,
    });

    // A failed check leaves the last known status and risk in place.
    const patch = error
      ? { last_checked_at: checkedAt, ...(account.status === 'pending' ? { status: 'error' } : {}) }
      : {
          status,
          risk_score: assessment.score,
          risk_level: assessment.level,
          // The previous early-risk level, so the next check's alert can tell
          // a high->critical escalation from the first crossing.
          early_risk_level: early?.level ?? null,
          last_checked_at: checkedAt,
          ...(profile ? { link_karma: profile.linkKarma, comment_karma: profile.commentKarma } : {}),
          ...(status === 'active'
            ? { last_seen_active_at: checkedAt, items_sampled: window.length, items_removed: itemsRemoved }
            : {}),
        };
    const updated = await repo.updateAccount(account.id, patch);

    let consecutiveErrors = 0;
    if (error) {
      consecutiveErrors = 1;
      for (const previous of recentChecks) {
        if (!previous.error) break;
        consecutiveErrors++;
      }
    }

    const alerts = [];
    const candidates = deriveAlerts({
      account,
      status,
      assessment,
      earlyRisk: early,
      newlyRemoved,
      hiddenItems: hidden,
      // The count lives in the previous check's hidden_items factor (no column for it).
      previousHidden: previousCheck?.factors?.find((factor) => factor.key === 'hidden_items')?.count ?? 0,
      error,
      consecutiveErrors,
    });
    for (const candidate of candidates) {
      const since = new Date(now() - ALERT_DEDUPE_MS).toISOString();
      if (await repo.findOpenAlert(account.id, candidate.type, since)) continue;
      const alert = await repo.insertAlert({ account_id: account.id, ...candidate });
      alerts.push(alert);
      await notify(alert, account);
    }

    // Shield circuit breaker: advisory submission holds in our own queue.
    // A missing Shield migration must never break core Reddit monitoring.
    const intervention = interventionFor({check,account:updated,consecutiveErrors});
    if(intervention && typeof repo.getActiveShieldHold === 'function') {
      try {
        const existing=await repo.getActiveShieldHold(account.id);
        if(!existing) {
          const hold=await repo.createShieldHold({account_id:account.id,reason:intervention.reason,
            code:intervention.code,source:'monitor'});
          await repo.holdShieldDrafts(account.id);
          if(typeof repo.createShieldIncident==='function') await repo.createShieldIncident({account_id:account.id,summary:intervention.reason,notes:`Auto-created from monitor signal: ${intervention.code}`,status:'open'});
          await repo.insertShieldEvent({account_id:account.id,draft_id:null,event_type:'automatic_hold',
            details:{hold_id:hold.id,intervention,check_id:check.id}});
        }
      } catch (shieldError) {
        log.warn(`Shield hold unavailable: ${shieldError.message}`);
      }
    }

    return { account: updated, check, alerts };
  }

  // Returns null if a check for this account is already running.
  async function checkAccount(account) {
    if (inProgress.has(account.id)) return null;
    inProgress.add(account.id);
    try {
      return await run(account);
    } finally {
      inProgress.delete(account.id);
    }
  }

  return { checkAccount, isChecking: (id) => inProgress.has(id) };
}
