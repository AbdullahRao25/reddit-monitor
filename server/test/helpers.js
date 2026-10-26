// Test doubles: an in-memory repo with the same interface as db.js, and a
// scriptable fake of the Reddit client.

import { randomUUID } from 'node:crypto';
import { REMOVED_STATUSES } from '../src/content.js';
import { HttpError } from '../src/errors.js';

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
export const NOW = Date.parse('2026-10-19T12:00:00Z');

export const silentLog = { log() {}, warn() {}, error() {} };

export function createMemoryRepo({ now = () => Date.now() } = {}) {
  const iso = () => new Date(now()).toISOString();
  const accounts = new Map();
  const checks = [];
  const content = new Map();
  const alerts = [];
  const warmupLog = new Map();
  const preventionProfiles = new Map();
  const preventionReviews=new Map();
  const votes = new Map(); // `${account_id}|${item_id}` -> account_votes row
  const shieldDrafts=new Map(),shieldHolds=new Map(),shieldEvents=[],shieldOutcomes=[],shieldIncidents=new Map();
  const withAccount = (alert) => ({ ...alert, account: { username: accounts.get(alert.account_id)?.username } });
  const newestFirst = (key) => (a, b) => String(b[key]).localeCompare(String(a[key]));

  return {
    accounts,
    checks,
    content,
    alerts,
    warmupLog,
    preventionProfiles,
    votes,

    shieldDrafts,shieldHolds,shieldEvents,shieldOutcomes,shieldIncidents,
    async listShieldDrafts(limit=150) {return [...shieldDrafts.values()].sort(newestFirst('created_at')).slice(0,limit);},
    async getShieldDraft(id) {return shieldDrafts.get(id)??null;},
    async createShieldDraft(fields) {const row={...fields,id:randomUUID(),created_at:iso(),updated_at:iso()};shieldDrafts.set(row.id,row);return {...row};},
    async updateShieldDraft(id,patch) {const row={...shieldDrafts.get(id),...patch};shieldDrafts.set(id,row);return {...row};},
    async holdShieldDrafts(accountId) {const held=[];for(const [id,d] of shieldDrafts)if(d.account_id===accountId&&['review','approved'].includes(d.state)){shieldDrafts.set(id,{...d,state:'held'});held.push({id});}return held;},
    async listShieldHolds(limit=150) {return [...shieldHolds.values()].sort(newestFirst('created_at')).slice(0,limit);},
    async getShieldHold(id) {return shieldHolds.get(id)??null;},
    async getActiveShieldHold(accountId) {return [...shieldHolds.values()].find(h=>h.account_id===accountId&&!h.released_at)??null;},
    async createShieldHold(fields) {const row={...fields,id:randomUUID(),created_at:iso(),released_at:null};shieldHolds.set(row.id,row);return {...row};},
    async releaseShieldHold(id,reason) {const hold=shieldHolds.get(id);if(!hold||hold.released_at)throw new Error('Database error while trying to release hold: no rows returned');const row={...hold,released_at:iso(),released_reason:reason};shieldHolds.set(id,row);return {...row};},
    async listShieldIncidents(limit=100) {return [...shieldIncidents.values()].sort(newestFirst('created_at')).slice(0,limit);},
    async getShieldIncident(id) {return shieldIncidents.get(id)??null;},
    async createShieldIncident(fields) {const row={...fields,id:randomUUID(),created_at:iso(),updated_at:iso(),status:fields.status??'open'};shieldIncidents.set(row.id,row);return {...row};},
    async updateShieldIncident(id,patch) {const row={...shieldIncidents.get(id),...patch};shieldIncidents.set(id,row);return {...row};},
    async insertShieldEvent(fields) {const row={id:randomUUID(),created_at:iso(),...fields};shieldEvents.push(row);return row;},
    async listShieldEvents(limit=100) {return [...shieldEvents].sort(newestFirst('created_at')).slice(0,limit);},
    async createShieldOutcome(fields) {const row={id:randomUUID(),created_at:iso(),...fields};shieldOutcomes.push(row);return {...row};},
    async listShieldOutcomes(draftId) {return shieldOutcomes.filter(o=>o.draft_id===draftId).sort(newestFirst('created_at'));},
    // Mirror of db.js prevention_review_queue methods.
    preventionReviews,
    async listPreventionReviews(accountId) {return [...preventionReviews.values()].filter(r=>r.account_id===accountId).sort(newestFirst('created_at'));},
    async getPreventionReview(id) {return preventionReviews.get(id)??null;},
    async createPreventionReview(fields) {const row={...fields,id:randomUUID(),created_at:iso(),updated_at:iso(),completed_at:null,completion_reason:null};preventionReviews.set(row.id,row);return {...row};},
    async finishPreventionReview(id,state,reason) {const previous=preventionReviews.get(id);if(!previous||previous.state!=='held')throw new Error('Review no longer held.');const row={...previous,state,completion_reason:reason,completed_at:iso(),updated_at:iso()};preventionReviews.set(id,row);return {...row};},
    async clearPreventionReviews(accountId) {for(const [id,row] of preventionReviews)if(row.account_id===accountId)preventionReviews.delete(id);},
    async ping() {
      return null;
    },
    async listAccounts() {
      return [...accounts.values()].map((row) => ({ ...row }));
    },
    async getAccount(id) {
      return accounts.has(id) ? { ...accounts.get(id) } : null;
    },
    async createAccount(fields) {
      const taken = [...accounts.values()].some(
        (row) => row.username.toLowerCase() === fields.username.toLowerCase(),
      );
      if (taken) throw new HttpError(409, 'That account is already being monitored.');
      const row = {
        id: randomUUID(),
        label: null,
        notes: null,
        paused: false,
        status: 'pending',
        risk_score: null,
        risk_level: null,
        link_karma: null,
        comment_karma: null,
        last_checked_at: null,
        last_seen_active_at: null,
        stealth_mode: false,
        fingerprint: null,
        early_risk_level: null,
        created_at: iso(),
        ...fields,
      };
      accounts.set(row.id, row);
      return { ...row };
    },
    async updateAccount(id, patch) {
      // Like Supabase's .single(): updating a deleted account fails instead of
      // re-creating it as a row without a username.
      if (!accounts.has(id)) throw new Error('Database error while trying to update account: no rows returned');
      const row = { ...accounts.get(id), ...patch };
      accounts.set(id, row);
      return { ...row };
    },
    // Mirrors the schema's `on delete cascade`.
    async deleteAccount(id) {
      accounts.delete(id);
      preventionProfiles.delete(id);
      for(const [reviewId,review] of preventionReviews)if(review.account_id===id)preventionReviews.delete(reviewId);
      const owned = (row) => row.account_id === id;
      for (const list of [checks, alerts, shieldEvents, shieldOutcomes]) {
        for (let i = list.length - 1; i >= 0; i--) if (owned(list[i])) list.splice(i, 1);
      }
      for (const map of [content, warmupLog, votes, shieldDrafts, shieldHolds, shieldIncidents]) {
        for (const [key, row] of map) if (owned(row)) map.delete(key);
      }
    },
    async insertCheck(check) {
      const row = { id: randomUUID(), ...check };
      checks.push(row);
      return { ...row };
    },
    async getRecentChecks(accountId, limit) {
      return checks
        .filter((row) => row.account_id === accountId)
        .sort(newestFirst('checked_at'))
        .slice(0, limit);
    },
    async getContentItems(accountId, sinceIso) {
      return [...content.values()].filter(
        (row) => row.account_id === accountId && row.created_at >= sinceIso,
      );
    },
    async upsertContentItems(rows) {
      for (const row of rows) {
        content.set(row.id, { first_seen_at: iso(), ...content.get(row.id), ...row });
      }
    },
    async listContent(accountId, { removedOnly = false, limit = 50 } = {}) {
      return [...content.values()]
        .filter((row) => row.account_id === accountId)
        .filter((row) => !removedOnly || REMOVED_STATUSES.has(row.removal_status))
        .sort(newestFirst(removedOnly ? 'removal_detected_at' : 'created_at'))
        .slice(0, limit);
    },
    async getPreventionProfile(accountId) {
      return preventionProfiles.get(accountId) ?? null;
    },
    async upsertPreventionProfile(accountId, patch) {
      const row = { ...preventionProfiles.get(accountId), account_id: accountId, ...patch, updated_at: iso() };
      preventionProfiles.set(accountId, row);
      return row;
    },
    async insertAlert(alert) {
      const row = { id: randomUUID(), created_at: iso(), acknowledged_at: null, details: {}, ...alert };
      alerts.push(row);
      return withAccount(row);
    },
    async findOpenAlert(accountId, type, sinceIso) {
      return (
        alerts.find(
          (row) =>
            row.account_id === accountId &&
            row.type === type &&
            !row.acknowledged_at &&
            row.created_at >= sinceIso,
        ) ?? null
      );
    },
    async listAlerts({ openOnly = false, accountId = null, limit = 50 } = {}) {
      return alerts
        .filter((row) => !openOnly || !row.acknowledged_at)
        .filter((row) => !accountId || row.account_id === accountId)
        .sort(newestFirst('created_at'))
        .slice(0, limit)
        .map(withAccount);
    },
    async ackAlert(id) {
      const row = alerts.find((alert) => alert.id === id);
      if (row && !row.acknowledged_at) row.acknowledged_at = iso();
    },
    async ackAllAlerts() {
      for (const row of alerts) if (!row.acknowledged_at) row.acknowledged_at = iso();
    },
    async getWarmupLog(accountId, limit = 20) {
      return [...warmupLog.values()]
        .filter((row) => row.account_id === accountId)
        .sort(newestFirst('performed_at'))
        .slice(0, limit);
    },
    async insertWarmupLog(accountId, action) {
      const row = { id: randomUUID(), account_id: accountId, action, performed_at: iso() };
      warmupLog.set(row.id, row);
      return { ...row };
    },
    async clearWarmupLog(accountId) {
      for (const [key, row] of warmupLog) if (row.account_id === accountId) warmupLog.delete(key);
    },
    async replaceAccountVotes(accountId, kind, rows, importedAt) {
      for (const row of rows) {
        const key = `${accountId}|${row.item_id}`;
        votes.set(key, { first_seen_at: importedAt, ...votes.get(key), ...row, account_id: accountId, updated_at: importedAt });
      }
      let removed = 0;
      for (const [key, row] of votes) {
        if (row.account_id === accountId && row.kind === kind && row.updated_at < importedAt) {
          votes.delete(key);
          removed++;
        }
      }
      return { removed };
    },
    async listAccountVotes(accountId) {
      return [...votes.values()].filter((row) => row.account_id === accountId).map((row) => ({ ...row }));
    },
    async listSharedVotes() {
      const voters = new Map();
      for (const row of votes.values()) voters.set(row.item_id, (voters.get(row.item_id) ?? 0) + 1);
      return [...votes.values()].filter((row) => voters.get(row.item_id) > 1).map((row) => ({ ...row }));
    },
    async clearAccountVotes(accountId) {
      for (const [key, row] of votes) if (row.account_id === accountId) votes.delete(key);
    },
  };
}

export const healthyProfile = (now = NOW) => ({
  name: 'tester',
  linkKarma: 800,
  commentKarma: 2400,
  createdAt: now - 400 * DAY,
  hasVerifiedEmail: true,
});

// state.about / posts / comments drive the responses; state.info overrides
// what /api/info returns for a fullname (to simulate later removals).
export function createFakeReddit() {
  const state = {
    about: { state: 'active', profile: healthyProfile() },
    posts: [],
    comments: [],
    info: new Map(),
    fail: null,
  };
  return {
    state,
    async getUserAbout() {
      if (state.fail) throw new Error(state.fail);
      return state.about;
    },
    async getUserListing(username, which) {
      return which === 'submitted' ? state.posts : state.comments;
    },
    async getInfo(ids) {
      // A null listing is one that isn't public (404, or hidden by its owner).
      const listed = new Map([...(state.posts ?? []), ...(state.comments ?? [])].map((raw) => [raw.name, raw]));
      return ids.map((id) => state.info.get(id) ?? listed.get(id)).filter(Boolean);
    },
    async verify() {},
  };
}

export function rawPost({
  id,
  subreddit = 'test',
  createdAt = NOW - DAY,
  url = null,
  title = 'A post',
  selftext = '',
  removedBy = null,
  score = 5,
}) {
  const domain = url ? new URL(url).hostname : `self.${subreddit}`;
  return {
    name: `t3_${id}`,
    subreddit,
    created_utc: createdAt / 1000,
    is_self: !url,
    domain,
    url: url ?? `https://www.reddit.com/r/${subreddit}/comments/${id}/a_post/`,
    title,
    selftext,
    removed_by_category: removedBy,
    score,
    permalink: `/r/${subreddit}/comments/${id}/a_post/`,
  };
}

export function rawComment({ id, subreddit = 'test', createdAt = NOW - DAY, body = 'A comment', score = 1 }) {
  return {
    name: `t1_${id}`,
    subreddit,
    created_utc: createdAt / 1000,
    body,
    score,
    link_title: 'Some thread',
    permalink: `/r/${subreddit}/comments/abc/some_thread/${id}/`,
  };
}
