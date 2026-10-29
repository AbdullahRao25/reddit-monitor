// Supabase-backed storage. Every query the app makes lives here, so the rest
// of the server only sees plain functions (and tests can swap in a fake).

import { REMOVED_STATUSES } from './content.js';
import { HttpError } from './errors.js';

const UPSERT_CHUNK = 200;
// Supabase caps a response at 1000 rows (its default max-rows), so larger
// reads are paged in steps of exactly that size.
const PAGE = 1000;

function unwrap({ data, error }, action) {
  if (error) {
    if (error.code === '23505') {
      // Unique violations also come from Shield (one active hold per account).
      throw new HttpError(
        409,
        action === 'add account' ? 'That account is already being monitored.' : `Could not ${action}: it already exists.`,
      );
    }
    throw new Error(`Database error while trying to ${action}: ${error.message}`);
  }
  return data;
}

// The vote tables come from their own migration, so name it when it is missing.
function unwrapVotes(response, action) {
  const { error } = response;
  if (error && (['42P01', 'PGRST205'].includes(error.code) || /does not exist|schema cache/i.test(error.message))) {
    throw new HttpError(503, 'Vote tracking needs its table: run supabase/votes.sql in the Supabase SQL editor.');
  }
  return unwrap(response, action);
}

// The gate queue comes from its own migration, so name it when it is missing.
function unwrapGate(response, action) {
  const { error } = response;
  if (error && (['42P01', 'PGRST205'].includes(error.code) || /does not exist|schema cache/i.test(error.message))) {
    throw new HttpError(503, 'The active gate needs its table: run supabase/gate.sql in the Supabase SQL editor.');
  }
  return unwrap(response, action);
}

// Supabase caps every response at PAGE rows, so an export that stops at one
// response would quietly truncate a long history. This pages to the end.
async function readAllRows(query, action, cap = 50_000) {
  const rows = [];
  for (let from = 0; from < cap; from += PAGE) {
    const page = unwrap(await query().range(from, from + PAGE - 1), action);
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

async function readAllPages(query, action) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const page = unwrapVotes(await query().range(from, from + PAGE - 1), action);
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

export function createSupabaseRepo(db) {
  return {
    // Returns null when the database is reachable and set up, else a reason.
    async ping() {
      const { error } = await db.from('accounts').select('id').limit(1);
      if (!error) return null;
      if (['42P01', 'PGRST205'].includes(error.code) || /does not exist|schema cache/i.test(error.message)) {
        return 'Tables not found. Run supabase/schema.sql in the Supabase SQL editor.';
      }
      return error.message;
    },

    async listAccounts() {
      return unwrap(await db.from('accounts').select('*').order('created_at'), 'list accounts');
    },

    async getAccount(id) {
      return unwrap(await db.from('accounts').select('*').eq('id', id).maybeSingle(), 'load account');
    },

    async createAccount(fields) {
      return unwrap(await db.from('accounts').insert(fields).select().single(), 'add account');
    },

    async updateAccount(id, patch) {
      return unwrap(await db.from('accounts').update(patch).eq('id', id).select().single(), 'update account');
    },

    async deleteAccount(id) {
      unwrap(await db.from('accounts').delete().eq('id', id), 'delete account');
    },

    async insertCheck(check) {
      return unwrap(await db.from('health_checks').insert(check).select().single(), 'save check');
    },

    // Newest first.
    async getRecentChecks(accountId, limit) {
      return unwrap(
        await db
          .from('health_checks')
          .select('*')
          .eq('account_id', accountId)
          .order('checked_at', { ascending: false })
          .limit(limit),
        'load checks',
      );
    },

    async getContentItems(accountId, sinceIso) {
      return unwrap(
        await db
          .from('content_items')
          .select('*')
          .eq('account_id', accountId)
          .gte('created_at', sinceIso)
          .order('created_at', { ascending: false })
          .limit(1000),
        'load content',
      );
    },

    async upsertContentItems(rows) {
      for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
        unwrap(
          await db.from('content_items').upsert(rows.slice(i, i + UPSERT_CHUNK), { onConflict: 'id' }),
          'save content',
        );
      }
    },

    async listContent(accountId, { removedOnly = false, limit = 50 } = {}) {
      let query = db.from('content_items').select('*').eq('account_id', accountId);
      query = removedOnly
        ? query
            .in('removal_status', [...REMOVED_STATUSES])
            .order('removal_detected_at', { ascending: false, nullsFirst: false })
        : query.order('created_at', { ascending: false });
      return unwrap(await query.limit(limit), 'load content');
    },

    async getPreventionProfile(accountId) {
      return unwrap(
        await db.from('prevention_profiles').select('*').eq('account_id', accountId).maybeSingle(),
        'load prevention onboarding',
      );
    },

    async upsertPreventionProfile(accountId, patch) {
      // Merge with the current row before upserting. PostgREST upserts can
      // otherwise reset omitted nullable fields to their default values.
      const existing = await this.getPreventionProfile(accountId);
      return unwrap(
        await db.from('prevention_profiles')
          .upsert({ ...(existing ?? {}), ...patch, account_id: accountId, updated_at: new Date().toISOString() }, { onConflict: 'account_id' })
          .select().single(),
        'save prevention onboarding',
      );
    },

    // Account Shield: persistent draft queue, holds, outcomes and audit trail.
    async listShieldDrafts(limit = 150) {
      return unwrap(await db.from('shield_drafts').select('*').order('created_at',{ascending:false}).limit(limit),'list shield drafts');
    },
    async getShieldDraft(id) {
      return unwrap(await db.from('shield_drafts').select('*').eq('id',id).maybeSingle(),'load shield draft');
    },
    async createShieldDraft(fields) {
      return unwrap(await db.from('shield_drafts').insert(fields).select().single(),'create shield draft');
    },
    async updateShieldDraft(id,patch) {
      return unwrap(await db.from('shield_drafts').update(patch).eq('id',id).select().single(),'update shield draft');
    },
    async holdShieldDrafts(accountId) {
      return unwrap(await db.from('shield_drafts').update({state:'held',updated_at:new Date().toISOString()})
        .eq('account_id',accountId).in('state',['review','approved']).select('id'),'hold pending drafts');
    },
    async listShieldHolds(limit = 150) {
      return unwrap(await db.from('shield_holds').select('*').order('created_at',{ascending:false}).limit(limit),'list holds');
    },
    async getShieldHold(id) {
      return unwrap(await db.from('shield_holds').select('*').eq('id',id).maybeSingle(),'load hold');
    },
    async getActiveShieldHold(accountId) {
      return unwrap(await db.from('shield_holds').select('*').eq('account_id',accountId).is('released_at',null).maybeSingle(),'load active hold');
    },
    async createShieldHold(fields) {
      return unwrap(await db.from('shield_holds').insert(fields).select().single(),'create hold');
    },
    async releaseShieldHold(id,reason) {
      return unwrap(await db.from('shield_holds').update({released_at:new Date().toISOString(),released_reason:reason})
        .eq('id',id).is('released_at',null).select().single(),'release hold');
    },
    async listShieldIncidents(limit=100) {
      return unwrap(await db.from('shield_incidents').select('*').order('created_at',{ascending:false}).limit(limit),'load incidents');
    },
    async getShieldIncident(id) {
      return unwrap(await db.from('shield_incidents').select('*').eq('id',id).maybeSingle(),'load incident');
    },
    async createShieldIncident(fields) {
      return unwrap(await db.from('shield_incidents').insert(fields).select().single(),'create incident');
    },
    async updateShieldIncident(id,patch) {
      return unwrap(await db.from('shield_incidents').update(patch).eq('id',id).select().single(),'update incident');
    },
    async insertShieldEvent(fields) {
      return unwrap(await db.from('shield_events').insert(fields).select().single(),'write shield audit event');
    },
    async listShieldEvents(limit=100) {
      return unwrap(await db.from('shield_events').select('*').order('created_at',{ascending:false}).limit(limit),'load shield audit');
    },
    async createShieldOutcome(fields) {
      return unwrap(await db.from('shield_outcomes').insert(fields).select().single(),'record outcome');
    },
    async listShieldOutcomes(draftId) {
      return unwrap(await db.from('shield_outcomes').select('*').eq('draft_id',draftId).order('created_at',{ascending:false}).limit(100),'list outcomes');
    },

    // Prevention Operations: server-only, operator-controlled review queue.
    async listPreventionReviews(accountId) {
      return unwrap(await db.from('prevention_review_queue').select('*').eq('account_id',accountId)
        .order('created_at',{ascending:false}).limit(200),'list prevention reviews');
    },
    async getPreventionReview(id) {
      return unwrap(await db.from('prevention_review_queue').select('*').eq('id',id).maybeSingle(),'load prevention review');
    },
    async createPreventionReview(fields) {
      return unwrap(await db.from('prevention_review_queue').insert(fields).select().single(),'create prevention review');
    },
    async finishPreventionReview(id,state,reason) {
      return unwrap(await db.from('prevention_review_queue').update({state,completion_reason:reason,
        completed_at:new Date().toISOString(),updated_at:new Date().toISOString()})
        .eq('id',id).eq('state','held').select().single(),'complete prevention review');
    },
    async clearPreventionReviews(accountId) {
      unwrap(await db.from('prevention_review_queue').delete().eq('account_id',accountId),'clear prevention reviews');
    },

    async insertAlert(alert) {
      return unwrap(
        await db.from('alerts').insert(alert).select('*, account:accounts(username)').single(),
        'save alert',
      );
    },

    async findOpenAlert(accountId, type, sinceIso) {
      const rows = unwrap(
        await db
          .from('alerts')
          .select('id')
          .eq('account_id', accountId)
          .eq('type', type)
          .is('acknowledged_at', null)
          .gte('created_at', sinceIso)
          .limit(1),
        'look up alerts',
      );
      return rows[0] ?? null;
    },

    // Newest first, each with `account: { username }`.
    async listAlerts({ openOnly = false, accountId = null, limit = 50 } = {}) {
      let query = db.from('alerts').select('*, account:accounts(username)');
      if (openOnly) query = query.is('acknowledged_at', null);
      if (accountId) query = query.eq('account_id', accountId);
      return unwrap(await query.order('created_at', { ascending: false }).limit(limit), 'list alerts');
    },

    // Records that an open alert was re-notified (src/escalation.js). The
    // marker lives in the alert's own details jsonb rather than a column, so
    // this works on a schema nobody has to migrate; the previous details come
    // from the row the caller already read, which keeps it to one round trip.
    async markAlertEscalated(id, previousDetails, atIso) {
      const details = {
        ...(previousDetails ?? {}),
        escalated_at: atIso,
        escalation_count: Number(previousDetails?.escalation_count ?? 0) + 1,
      };
      return unwrap(
        await db.from('alerts').update({ details }).eq('id', id).is('acknowledged_at', null).select().maybeSingle(),
        'mark alert escalated',
      );
    },

    async ackAlert(id) {
      unwrap(
        await db
          .from('alerts')
          .update({ acknowledged_at: new Date().toISOString() })
          .eq('id', id)
          .is('acknowledged_at', null),
        'acknowledge alert',
      );
    },

    async ackAllAlerts() {
      unwrap(
        await db
          .from('alerts')
          .update({ acknowledged_at: new Date().toISOString() })
          .is('acknowledged_at', null),
        'acknowledge alerts',
      );
    },


    // Everything stored about one account, paged to the end (src/export.js).
    async exportAccountHistory(accountId) {
      const [checks, content, alerts] = await Promise.all([
        readAllRows(
          () => db.from('health_checks').select('*').eq('account_id', accountId).order('checked_at', { ascending: false }),
          'export health checks',
        ),
        readAllRows(
          () => db.from('content_items').select('*').eq('account_id', accountId).order('created_at', { ascending: false }),
          'export content items',
        ),
        readAllRows(
          () => db.from('alerts').select('*').eq('account_id', accountId).order('created_at', { ascending: false }),
          'export alerts',
        ),
      ]);
      return { checks, content, alerts };
    },

    // Retention (src/retention.js). Deletes return a count only when asked
    // for one, and a prune that cannot say how much it removed is a prune
    // nobody can check, so every one of these passes { count: 'exact' }.
    async pruneAccountHistory(accountId, { checksBefore, contentBefore }) {
      const checks = await db
        .from('health_checks')
        .delete({ count: 'exact' })
        .eq('account_id', accountId)
        .lt('checked_at', checksBefore);
      unwrap(checks, 'prune health checks');
      const content = await db
        .from('content_items')
        .delete({ count: 'exact' })
        .eq('account_id', accountId)
        .lt('created_at', contentBefore);
      unwrap(content, 'prune content items');
      return { health_checks: checks.count ?? 0, content_items: content.count ?? 0 };
    },

    // The tables that are not per-account, or whose rule is not just age:
    // an open alert is outstanding work and an unreleased gate hold is a
    // pending action, so neither is history yet. The Shield and gate tables
    // come from their own migrations, so a workspace that never ran them
    // reports zero instead of failing the whole pass.
    async pruneGlobalHistory(beforeIso) {
      const counts = { shield_events: 0, alerts: 0, gate_queue: 0 };
      const alerts = await db
        .from('alerts')
        .delete({ count: 'exact' })
        .lt('created_at', beforeIso)
        .not('acknowledged_at', 'is', null);
      unwrap(alerts, 'prune acknowledged alerts');
      counts.alerts = alerts.count ?? 0;
      for (const [table, key, extra] of [
        ['shield_events', 'shield_events', (q) => q],
        ['stealth_gate_queue', 'gate_queue', (q) => q.not('released_at', 'is', null)],
      ]) {
        const response = await extra(db.from(table).delete({ count: 'exact' }).lt('created_at', beforeIso));
        if (response.error) {
          if (['42P01', 'PGRST205'].includes(response.error.code) || /does not exist|schema cache/i.test(response.error.message)) continue;
          unwrap(response, `prune ${table}`);
        }
        counts[key] = response.count ?? 0;
      }
      return counts;
    },

    // Active gate queue (supabase/gate.sql). Held actions are durable so a
    // restart cannot drop them and re-burst them; pacing reads the released
    // rows' timestamps back out as its input.
    async listGateQueue(accountId, limit = 100) {
      return unwrapGate(
        await db
          .from('stealth_gate_queue')
          .select('*')
          .eq('account_id', accountId)
          .order('created_at', { ascending: false })
          .limit(limit),
        'load gate queue',
      );
    },

    async getGateQueue(id) {
      return unwrapGate(
        await db.from('stealth_gate_queue').select('*').eq('id', id).maybeSingle(),
        'load gate queue row',
      );
    },

    async createGateQueue(fields) {
      return unwrapGate(
        await db.from('stealth_gate_queue').insert(fields).select().single(),
        'queue a gated action',
      );
    },

    // Releases an unreleased row only: the .is() guard makes a double release
    // return no rows (and so throw) instead of re-stamping a released one and
    // handing the pacing budget a second slot.
    async releaseGateQueue(id, releasedReason) {
      return unwrapGate(
        await db
          .from('stealth_gate_queue')
          .update({ released_at: new Date().toISOString(), released_reason: releasedReason })
          .eq('id', id)
          .is('released_at', null)
          .select()
          .single(),
        'release a gated action',
      );
    },

    async clearGateQueue(accountId) {
      unwrapGate(await db.from('stealth_gate_queue').delete().eq('account_id', accountId), 'clear gate queue');
    },

    // Vote history (supabase/votes.sql). An import is the account's complete
    // current set of votes of one kind: rows it contains are upserted and
    // stamped with importedAt, rows of that kind it no longer contains (the
    // vote was taken back) are deleted. first_seen_at is left out of the
    // upsert so it keeps the time of the first import that saw the vote.
    async replaceAccountVotes(accountId, kind, rows, importedAt) {
      for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
        unwrapVotes(
          await db.from('account_votes').upsert(
            rows.slice(i, i + UPSERT_CHUNK).map((row) => ({ ...row, account_id: accountId, updated_at: importedAt })),
            { onConflict: 'account_id,item_id' },
          ),
          'save votes',
        );
      }
      const removed = unwrapVotes(
        await db
          .from('account_votes')
          .delete()
          .eq('account_id', accountId)
          .eq('kind', kind)
          .lt('updated_at', importedAt)
          .select('item_id'),
        'remove withdrawn votes',
      );
      return { removed: removed.length };
    },

    async listAccountVotes(accountId) {
      return readAllPages(
        () => db.from('account_votes').select('*').eq('account_id', accountId).order('item_id'),
        'load votes',
      );
    },

    // Votes on items more than one account voted on (a view in votes.sql).
    async listSharedVotes() {
      return readAllPages(
        () => db.from('shared_account_votes').select('*').order('item_id').order('account_id'),
        'load shared votes',
      );
    },

    async clearAccountVotes(accountId) {
      unwrapVotes(await db.from('account_votes').delete().eq('account_id', accountId), 'clear votes');
    },
  };
}
