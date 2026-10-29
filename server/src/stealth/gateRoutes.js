// Routes for the active gate. stealth/gate.js decides; these own the
// persistence, following the same shape as shield/routes.js and
// prevention/routes.js: one register function, its own dependencies, and no
// knowledge of the rest of the API.
//
// A hold becomes a durable stealth_gate_queue row (a restart must not drop it
// and re-burst the whole queue at once), a pass is audited and gone, and the
// timestamps of released rows are the pacing input for the next decision.

import { HttpError } from '../errors.js';
import { interventionFor } from '../shield/policy.js';
import { accountRequirer, cleanText, isPlainObject, UUID_RE } from '../routeGuards.js';
import { gateDecision } from './gate.js';

export function registerGateRoutes(app, { repo, log = console }) {
  const requireAccount = accountRequirer(repo);

  // Every gate decision is audited, but the Shield migration is separate from
  // this one: a workspace that never ran shield.sql must still get a gate, so
  // a missing audit sink is skipped rather than failing the decision (the same
  // defensive shape checker.js uses for shield holds).
  async function auditGate(accountId, eventType, details) {
    if (typeof repo.insertShieldEvent !== 'function') return;
    try {
      await repo.insertShieldEvent({ account_id: accountId, draft_id: null, event_type: eventType, details });
    } catch (err) {
      log.warn(`Gate audit event ${eventType} not recorded: ${err.message}`);
    }
  }

  // The account's released gate actions, newest window first: what pacing reads.
  async function gateReleases(accountId) {
    const rows = await repo.listGateQueue(accountId, 50);
    return rows
      .filter((row) => row.released_at)
      .map((row) => Date.parse(row.released_at))
      .filter((t) => Number.isFinite(t));
  }

  // Overview for the gate panel. A read decides nothing, so verdict is null:
  // asking for a verdict means POSTing an action.
  app.get('/api/accounts/:id/stealth/gate', async (req, res) => {
    const account = await requireAccount(req.params.id);
    res.json({
      account_id: account.id,
      stealth_mode: account.stealth_mode,
      verdict: null,
      queue: await repo.listGateQueue(account.id, 25),
    });
  });

  // The gate call: may this action go out right now?
  app.post('/api/accounts/:id/stealth/gate', async (req, res) => {
    const account = await requireAccount(req.params.id);
    if (!account.stealth_mode) throw new HttpError(400, 'Stealth mode is not enabled for this account.');
    const body = req.body ?? {};
    const action = String(body.action ?? '').trim().slice(0, 60);
    if (!action) throw new HttpError(400, 'Name the action the gate should decide on.');
    const payload = body.payload ?? null;
    if (payload !== null && !isPlainObject(payload)) throw new HttpError(400, 'Payload must be an object or null.');

    const checks = await repo.getRecentChecks(account.id, 5);
    // Two different checks matter here. The cool-down stage needs the latest
    // check that actually saw the account, because only a successful check
    // carries newly_removed. The danger verdict needs the newest check of any
    // kind plus the run of failures behind it: interventionFor() only reaches
    // its "three consecutive monitoring failures" branch on an error row, so
    // handing it the newest *successful* check would make the gate's review
    // soft-hold unreachable.
    const check = checks.find((row) => !row.error) ?? null;
    let consecutiveErrors = 0;
    for (const previous of checks) {
      if (!previous.error) break;
      consecutiveErrors++;
    }
    const intervention = interventionFor({ check: checks[0] ?? null, account, consecutiveErrors });
    const releases = await gateReleases(account.id);
    const decision = gateDecision({ account, check, intervention, releases, now: Date.now() });

    // Block: fail closed. No queue row and no token — there is nothing to
    // release, because the account needs a person to look at it.
    if (decision.verdict === 'block') {
      await auditGate(account.id, 'gate_blocked', { action, reasons: decision.reasons, intervention: decision.intervention });
      return res.json({
        verdict: 'block',
        reasons: decision.reasons,
        next_safe_at: null,
        intervention: decision.intervention,
      });
    }

    // Hold: fail open. Nothing is wrong, it is just not the moment, so the
    // action is queued with the time it could go out.
    if (decision.verdict === 'hold') {
      const row = await repo.createGateQueue({
        account_id: account.id,
        action,
        payload,
        verdict: 'hold',
        reasons: decision.reasons,
        next_safe_at: decision.next_safe_at ? new Date(decision.next_safe_at).toISOString() : null,
        token: decision.token,
      });
      await auditGate(account.id, 'gate_held', { action, queue_id: row.id, next_safe_at: row.next_safe_at });
      return res.json({
        verdict: 'hold',
        reasons: decision.reasons,
        next_safe_at: decision.next_safe_at,
        token: decision.token,
        queued: row.id,
      });
    }

    await auditGate(account.id, 'gate_passed', { action, token: decision.token });
    res.json({
      verdict: 'pass',
      reasons: decision.reasons,
      next_safe_at: decision.next_safe_at,
      token: decision.token,
      intervention: decision.intervention,
    });
  });

  // List the queue. open=1 returns only the rows still waiting.
  app.get('/api/accounts/:id/stealth/gate/queue', async (req, res) => {
    const account = await requireAccount(req.params.id);
    const rows = await repo.listGateQueue(account.id, 100);
    const open = req.query.open === '1' || req.query.open === 'true';
    res.json({ queue: open ? rows.filter((row) => !row.released_at) : rows, open });
  });

  // Release one held action. The path parameter is the queue row's id — the
  // `queued` value the hold response carried.
  app.post('/api/accounts/:id/stealth/gate/:tokenId', async (req, res) => {
    const account = await requireAccount(req.params.id);
    const { tokenId } = req.params;
    const row = UUID_RE.test(tokenId) ? await repo.getGateQueue(tokenId) : null;
    if (!row || row.account_id !== account.id) throw new HttpError(404, 'Queued action not found');
    if (row.released_at) throw new HttpError(409, 'That action was already released.');
    const reason = cleanText(req.body?.reason, 200) ?? 'released by operator';
    const released = await repo.releaseGateQueue(tokenId, reason);
    await auditGate(account.id, 'gate_released', { token: tokenId, action: row.action, reason });
    res.json({ queued: released });
  });
}
