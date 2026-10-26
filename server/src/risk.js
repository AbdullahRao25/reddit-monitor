// Risk scoring for a Reddit account, from what is publicly visible about it.
//
// Each factor is behaviour that Reddit's spam systems or subreddit
// AutoModerator rules are known to act on. Recommendations point at Reddit's
// own rules and processes (stop the behaviour, ask the moderators, appeal),
// not at ways of avoiding detection.

import { REMOVED_STATUSES, SITEWIDE_STATUSES } from './content.js';
import { behaviorFactors } from './behavior.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Removal rates are meaningless on a handful of items.
const MIN_SAMPLE = 5;

const APPEALS_LINK = { label: 'Reddit appeals form', url: 'https://www.reddit.com/appeals' };
const POLICY_LINK = {
  label: 'Reddit Content Policy',
  url: 'https://www.redditinc.com/policies/content-policy',
};

export const RISK_LEVELS = ['low', 'elevated', 'high', 'critical'];

export function riskLevel(score) {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'elevated';
  return 'low';
}

const PRIORITY_ORDER = { urgent: 0, high: 1, normal: 2 };

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const pct = (ratio) => `${Math.round(ratio * 100)}%`;

function topCounts(values, limit) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

// Largest number of timestamps falling inside any window of `windowMs`.
export function maxInWindow(timestamps, windowMs) {
  const sorted = [...timestamps].sort((a, b) => a - b);
  let best = 0;
  let start = 0;
  for (let end = 0; end < sorted.length; end++) {
    while (sorted[end] - sorted[start] > windowMs) start++;
    best = Math.max(best, end - start + 1);
  }
  return best;
}

export function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.startsWith('utm_') || key === 'ref') parsed.searchParams.delete(key);
    }
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    return `${host}${parsed.pathname.replace(/\/$/, '')}${parsed.search}`;
  } catch {
    return url;
  }
}

const normalizeText = (text) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

function result(score, factors, recommendations) {
  const capped = Math.min(100, score);
  return {
    score: capped,
    level: riskLevel(capped),
    factors: [...factors].sort((a, b) => b.points - a.points),
    recommendations: [...recommendations].sort(
      (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority],
    ),
  };
}

function noEvasionRecommendation() {
  return {
    key: 'no_ban_evasion',
    priority: 'high',
    title: "Don't move the same activity to another account",
    body:
      'Continuing the same posting from a different account while one is banned is treated ' +
      'as ban evasion, and is the most common reason several accounts get banned together. ' +
      'Work out what triggered the ban first: the risk factors from the checks before it ' +
      'are listed in this account\'s history.',
  };
}

function shadowbanned(username, lastSeenActiveAt) {
  const seen = lastSeenActiveAt ? new Date(lastSeenActiveAt).toISOString().slice(0, 10) : null;
  return result(
    100,
    [
      {
        key: 'shadowban',
        label: 'Profile not publicly visible',
        points: 100,
        detail:
          'Reddit answers "not found" for this account to logged-out viewers' +
          (seen ? `, but it was visible on ${seen}` : '') +
          '. From the outside, this is what a shadowban looks like.',
      },
    ],
    [
      {
        key: 'confirm_shadowban',
        priority: 'urgent',
        title: 'Confirm it in a private window',
        body:
          `Open https://www.reddit.com/user/${username} in a private/incognito window. If it says ` +
          'the page does not exist while you can still log in to the account, it is shadowbanned. ' +
          'If you deleted the account yourself, remove it from monitoring.',
      },
      {
        key: 'appeal',
        priority: 'urgent',
        title: 'Submit an appeal',
        body:
          "Shadowbans are applied by Reddit's anti-spam systems and are sometimes lifted on " +
          'appeal. Appeal while logged in to the affected account and describe honestly what ' +
          'the account is used for.',
        links: [APPEALS_LINK],
      },
      {
        key: 'pause_posting',
        priority: 'high',
        title: 'Stop posting from this account until it is resolved',
        body: 'Nothing it posts is visible to anyone else right now, so posting more achieves nothing.',
      },
      noEvasionRecommendation(),
    ],
  );
}

function suspended() {
  return result(
    100,
    [
      {
        key: 'suspended',
        label: 'Account suspended',
        points: 100,
        detail: 'Reddit reports this account as suspended.',
      },
    ],
    [
      {
        key: 'read_notice',
        priority: 'urgent',
        title: 'Read the suspension notice',
        body:
          "Reddit sends the reason and duration to the account's inbox and email. Temporary " +
          'suspensions lift on their own when the period ends.',
      },
      {
        key: 'appeal',
        priority: 'high',
        title: 'Appeal if it was a mistake',
        body: 'If the suspension is wrong, appeal while logged in to the suspended account.',
        links: [APPEALS_LINK],
      },
      noEvasionRecommendation(),
    ],
  );
}

function notFound(username) {
  return result(
    80,
    [
      {
        key: 'not_found',
        label: 'Account not found',
        points: 80,
        detail:
          'Reddit answers "not found" for this username, and it has never been seen as visible ' +
          'by this monitor.',
      },
    ],
    [
      {
        key: 'check_username',
        priority: 'urgent',
        title: 'Check the username',
        body: `Make sure "${username}" is spelled exactly as on Reddit. If it was deleted, remove it from monitoring.`,
      },
      {
        key: 'appeal_new',
        priority: 'high',
        title: 'If you can log in to it, it may be shadowbanned since creation',
        body:
          "New accounts are sometimes shadowbanned by Reddit's spam filter as soon as they are " +
          'created. If the spelling is right and you can still log in, submit an appeal.',
        links: [APPEALS_LINK],
      },
    ],
  );
}

/**
 * items: posts/comments from the account, each
 *   { kind, subreddit, createdAt (ms), score, domain, url, text, removalStatus }
 * previous: the previous health_checks row, if any (for karma trend).
 * hiddenItems: posts/comments the profile counts but the public can't see
 *   (checker.js hiddenItemCount), or null when that can't be told.
 * unlisted: listings that aren't public at all ('posts' / 'comments'), e.g.
 *   because the owner hid them on the profile.
 */
export function assessRisk({
  username,
  status,
  profile = null,
  items = [],
  previous = null,
  newlyRemoved = 0,
  hiddenItems = null,
  unlisted = [],
  lastSeenActiveAt = null,
  now = Date.now(),
  account = null,
}) {
  if (status === 'shadowbanned') return shadowbanned(username, lastSeenActiveAt);
  if (status === 'suspended') return suspended();
  if (status === 'not_found') return notFound(username);

  const factors = [];
  const recs = [];

  const recent = items.filter((item) => now - item.createdAt <= 30 * DAY);
  const counted = recent.filter((item) => item.removalStatus !== 'deleted_by_author');
  const removed = counted.filter((item) => REMOVED_STATUSES.has(item.removalStatus));
  const sitewide = removed.filter((item) => SITEWIDE_STATUSES.has(item.removalStatus));

  // 1. Removals by Reddit itself
  if (sitewide.length > 0) {
    const heavy = sitewide.length >= 3;
    factors.push({
      key: 'sitewide_removals',
      label: "Removed by Reddit's spam filter",
      points: heavy ? 30 : 15,
      detail:
        `${plural(sitewide.length, 'recent item')} removed by Reddit itself rather than by ` +
        'subreddit moderators. Site-wide spam-filter removals usually come before a shadowban.',
    });
    recs.push({
      key: 'review_filtered',
      priority: heavy ? 'urgent' : 'high',
      title: 'Find out what the spam filter is reacting to',
      body:
        'Look at what the filtered items have in common: the same link, the same text, or many ' +
        "posts in a short time. Stop doing that from this account. Reddit's Content Policy " +
        'treats repetitive or unsolicited promotion as spam.',
      links: [POLICY_LINK],
    });
  }

  // 2. Overall removal rate
  if (counted.length >= MIN_SAMPLE) {
    const rate = removed.length / counted.length;
    const points = rate >= 0.5 ? 30 : rate >= 0.25 ? 20 : rate >= 0.1 ? 10 : 0;
    if (points > 0) {
      factors.push({
        key: 'removal_rate',
        label: 'High removal rate',
        points,
        detail: `${removed.length} of ${counted.length} posts/comments from the last 30 days (${pct(rate)}) were removed.`,
      });
      const bySubreddit = topCounts(
        removed.map((item) => item.subreddit).filter(Boolean),
        3,
      );
      if (bySubreddit.length > 0) {
        recs.push({
          key: 'subreddit_rules',
          priority: rate >= 0.25 ? 'high' : 'normal',
          title: 'Check the rules where posts are being removed',
          body:
            `Most removals are in ${bySubreddit.map(([sub, n]) => `r/${sub} (${n})`).join(', ')}. ` +
            "Read those subreddits' rules (many set a minimum account age or karma, or ban " +
            'self-promotion), or message their moderators and ask why.',
        });
      }
    }
  } else {
    factors.push({
      key: 'small_sample',
      label: 'Little recent activity',
      points: 0,
      detail: `Only ${plural(counted.length, 'publicly visible post/comment')} in the last 30 days, so removal rates are not meaningful yet.`,
    });
  }

  // 2a. Listings that aren't public: nothing in them can be counted, so the
  // activity and removal numbers above say nothing about that part.
  if (unlisted.length > 0) {
    const what = unlisted.join(' and ');
    factors.push({
      key: 'listings_hidden',
      label: `${what[0].toUpperCase()}${what.slice(1)} not shown on the profile`,
      points: 0,
      kinds: unlisted,
      detail:
        `This account's profile doesn't show its ${what} to the public (owners can hide them in Reddit's ` +
        'profile settings), so its activity, removals and filtered content there cannot be monitored. ' +
        'Zero activity here means "not visible", not "none".',
    });
    recs.push({
      key: 'show_profile_activity',
      priority: 'normal',
      title: `Show ${what} on the profile to monitor them`,
      body:
        `In this account's Reddit profile settings, set its ${what} to be shown. Until then removals and ` +
        "filtered posts/comments can't be detected for it.",
    });
  }

  // 2b. Content nobody else can see. A post or comment that AutoModerator or
  // Reddit's spam filter hid as it was posted never appears in any listing:
  // it looks normal to the account itself and is missing for everyone else.
  // Its only public trace is the profile's Contributions count.
  if (hiddenItems > 0) {
    const visible = Math.max(0, (profile?.contributions ?? hiddenItems) - hiddenItems);
    const one = hiddenItems === 1;
    factors.push({
      key: 'hidden_items',
      label: 'Posts/comments hidden from the public',
      points: hiddenItems >= 3 ? 25 : hiddenItems === 2 ? 15 : 10,
      // Kept on the stored factor: the next check compares against it.
      count: hiddenItems,
      detail:
        `The public profile counts ${plural(profile?.contributions ?? hiddenItems, 'contribution')}, but logged-out ` +
        `visitors can see ${visible === 0 ? 'none' : `only ${visible}`}. ` +
        `${one ? 'The missing one looks' : `The ${hiddenItems} missing ones look`} normal to the account itself but ` +
        `${one ? 'is' : 'are'} hidden from everyone else: most likely filtered by the subreddit (AutoModerator often ` +
        "holds back posts from new or low-karma accounts) or by Reddit's spam filter.",
    });
    recs.push({
      key: 'find_hidden_items',
      priority: 'high',
      title: 'Find out which posts/comments are hidden, and why',
      body:
        'Open each recent post and comment in a private (logged-out) window: one that is missing there is ' +
        "hidden from everyone else. Check that subreddit's rules for a minimum account age or karma, and " +
        'message its moderators to ask whether it was filtered. Don\'t post the same thing again: repeating ' +
        'filtered content is what turns a filter hit into a ban.',
    });
  }

  // 3. Sudden removals since the previous check
  if (newlyRemoved >= 3) {
    factors.push({
      key: 'removal_spike',
      label: 'New removals since last check',
      points: 10,
      detail: `${plural(newlyRemoved, 'item')} were removed since the previous check.`,
    });
  }

  // 4. Account dominated by one website
  const linkPosts = recent.filter((item) => item.kind === 'post' && item.domain);
  const [topDomain] = topCounts(linkPosts.map((item) => item.domain), 1);
  if (topDomain && topDomain[1] >= 3) {
    const [domain, postCount] = topDomain;
    const commentMentions = recent.filter(
      (item) => item.kind === 'comment' && item.text?.toLowerCase().includes(domain),
    ).length;
    const ratio = (postCount + commentMentions) / recent.length;
    const points = ratio >= 0.5 ? 25 : ratio >= 0.25 ? 15 : ratio >= 0.1 ? 5 : 0;
    if (points > 0) {
      factors.push({
        key: 'self_promotion',
        label: `Activity dominated by ${domain}`,
        points,
        detail: `${pct(ratio)} of the last 30 days' activity links to or mentions ${domain} (${plural(postCount, 'post')}, ${plural(commentMentions, 'comment')}).`,
      });
      recs.push({
        key: 'self_promotion',
        priority: ratio >= 0.25 ? 'high' : 'normal',
        title: `Cut back on promoting ${domain}`,
        body:
          'Reddit treats accounts that mostly promote one site as spam. Share it only in ' +
          'subreddits whose rules allow self-promotion, only where it answers the discussion, ' +
          'and say that it is yours.',
        links: [POLICY_LINK],
      });
    }
  }

  // 5. Same link posted across many subreddits
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
    factors.push({
      key: 'crossposted_link',
      label: 'Same link posted to many subreddits',
      points: worstSubs.size >= 5 ? 25 : 15,
      detail: `${worstUrl} was posted to ${worstSubs.size} subreddits in the last 7 days.`,
    });
    recs.push({
      key: 'crossposted_link',
      priority: 'high',
      title: 'Stop posting the same link to many subreddits',
      body:
        'Posting one link across many communities is one of the strongest spam signals. Post ' +
        'it only in the one or two subreddits where it is clearly on-topic and allowed.',
    });
  }

  // 6. Copy-pasted comments
  const commentTexts = recent
    .filter((item) => item.kind === 'comment' && item.text)
    .map((item) => normalizeText(item.text))
    .filter((text) => text.length >= 20);
  const [repeated] = topCounts(commentTexts, 1);
  if (repeated && repeated[1] >= 3) {
    factors.push({
      key: 'duplicate_comments',
      label: 'Repeated identical comments',
      points: repeated[1] >= 5 ? 20 : 12,
      detail: `The same comment text was posted ${repeated[1]} times in the last 30 days.`,
    });
    recs.push({
      key: 'duplicate_comments',
      priority: 'high',
      title: 'Stop reusing the same comment',
      body:
        'Identical comments posted in different threads are flagged as spam. Reply to what ' +
        'each thread is actually discussing, or don\'t reply.',
    });
  }

  // 7. Bursts of activity
  const burst = maxInWindow(week.map((item) => item.createdAt), HOUR);
  const postsPerDay = maxInWindow(
    week.filter((item) => item.kind === 'post').map((item) => item.createdAt),
    DAY,
  );
  if (burst >= 10 || postsPerDay >= 8) {
    const points = Math.max(burst >= 20 ? 15 : burst >= 10 ? 8 : 0, postsPerDay >= 8 ? 10 : 0);
    factors.push({
      key: 'activity_burst',
      label: 'Bursts of activity',
      points,
      detail: `Up to ${plural(burst, 'post/comment')} within one hour and ${plural(postsPerDay, 'post')} within one day in the last week.`,
    });
    recs.push({
      key: 'activity_burst',
      priority: 'normal',
      title: 'Slow down',
      body:
        "High-volume posting in short bursts trips Reddit's rate limits and spam filter. If any " +
        "of this activity is automated or scheduled, it has to follow Reddit's API and bot rules.",
    });
  }

  // 8. Account age and karma
  let ageDays = null;
  if (profile?.createdAt) {
    ageDays = Math.floor((now - profile.createdAt) / DAY);
    if (ageDays < 30) {
      factors.push({
        key: 'new_account',
        label: 'New account',
        points: ageDays < 7 ? 15 : 8,
        detail: `The account is ${plural(ageDays, 'day')} old. New accounts get the strictest spam filtering.`,
      });
    }
  }

  // The HTML client reports null karma when the profile card can't be read;
  // unknown karma must not score as zero karma.
  const karmaKnown = profile != null && (profile.linkKarma != null || profile.commentKarma != null);
  const linkKarma = profile?.linkKarma ?? 0;
  const commentKarma = profile?.commentKarma ?? 0;
  const totalKarma = linkKarma + commentKarma;
  if (karmaKnown && commentKarma < 0) {
    factors.push({
      key: 'negative_karma',
      label: 'Negative comment karma',
      points: 15,
      detail: `Comment karma is ${commentKarma}. Reddit rate-limits accounts with negative karma and many subreddits filter them.`,
    });
  } else if (karmaKnown && totalKarma < 10) {
    factors.push({
      key: 'low_karma',
      label: 'Very low karma',
      points: 8,
      detail: `Total karma is ${totalKarma}. Many subreddits auto-remove posts from low-karma accounts.`,
    });
  }
  if ((ageDays !== null && ageDays < 30) || (karmaKnown && totalKarma < 10)) {
    recs.push({
      key: 'posting_requirements',
      priority: 'normal',
      title: "Check each subreddit's posting requirements",
      body:
        'Many subreddits silently remove posts from accounts below a minimum age or karma. ' +
        'The requirements are usually in the sidebar or rules, and posts that miss them are ' +
        'removed no matter what they say.',
    });
  }

  // 9. Heavily downvoted comments
  const scored = recent.filter((item) => item.kind === 'comment' && typeof item.score === 'number');
  if (scored.length >= 10) {
    const share = scored.filter((item) => item.score <= 0).length / scored.length;
    const points = share >= 0.4 ? 10 : share >= 0.25 ? 5 : 0;
    if (points > 0) {
      factors.push({
        key: 'downvoted',
        label: 'Many downvoted comments',
        points,
        detail: `${pct(share)} of recent comments are at 0 points or below.`,
      });
      recs.push({
        key: 'downvoted',
        priority: 'normal',
        title: 'Look at where comments are being downvoted',
        body:
          'Consistent downvotes mean the communities see the comments as off-topic, unhelpful ' +
          'or promotional. Check which subreddits they are in.',
      });
    }
  }

  // 10. Unverified email
  if (profile?.hasVerifiedEmail === false) {
    factors.push({
      key: 'unverified_email',
      label: 'Email not verified',
      points: 5,
      detail: 'The account has no verified email address.',
    });
    recs.push({
      key: 'verify_email',
      priority: 'normal',
      title: 'Verify an email address',
      body:
        'Add and verify an email in Settings → Account. It is needed to recover the account ' +
        'and to receive suspension notices and appeal replies.',
    });
  }

  // 11. Behavioral signals: posting in the middle of the account's own
  // local night, and a pause after a recent removal.
  const { factors: behavior, recs: behaviorRecs } = behaviorFactors({
    items: recent,
    timezone: account?.fingerprint?.timezone ?? account?.timezone_hint ?? null,
    now,
  });
  factors.push(...behavior);
  recs.push(...behaviorRecs);

  // 12. Karma dropping between checks
  if (karmaKnown && previous?.link_karma != null && previous?.comment_karma != null) {
    const drop = previous.link_karma + previous.comment_karma - totalKarma;
    if (drop >= 25) {
      factors.push({
        key: 'karma_drop',
        label: 'Karma dropping',
        points: 5,
        detail: `Karma fell by ${drop} since the previous check.`,
      });
    }
  }

  const score = factors.reduce((sum, factor) => sum + factor.points, 0);
  return result(score, factors, recs);
}
