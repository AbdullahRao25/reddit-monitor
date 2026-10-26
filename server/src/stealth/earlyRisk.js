// Early shadowban risk detection.
//
// Before a shadowban becomes visible (the 404 on /about), Reddit's spam
// systems build up a case against the account. This module scores those
// pre-ban signals so that a stealth-mode account can be warned while the
// damage is still reversible — not when the account is already invisible.
//
// The signals fall into three groups, in the order Reddit's systems
// weight them (strongest first):
//
//   1. Identity signals — who the account is (age, karma, email,
//      timezone). Cheap to check, always available from the public profile.
//
//   2. Content signals — what the account is doing (link concentration,
//      copy-paste text, activity bursts, removals by Reddit itself).
//      Computed from the recent items the checker already collects.
//
//   3. Temporal signals — when the account is acting (posting in the
//      middle of its own local night, no pause after a removal). These
//      are the strongest early-warning signals because they are the ones
//      that distinguish a human on a normal routine from an automated
//      or run-away account.
//
// The output is a 0–100 "early risk" score plus per-signal breakdown and
// targeted recommendations. It is NOT a substitute for the overall
// risk score in risk.js — it feeds it. The checker appends these signals
// to the assessment factors when stealth mode is on, and alerts.js can
// fire an early-warning alert when the score crosses a threshold.

import { REMOVED_STATUSES, SITEWIDE_STATUSES } from '../content.js';
import { maxInWindow, normalizeUrl } from '../risk.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Minimum recent activity for content-based signals to mean anything.
const MIN_SAMPLE = 3;

// A pause after a removal is worth asking for if a removal landed within
// this window. Mirrors behavior.js's COOLDOWN_WINDOW.
const COOLDOWN_WINDOW = 3 * DAY;

// Account age thresholds. Newer = stricter filtering by Reddit.
const NEW_ACCOUNT_DAYS = 14;
const YOUNG_ACCOUNT_DAYS = 30;

// Karma thresholds. Many subreddits auto-filter below these.
const LOW_KARMA = 20;
const VERY_LOW_KARMA = 5;

// Link concentration: if one domain makes up this share of link posts,
// the account looks like it is promoting a single site.
const DOMAIN_SHARE = 0.5;
const DOMAIN_MIN_POSTS = 3;

// Burst thresholds: how many items in a short window is suspicious.
const BURST_HOUR = 6;   // items in 1 hour
const BURST_DAY = 10;   // posts in 1 day

// Temporal thresholds.
const MIDNIGHT_SHARE = 0.4;  // share of items in 0–6 local hours
const COOLDOWN_POSTS_AFTER_REMOVAL = 3;

// Returns the local hour (0-23) of a timestamp in an IANA timezone, or
// null when the zone is unknown to this runtime. Mirrors behavior.js's
// localHourIn (duplicated here so this module has no dependency on it).
function localHourIn(timestamp, timeZone) {
  try {
    const hour = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone,
    })
      .formatToParts(new Date(timestamp))
      .find((part) => part.type === 'hour')?.value;
    return hour === undefined ? null : Number(hour);
  } catch {
    return null;
  }
}

// Share of timestamps whose local hour in `timeZone` falls in 0..NIGHT_END.
// NIGHT_END=6 matches behavior.js.
const NIGHT_END = 6;
function midnightShare(timestamps, timeZone) {
  if (!timeZone) return null;
  let night = 0;
  let known = 0;
  for (const timestamp of timestamps) {
    const hour = localHourIn(timestamp, timeZone);
    if (hour === null) continue;
    known++;
    if (hour >= 0 && hour < NIGHT_END) night++;
  }
  return known ? night / known : null;
}

function topCounts(values, limit) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function normalizeText(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const pct = (ratio) => `${Math.round(ratio * 100)}%`;

/**
 * Compute an early shadowban risk assessment for an active account.
 *
 * Returns:
 *   score:        0–100, higher is riskier.
 *   level:        'low' | 'elevated' | 'high' | 'critical'.
 *   signals:      [{ key, label, points, detail, priority, title, body }]
 *                 one entry per triggered signal, sorted by points desc.
 *                 Each signal carries its own recommendation fields so
 *                 callers can render "what to do" without a second pass.
 *
 * account: the accounts row (with stealth_mode, fingerprint).
 * profile: the latest public profile ({ createdAt, linkKarma,
 *          commentKarma, hasVerifiedEmail }).
 * items:   recent posts/comments, each
 *          { kind, subreddit, createdAt (ms), score, domain, url, text, removalStatus }.
 * now:     current time in ms.
 */
export function assessEarlyRisk({
  account,
  profile = null,
  items = [],
  now = Date.now(),
}) {
  if (!account?.stealth_mode) return null;
  const signals = [];
  const recent = items.filter((item) => now - item.createdAt <= 30 * DAY);
  const counted = recent.filter((item) => item.removalStatus !== 'deleted_by_author');
  const removed = counted.filter((item) => REMOVED_STATUSES.has(item.removalStatus));
  const sitewide = removed.filter((item) => SITEWIDE_STATUSES.has(item.removalStatus));

  // ── 1. Identity signals ──────────────────────────────────────────────────

  // 1a. New account — the single strongest early signal. Reddit's spam
  // filter is strictest in the first 14 days of an account's life.
  let ageDays = null;
  if (profile?.createdAt) {
    ageDays = Math.floor((now - profile.createdAt) / DAY);
    if (ageDays < NEW_ACCOUNT_DAYS) {
      const points = ageDays < 7 ? 25 : 15;
      signals.push({
        key: 'early_new_account',
        label: 'Very new account',
        points,
        priority: ageDays < 7 ? 'urgent' : 'high',
        title: 'Account is in its strictest period',
        body:
          `The account is ${plural(ageDays, 'day')} old. Reddit's spam filter is strictest ` +
          'for the first two weeks. Avoid any self-promotion or repeated links until it is ' +
          `${YOUNG_ACCOUNT_DAYS} days old with positive karma.`,
        detail:
          `Account is ${plural(ageDays, 'day')} old. The first 14 days carry the highest ` +
          'shadowban probability.',
      });
    } else if (ageDays < YOUNG_ACCOUNT_DAYS) {
      signals.push({
        key: 'early_young_account',
        label: 'Young account',
        points: 8,
        priority: 'normal',
        title: 'Account is still under strict monitoring',
        body:
          `The account is ${plural(ageDays, 'day')} old. Reddit relaxes spam filtering after ` +
          `${YOUNG_ACCOUNT_DAYS} days if the account has built positive karma. Keep activity ` +
          'moderate until then.',
        detail: `Account is ${plural(ageDays, 'day')} old.`,
      });
    }
  }

  // 1b. Very low or negative karma. Unknown karma (null from the HTML client)
  // is skipped rather than scored as zero.
  const karmaKnown = profile != null && (profile.linkKarma != null || profile.commentKarma != null);
  const linkKarma = profile?.linkKarma ?? 0;
  const commentKarma = profile?.commentKarma ?? 0;
  const totalKarma = linkKarma + commentKarma;
  if (karmaKnown && commentKarma < 0) {
    signals.push({
      key: 'early_negative_karma',
      label: 'Negative comment karma',
      points: 15,
      priority: 'high',
      title: 'Negative comment karma trips the spam filter',
      body:
        `Comment karma is ${commentKarma}. Reddit rate-limits accounts with negative karma, ` +
        'and many subreddits auto-remove their posts. Build karma in 1–2 subreddits where ' +
        'the account already has standing before posting elsewhere.',
      detail: `Comment karma is ${commentKarma}.`,
    });
  } else if (karmaKnown && totalKarma < VERY_LOW_KARMA) {
    signals.push({
      key: 'early_very_low_karma',
      label: 'Very low karma',
      points: 10,
      priority: 'high',
      title: 'Build karma before posting where it matters',
      body:
        `Total karma is ${totalKarma}. Many subreddits auto-remove posts from accounts below ` +
        'a karma floor. Warm the account up in permissive subreddits first.',
      detail: `Total karma is ${totalKarma}.`,
    });
  } else if (karmaKnown && totalKarma < LOW_KARMA) {
    signals.push({
      key: 'early_low_karma',
      label: 'Low karma',
      points: 5,
      priority: 'normal',
      title: 'Karma is below the threshold many subreddits filter on',
      body:
        `Total karma is ${totalKarma}. Some subreddits auto-remove posts below a karma floor. ` +
        'Check the rules of each subreddit before posting.',
      detail: `Total karma is ${totalKarma}.`,
    });
  }

  // 1c. Unverified email.
  if (profile?.hasVerifiedEmail === false) {
    signals.push({
      key: 'early_unverified_email',
      label: 'Email not verified',
      points: 5,
      priority: 'normal',
      title: 'Verify an email address',
      body:
        'The account has no verified email. Unverified accounts get a stricter spam-filter ' +
        'threshold and lose the ability to receive suspension or appeal notices. Add and ' +
        'verify one in Settings → Account.',
      detail: 'No verified email on the account.',
    });
  }

  // ── 2. Content signals ───────────────────────────────────────────────────

  if (counted.length >= MIN_SAMPLE) {
    // 2a. Removals by Reddit itself (sitewide spam filter).
    if (sitewide.length > 0) {
      const heavy = sitewide.length >= 2;
      signals.push({
        key: 'early_sitewide_removals',
        label: "Removed by Reddit's spam filter",
        points: heavy ? 25 : 15,
        priority: heavy ? 'urgent' : 'high',
        title: 'The spam filter is already acting on this account',
        body:
          `${plural(sitewide.length, 'recent item')} was removed by Reddit itself, not by ` +
          'subreddit moderators. Sitewide removals are the strongest early-warning signal: ' +
          'the filter has registered the account. Stop the pattern that caused it (same ' +
          'link, same text, or burst timing) and pause for a few days.',
        detail:
          `${plural(sitewide.length, 'item')} removed by Reddit's sitewide spam filter in the ` +
          'last 30 days.',
      });
    }

    // 2b. Link concentration on one domain.
    const linkPosts = recent.filter((item) => item.kind === 'post' && item.domain);
    const [topDomain] = topCounts(linkPosts.map((item) => item.domain), 1);
    if (topDomain && topDomain[1] >= DOMAIN_MIN_POSTS) {
      const [domain, postCount] = topDomain;
      const commentMentions = recent.filter(
        (item) => item.kind === 'comment' && item.text?.toLowerCase().includes(domain),
      ).length;
      const ratio = (postCount + commentMentions) / counted.length;
      if (ratio >= DOMAIN_SHARE) {
        const points = ratio >= 0.7 ? 20 : 12;
        signals.push({
          key: 'early_domain_concentration',
          label: `Activity dominated by ${domain}`,
          points,
          priority: ratio >= 0.7 ? 'high' : 'normal',
          title: `Cut back on ${domain}`,
          body:
            `${pct(ratio)} of recent activity links to or mentions ${domain}. An account that ` +
            'mostly promotes one site reads as a marketing account to the spam filter. ' +
            'Diversify: post in subreddits where the domain is on-topic, or mix in ' +
            'genuine community activity that does not reference it.',
          detail:
            `${pct(ratio)} of recent activity references ${domain} (${plural(postCount, 'post')}, ` +
            `${plural(commentMentions, 'comment')}).`,
        });
      }
    }

    // 2c. Same link posted to multiple subreddits in a short window.
    const week = recent.filter((item) => now - item.createdAt <= 7 * DAY);
    const subredditsByUrl = new Map();
    for (const item of week) {
      if (item.kind !== 'post' || !item.url) continue;
      const key = normalizeUrl(item.url);
      if (!subredditsByUrl.has(key)) subredditsByUrl.set(key, new Set());
      subredditsByUrl.get(key).add(item.subreddit);
    }
    const [worstUrl, worstSubs] = [...subredditsByUrl.entries()].sort(
      (a, b) => b[1].size - a[1].size,
    )[0] ?? [null, new Set()];
    if (worstSubs.size >= 3) {
      const points = worstSubs.size >= 5 ? 20 : 12;
      signals.push({
        key: 'early_crosspost_link',
        label: 'Same link posted to many subreddits',
        points,
        priority: 'high',
        title: 'Stop crossposting the same link',
        body:
          'One link across multiple communities is one of the strongest spam signals. ' +
          'Reddit\'s filter tracks per-link posting patterns per account. Post the link in ' +
          'the one or two subreddits where it is clearly on-topic, or rewrite it as a ' +
          'text post that references it rather than linking directly.',
        detail: `${worstUrl} was posted to ${worstSubs.size} subreddits in the last 7 days.`,
      });
    }

    // 2d. Copy-pasted comment text.
    const commentTexts = recent
      .filter((item) => item.kind === 'comment' && item.text)
      .map((item) => normalizeText(item.text))
      .filter((text) => text.length >= 20);
    const [repeated] = topCounts(commentTexts, 1);
    if (repeated && repeated[1] >= 3) {
      const points = repeated[1] >= 5 ? 15 : 10;
      signals.push({
        key: 'early_duplicate_comments',
        label: 'Repeated identical comments',
        points,
        priority: repeated[1] >= 5 ? 'high' : 'normal',
        title: 'Stop reusing the same comment text',
        body:
          'Identical comments in different threads are a classic bot signature. Vary the ' +
          'wording, the length, and the structure between comments, or reply to what each ' +
          'thread is actually discussing.',
        detail: `The same comment text was posted ${repeated[1]} times in the last 30 days.`,
      });
    }

    // 2e. Activity bursts.
    const burstHour = maxInWindow(week.map((item) => item.createdAt), HOUR);
    const postsPerDay = maxInWindow(
      week.filter((item) => item.kind === 'post').map((item) => item.createdAt),
      DAY,
    );
    if (burstHour >= BURST_HOUR || postsPerDay >= BURST_DAY) {
      const points = Math.max(
        burstHour >= 12 ? 12 : burstHour >= BURST_HOUR ? 8 : 0,
        postsPerDay >= BURST_DAY ? 10 : 0,
      );
      signals.push({
        key: 'early_activity_burst',
        label: 'Bursts of activity',
        points,
        priority: 'normal',
        title: 'Slow down and space activity out',
        body:
          `Up to ${plural(burstHour, 'post/comment')} in one hour or ${plural(postsPerDay, 'post')} ` +
          'in one day. High-volume bursts trip rate limits and the spam filter. If the ' +
          'activity is automated, add randomness to timing and keep the daily total under ' +
          `${BURST_DAY}.`,
        detail: `Peak: ${burstHour} items in an hour, ${postsPerDay} posts in a day.`,
      });
    }
  }

  // ── 3. Temporal signals ──────────────────────────────────────────────────

  const timezone = account?.fingerprint?.timezone ?? account?.timezone_hint ?? null;

  // 3a. Posting in the middle of the account's own local night.
  if (timezone && recent.length >= MIN_SAMPLE) {
    const share = midnightShare(recent.map((item) => item.createdAt), timezone);
    if (share !== null && share >= MIDNIGHT_SHARE) {
      const nightCount = Math.round(share * recent.length);
      const points = share >= 0.6 ? 15 : 10;
      signals.push({
        key: 'early_night_posting',
        label: 'Posting in the middle of the local night',
        points,
        priority: 'high',
        title: 'Move activity to waking hours',
        body:
          `${nightCount} of ${recent.length} recent items landed between 12 am and 6 am in ` +
          `${timezone}. A human does not post at 3 am in their own timezone. This is one ` +
          'of the clearest bot signals and one of the strongest early warnings. Schedule ' +
          'the account\'s activity into normal waking hours in that timezone.',
        detail:
          `${nightCount} of ${recent.length} items posted 12–6 am in ${timezone} ` +
          `(${pct(share)}).`,
      });
    }
  }

  // 3b. No pause after a removal — the strongest "about to be shadowbanned"
  // signal. The filter hit is fresh and the account is continuing the
  // behaviour that caused it.
  const freshRemoval = recent
    .filter(
      (item) =>
        SITEWIDE_STATUSES.has(item.removalStatus) && now - item.createdAt <= COOLDOWN_WINDOW,
    ).length;
  // Count only activity *after* the most recent sitewide removal.
  // Earlier items in the same three-day window are not evidence of continued activity.
  const lastRemovalAt = Math.max(0, ...recent
    .filter((item) => SITEWIDE_STATUSES.has(item.removalStatus) && now - item.createdAt <= COOLDOWN_WINDOW)
    .map((item) => item.createdAt));
  const sinceRemoval = recent.filter((item) =>
    lastRemovalAt > 0 && item.createdAt > lastRemovalAt && !SITEWIDE_STATUSES.has(item.removalStatus),
  ).length;
  if (freshRemoval > 0 && sinceRemoval >= COOLDOWN_POSTS_AFTER_REMOVAL) {
    signals.push({
      key: 'early_no_cooldown',
      label: 'No pause after a removal',
      points: 20,
      priority: 'urgent',
      title: 'Pause immediately after the recent removals',
      body:
        `${freshRemoval} item${freshRemoval === 1 ? ' was' : 's were'} removed by Reddit in the ` +
        `last 3 days, and the account has posted ${sinceRemoval} more since. Continuing the ` +
        'same activity straight after a spam-filter hit is what turns a single hit into a ' +
        'shadowban. Stop posting for 48–72 hours, then resume with a different pattern ' +
        '(different subreddit, different link or text, different timing).',
      detail:
        `${freshRemoval} sitewide removal${freshRemoval === 1 ? '' : 's'} in the last 3 days, ` +
        `${sinceRemoval} items posted since.`,
    });
  }

  // ── Score ────────────────────────────────────────────────────────────────

  const rawScore = signals.reduce((sum, signal) => sum + signal.points, 0);
  const score = Math.min(100, rawScore);
  const level = score >= 75 ? 'critical' : score >= 50 ? 'high' : score >= 25 ? 'elevated' : 'low';

  signals.sort((a, b) => b.points - a.points);

  return {
    score,
    level,
    signals,
    // Convenience: the top signal's recommendation, if any.
    top: signals[0] ?? null,
  };
}

/**
 * Convert an early-risk result into the recommendation shape risk.js uses,
 * so the checker can append them to the normal recommendation list.
 * Returns [] for a null result (stealth off) or an empty signal list.
 */
export function earlyRiskRecommendations(early) {
  if (!early || early.signals.length === 0) return [];
  return early.signals.map((signal) => ({
    key: signal.key,
    priority: signal.priority,
    title: signal.title,
    body: signal.body,
  }));
}
