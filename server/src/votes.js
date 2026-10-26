// Vote history imported from an account's Reddit data export.
//
// Reddit never publishes what an account voted on: /user/<name>/upvoted is
// readable only by the account itself, so the public-view checks can't see
// it. The sanctioned way to get it without storing a login is the account
// owner's data download (reddit.com/settings/data-request), whose
// post_votes.csv and comment_votes.csv list every current vote as
// `id, permalink, direction`. This module parses those files and summarises
// them; it never contacts Reddit.

export const VOTE_KINDS = new Set(['post', 'comment']);
const DIRECTIONS = new Set(['up', 'down']);
const PREFIX = { post: 't3', comment: 't1' };

// RFC 4180 CSV: quoted fields may contain commas, doubled quotes and newlines.
// Returns every record, blank ones included, as arrays of strings.
export function parseCsv(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (src[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// "https://www.reddit.com/r/pics/comments/abc123/a_title/def456/" ->
// { subreddit: 'pics', postId: 'abc123', commentId: 'def456', slug: 'a_title', url }.
// Posts on a user profile get Reddit's own "u_<name>" community name.
export function parsePermalink(value) {
  if (!value) return null;
  let url;
  try {
    url = new URL(String(value).trim(), 'https://www.reddit.com');
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host === 'redd.it' || host === 'www.redd.it') {
    const m = url.pathname.match(/^\/([a-z0-9]+)\/?$/i);
    if (!m) return null;
    return { subreddit: null, postId: m[1].toLowerCase(), commentId: null,
      slug: null, url: `https://www.reddit.com/comments/${m[1].toLowerCase()}/` };
  }
  if (!/(^|\.)reddit\.com$/i.test(host)) return null;
  const path = url.pathname;
  const scoped = path.match(
    /^\/(r|u|user)\/([^/]+)\/comments\/([a-z0-9]+)(?:\/([^/]*))?(?:\/([a-z0-9]+))?\/?$/i,
  );
  const short = path.match(/^\/comments\/([a-z0-9]+)(?:\/([^/]*))?(?:\/([a-z0-9]+))?\/?$/i);
  if (!scoped && !short) return null;
  const scope = scoped?.[1];
  const name = scoped?.[2];
  const postId = (scoped ? scoped[3] : short[1]).toLowerCase();
  const slug = scoped ? scoped[4] : short[2];
  const commentId = scoped ? scoped[5] : short[3];
  return {
    subreddit: scoped ? (scope.toLowerCase() === 'r' ? name : `u_${name}`) : null,
    postId,
    commentId: commentId?.toLowerCase() ?? null,
    slug: slug && !['comment', '_'].includes(slug.toLowerCase()) ? slug : null,
    url: `https://www.reddit.com${url.pathname}`,
  };
}

// "t3_abc123" or a bare "abc123" -> "t3_abc123"; null for an id of the other kind.
function fullname(raw, kind) {
  const m = String(raw ?? '').trim().toLowerCase().match(/^(?:(t[13])_)?([a-z0-9]+)$/);
  if (!m || (m[1] && m[1] !== PREFIX[kind])) return null;
  return `${PREFIX[kind]}_${m[2]}`;
}

// The export has no titles. The permalink's slug is the post title, lowercased
// and cut short by Reddit, which is still enough to recognise the post.
function titleFromSlug(slug) {
  if (!slug) return null;
  let text = slug;
  try {
    text = decodeURIComponent(slug);
  } catch {
    // A malformed %-escape: keep the slug as it is.
  }
  return text.replace(/_+/g, ' ').trim() || null;
}

/**
 * Parse one vote file from the export. kind: 'post' for post_votes.csv,
 * 'comment' for comment_votes.csv. Returns { votes, skipped, error }:
 * skipped counts unusable rows by reason; error is set when the file isn't a
 * vote export at all.
 */
export function parseVoteCsv(text, kind) {
  const rows = parseCsv(text).filter((cells) => cells.some((cell) => cell.trim() !== ''));
  if (rows.length === 0) return { votes: [], skipped: {}, error: 'The file is empty.' };

  const header = rows[0].map((name) => name.trim().toLowerCase());
  const idCol = header.indexOf('id');
  const linkCol = header.indexOf('permalink');
  const dirCol = header.indexOf('direction');
  if (dirCol === -1 || (idCol === -1 && linkCol === -1)) {
    return {
      votes: [],
      skipped: {},
      error:
        "This doesn't look like a vote file from Reddit's data export: expected the columns " +
        `id, permalink and direction, found ${rows[0].map((name) => name.trim()).join(', ') || 'none'}.`,
    };
  }

  const votes = new Map();
  const skipped = {};
  const skip = (reason) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };
  for (const cells of rows.slice(1)) {
    const direction = (cells[dirCol] ?? '').trim().toLowerCase();
    if (!DIRECTIONS.has(direction)) {
      skip(direction ? `not an up or down vote ("${direction}")` : 'no vote direction');
      continue;
    }
    const link = linkCol === -1 ? null : parsePermalink(cells[linkCol]);
    const rawId = idCol === -1 ? null : fullname(cells[idCol], kind);
    // A small number of legacy Reddit comment links end in /<comment-id>/
    // without the usual /<post-title>/<comment-id>/ pair. The export supplies
    // the actual comment ID: only recognize this shape when it agrees exactly.
    if (link && kind === 'comment' && !link.commentId && rawId &&
        link.slug?.toLowerCase() === rawId.slice(3)) {
      link.commentId = rawId.slice(3);
      link.slug = null;
    }
    if (link && Boolean(link.commentId) !== (kind === 'comment')) {
      skip(kind === 'post' ? 'a comment link in the post-votes file' : 'a post link in the comment-votes file');
      continue;
    }
    const permalinkId = link && fullname(kind === 'post' ? link.postId : link.commentId, kind);
    // Never silently associate the vote with the wrong content when the
    // export's ID and permalink disagree.
    if (rawId && permalinkId && rawId !== permalinkId) {
      skip('the vote id does not match its Reddit link');
      continue;
    }
    const itemId = rawId ?? permalinkId;
    if (!itemId) {
      skip('no readable id or permalink');
      continue;
    }
    // A repeated id keeps the last row, like the export's own ordering would.
    votes.set(itemId, {
      item_id: itemId,
      kind,
      direction,
      subreddit: link?.subreddit ?? null,
      permalink: link?.url ?? null,
      title: titleFromSlug(link?.slug),
    });
  }
  return { votes: [...votes.values()], skipped, error: null };
}

export function summarizeVotes(votes) {
  const summary = { total: votes.length, up: 0, down: 0, posts: 0, comments: 0, by_subreddit: [] };
  const bySubreddit = new Map();
  for (const vote of votes) {
    summary[vote.direction]++;
    summary[vote.kind === 'post' ? 'posts' : 'comments']++;
    if (!vote.subreddit) continue;
    const entry = bySubreddit.get(vote.subreddit) ?? { name: vote.subreddit, up: 0, down: 0 };
    entry[vote.direction]++;
    bySubreddit.set(vote.subreddit, entry);
  }
  summary.by_subreddit = [...bySubreddit.values()]
    .sort((a, b) => b.up + b.down - (a.up + a.down) || a.name.localeCompare(b.name))
    .slice(0, 10);
  return summary;
}

// The export has no vote times. Order by the import that first saw a vote,
// then by item: base36 ids only grow, so within one kind a longer or larger
// id is a newer post/comment.
export function voteOrder(a, b) {
  if (a.first_seen_at !== b.first_seen_at) return String(b.first_seen_at).localeCompare(String(a.first_seen_at));
  if (a.kind !== b.kind) return a.kind === 'post' ? -1 : 1;
  const x = a.item_id.slice(3);
  const y = b.item_id.slice(3);
  return y.length - x.length || (y > x ? 1 : y < x ? -1 : 0);
}

/**
 * Items this account voted on that other monitored accounts voted on too.
 * Reddit treats votes on the same content from several accounts one person
 * controls as vote manipulation, a common reason for accounts being banned
 * together, so the dashboard flags every overlap.
 *
 * rows: account_votes rows whose item has votes from more than one account.
 * usernames: Map of account id -> username.
 */
export function sharedVotesFor(accountId, rows, usernames) {
  const byItem = new Map();
  for (const row of rows) {
    if (!byItem.has(row.item_id)) byItem.set(row.item_id, []);
    byItem.get(row.item_id).push(row);
  }
  const shared = [];
  for (const [itemId, voters] of byItem) {
    const own = voters.find((row) => row.account_id === accountId);
    const others = voters.filter((row) => row.account_id !== accountId);
    if (!own || others.length === 0) continue;
    shared.push({
      item_id: itemId,
      kind: own.kind,
      subreddit: own.subreddit,
      permalink: own.permalink,
      title: own.title,
      direction: own.direction,
      others: others.map((row) => ({
        account_id: row.account_id,
        username: usernames.get(row.account_id) ?? null,
        direction: row.direction,
      })),
    });
  }
  return shared.sort((a, b) => b.others.length - a.others.length || voteOrder(a, b));
}
