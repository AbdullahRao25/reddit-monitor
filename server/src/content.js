// Normalizing Reddit posts/comments and classifying whether they were removed.

// Statuses that mean "other people can't see this", grouped by who removed it.
export const REMOVED_STATUSES = new Set(['removed_by_mod', 'spam_filtered', 'removed_by_admin', 'removed']);
// Removed by Reddit itself rather than by a subreddit's moderators. These are
// the removals that typically precede a shadowban.
export const SITEWIDE_STATUSES = new Set(['spam_filtered', 'removed_by_admin']);

// Values Reddit puts in `removed_by_category`.
const AUTHOR_CATEGORIES = new Set(['author', 'deleted']);
const MODERATOR_CATEGORIES = new Set(['moderator', 'automod_filtered']);
const SPAM_FILTER_CATEGORIES = new Set(['reddit', 'spam_filtered']);
const ADMIN_CATEGORIES = new Set([
  'anti_evil_ops',
  'content_takedown',
  'copyright_takedown',
  'community_ops',
  'legal_operations',
]);

// Hosts that are Reddit's own media, not a site being promoted.
const NON_PROMOTIONAL_HOSTS = new Set([
  'reddit.com',
  'old.reddit.com',
  'new.reddit.com',
  'i.redd.it',
  'v.redd.it',
  'preview.redd.it',
  'imgur.com',
  'i.imgur.com',
]);

export const isPost = (fullname) => fullname?.startsWith('t3_');

// raw: a post or comment object as returned by the Reddit API.
export function classifyRemoval(raw) {
  const category = raw.removed_by_category ?? null;
  if (category) {
    if (AUTHOR_CATEGORIES.has(category)) return 'deleted_by_author';
    if (SPAM_FILTER_CATEGORIES.has(category)) return 'spam_filtered';
    if (ADMIN_CATEGORIES.has(category)) return 'removed_by_admin';
    if (MODERATOR_CATEGORIES.has(category)) return 'removed_by_mod';
    return 'removed';
  }

  // Comments carry no removal category for outside viewers; a removed one
  // just has its body replaced. That can't tell mods and spam filter apart.
  const text = isPost(raw.name) ? raw.selftext : raw.body;
  if (text === '[removed]') return 'removed';
  if (text === '[deleted]' || raw.author === '[deleted]') return 'deleted_by_author';
  return 'visible';
}

export function normalizeDomain(domain) {
  if (!domain) return null;
  const host = domain.toLowerCase().replace(/^www\./, '');
  if (host.startsWith('self.') || NON_PROMOTIONAL_HOSTS.has(host)) return null;
  return host;
}

export const isPlaceholderText = (text) => text === '[removed]' || text === '[deleted]';

function excerpt(text, max = 280) {
  if (!text) return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// Unix seconds -> ISO string, or null when the source had no usable time.
// Never 0: new Date(null * 1000) stored 1970-01-01, which silently dropped the
// item from every 30-day count. Callers decide what to do with a null.
const createdIso = (utc) => (Number.isFinite(utc) && utc > 0 ? new Date(utc * 1000).toISOString() : null);

// Map a raw API object to a content_items row (without removal fields).
// created_at is null when the item has no readable timestamp.
export function toContentItem(raw, accountId) {
  const post = isPost(raw.name);
  const domain = post && !raw.is_self ? normalizeDomain(raw.domain) : null;
  return {
    id: raw.name,
    account_id: accountId,
    kind: post ? 'post' : 'comment',
    subreddit: raw.subreddit ?? null,
    permalink: raw.permalink ? `https://www.reddit.com${raw.permalink}` : null,
    title: post ? (raw.title ?? null) : (raw.link_title ?? null),
    excerpt: excerpt(post ? raw.selftext : raw.body),
    url_domain: domain,
    link_url: domain ? (raw.url ?? null) : null,
    score: typeof raw.score === 'number' ? raw.score : null,
    created_at: createdIso(raw.created_utc),
  };
}
