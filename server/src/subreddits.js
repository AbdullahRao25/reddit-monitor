// Where the removals are actually happening.
//
// risk.js already mines the subreddit of every removed item — that is how the
// `subreddit_rules` and `crossposted_link` factors get written — but it only
// ever reports the worst one, inside a sentence. The question an owner asks
// next is the one nothing answered: *which community is removing my stuff?*
// A 20% removal rate spread evenly over ten subreddits is a karma problem; the
// same rate coming entirely from one subreddit is one subreddit's rule, and the
// two call for completely different responses.
//
// Pure: the routes read content_items, these functions group them.

import { REMOVED_STATUSES, SITEWIDE_STATUSES } from './content.js';

const DAY = 24 * 60 * 60 * 1000;
export const DEFAULT_WINDOW_DAYS = 90;
// Below this many items in a subreddit, a removal rate is noise: one removal
// out of two posts is not a 50% removal rate, it is one removal.
//
// Exported because the browser-only demo data has to apply the same rule, and
// a client/test case pins the two together rather than trusting them to agree.
export const MIN_ITEMS_FOR_RATE = 4;

const normalize = (value) => String(value ?? '').trim().replace(/^\/?r\//i, '').toLowerCase();

/**
 * Groups items by subreddit. Items with no readable subreddit are counted
 * under `unknown` rather than dropped, so the totals always add up.
 *
 * Returns rows sorted worst-first: most removals, then highest rate, then
 * most items — so the list opens on the community that needs reading about.
 */
export function summarizeSubreddits(items, { now = Date.now(), windowDays = DEFAULT_WINDOW_DAYS } = {}) {
  const since = now - Math.max(1, Number(windowDays) || DEFAULT_WINDOW_DAYS) * DAY;
  const groups = new Map();

  for (const item of items ?? []) {
    const createdAt = Date.parse(item?.created_at ?? '');
    // An undated item (see toContentItem) cannot be placed in the window; it
    // is counted, because it is real, but it cannot date anything.
    const dated = Number.isFinite(createdAt);
    if (dated && createdAt < since) continue;

    const name = normalize(item?.subreddit) || 'unknown';
    if (!groups.has(name)) {
      groups.set(name, {
        subreddit: name,
        items: 0,
        posts: 0,
        comments: 0,
        removed: 0,
        removed_sitewide: 0,
        removed_by_mod: 0,
        undated: 0,
        score: 0,
        last_item_at: null,
        last_removal_at: null,
      });
    }
    const row = groups.get(name);
    row.items++;
    if (item?.kind === 'comment') row.comments++;
    else row.posts++;
    if (!dated) row.undated++;
    row.score += Number.isFinite(Number(item?.score)) ? Number(item.score) : 0;
    if (dated && (row.last_item_at === null || createdAt > row.last_item_at)) row.last_item_at = createdAt;

    if (REMOVED_STATUSES.has(item?.removal_status)) {
      row.removed++;
      if (SITEWIDE_STATUSES.has(item.removal_status)) row.removed_sitewide++;
      if (item.removal_status === 'removed_by_mod') row.removed_by_mod++;
      const detected = Date.parse(item?.removal_detected_at ?? '');
      const at = Number.isFinite(detected) ? detected : dated ? createdAt : null;
      if (at !== null && (row.last_removal_at === null || at > row.last_removal_at)) row.last_removal_at = at;
    }
  }

  const rows = [...groups.values()].map((row) => ({
    ...row,
    // Null, not 0, when the sample is too small to mean anything: the UI shows
    // "—" rather than a number that invites a conclusion.
    removal_rate: row.items >= MIN_ITEMS_FOR_RATE ? Number((row.removed / row.items).toFixed(4)) : null,
    thin_sample: row.items < MIN_ITEMS_FOR_RATE,
    last_item_at: row.last_item_at === null ? null : new Date(row.last_item_at).toISOString(),
    last_removal_at: row.last_removal_at === null ? null : new Date(row.last_removal_at).toISOString(),
  }));

  rows.sort(
    (a, b) =>
      b.removed - a.removed ||
      (b.removal_rate ?? -1) - (a.removal_rate ?? -1) ||
      b.items - a.items ||
      a.subreddit.localeCompare(b.subreddit),
  );
  return rows;
}

/**
 * The one-line read on a breakdown: how concentrated the removals are.
 *
 * A removal rate tells an owner how much is being removed. This tells them
 * whether it is one community's doing — which is the difference between
 * "read one subreddit's rules" and "this account is in trouble everywhere".
 */
export function concentration(rows) {
  const removed = rows.reduce((sum, row) => sum + row.removed, 0);
  const items = rows.reduce((sum, row) => sum + row.items, 0);
  if (removed === 0) return { removed, items, subreddits: rows.length, worst: null, share: null };
  const worst = rows.find((row) => row.removed > 0) ?? null;
  return {
    removed,
    items,
    subreddits: rows.length,
    worst: worst ? worst.subreddit : null,
    // What share of all removals came from the worst single community.
    share: worst ? Number((worst.removed / removed).toFixed(4)) : null,
  };
}

/**
 * The same grouping across several accounts, for the workspace view: a
 * subreddit removing content from more than one monitored account is a
 * different and more interesting signal than one account's bad week.
 */
export function mergeSubredditSummaries(perAccount) {
  const groups = new Map();
  for (const { account, rows } of perAccount) {
    for (const row of rows) {
      if (!groups.has(row.subreddit)) {
        groups.set(row.subreddit, { subreddit: row.subreddit, items: 0, removed: 0, removed_sitewide: 0, accounts: [] });
      }
      const merged = groups.get(row.subreddit);
      merged.items += row.items;
      merged.removed += row.removed;
      merged.removed_sitewide += row.removed_sitewide;
      merged.accounts.push({ id: account.id, username: account.username, items: row.items, removed: row.removed });
    }
  }
  const rows = [...groups.values()].map((row) => ({
    ...row,
    account_count: row.accounts.length,
    accounts_with_removals: row.accounts.filter((a) => a.removed > 0).length,
    removal_rate: row.items >= MIN_ITEMS_FOR_RATE ? Number((row.removed / row.items).toFixed(4)) : null,
    thin_sample: row.items < MIN_ITEMS_FOR_RATE,
  }));
  rows.sort(
    (a, b) =>
      b.accounts_with_removals - a.accounts_with_removals ||
      b.removed - a.removed ||
      b.items - a.items ||
      a.subreddit.localeCompare(b.subreddit),
  );
  return rows;
}
