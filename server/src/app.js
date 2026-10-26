import path from 'node:path';
import express from 'express';
import { checkLiveProfile } from './checker.js';
import { HttpError } from './errors.js';
import { fingerprintFields, validateFingerprint, suggestFingerprint } from './stealth/fingerprint.js';
import { createWarmupPlan, warmupProgress } from './stealth/warmup.js';
import { analyzeActivity, assessReadiness, scanDraft } from './preventer/engine.js';
import { registerShieldRoutes } from './shield/routes.js';
import { registerPreventionOperationsRoutes } from './prevention/routes.js';
import { VOTE_KINDS, parseVoteCsv, sharedVotesFor, summarizeVotes, voteOrder } from './votes.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;

// Accepts "name", "u/name", "/u/name" or a profile URL.
export function normalizeUsername(input) {
  return String(input ?? '')
    .trim()
    .replace(/^https?:\/\/(?:[a-z]+\.)?reddit\.com/i, '')
    .replace(/^\/?(?:u|user)\//i, '')
    .replace(/[/?#].*$/, '');
}

function cleanText(value, max) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

/**
 * deps: { repo, reddit, checker, scheduler } - or, when the server isn't
 * configured yet, just { missing: [...env var names] }, in which case only
 * /api/status works and reports what to fill in.
 */
export function createApp({
  repo,
  reddit,
  checker,
  scheduler,
  missing = [],
  clientDist = null,
  // Gate for /api: defaults to open so local dev and the test suite need no
  // auth; a real deployment passes the middleware from createAuth().
  auth = (req, res, next) => next(),
  // Browser origins allowed to call the API cross-origin (the Netlify site).
  corsOrigins = [],
  log = console,
}) {
  const app = express();
  app.disable('x-powered-by');

  // Cross-origin access for the dashboard's own domain(s), with the auth
  // header. Other origins get no CORS headers and are blocked by the browser.
  if (corsOrigins.length > 0) {
    const allowed = new Set(corsOrigins);
    const any = allowed.has('*');
    app.use('/api', (req, res, next) => {
      const origin = req.get('origin');
      if (origin && (any || allowed.has(origin))) {
        res.set('Access-Control-Allow-Origin', any ? '*' : origin);
        res.set('Vary', 'Origin');
        res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Authorization,Content-Type');
        res.set('Access-Control-Max-Age', '86400');
      }
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });
  }

  // Unauthenticated health check for the host's and Netlify's uptime probes.
  // It reveals nothing and does not touch the database.
  app.get('/api/health', (req, res) => res.json({ ok: true, service: 'reddit-monitor' }));

  app.use(express.json({ limit: '100kb' }));

  // Everything else under /api requires a signed-in user.
  app.use('/api', auth);

  app.get('/api/status', async (req, res) => {
    if (missing.length > 0) {
      return res.json({ ready: false, missing, database: null, reddit: null, scheduler: null });
    }
    const [dbError, redditError] = await Promise.all([
      repo.ping().catch((err) => err.message),
      reddit.verify().then(
        () => null,
        (err) => err.message,
      ),
    ]);
    res.json({
      ready: !dbError && !redditError,
      missing,
      database: { ok: !dbError, error: dbError },
      reddit: { ok: !redditError, error: redditError },
      scheduler: scheduler.status(),
    });
  });

  if (missing.length > 0) {
    app.use('/api', (req, res) => {
      res.status(503).json({ error: `Server not configured. Missing in server/.env: ${missing.join(', ')}` });
    });
  } else {
    registerRoutes(app, { repo, reddit, checker, scheduler, log });
  }

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // In production the server also serves the built React app.
  if (clientDist) {
    app.use(express.static(clientDist));
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  app.use((err, req, res, next) => {
    const status = err instanceof HttpError || err.expose ? err.status : 500;
    if (status >= 500) log.error(err);
    res.status(status).json({ error: err.message || 'Internal error' });
  });

  return app;
}

function registerRoutes(app, { repo, reddit, checker, scheduler, log }) {
  async function requireAccount(id) {
    const account = UUID_RE.test(id) ? await repo.getAccount(id) : null;
    if (!account) throw new HttpError(404, 'Account not found');
    return account;
  }

  registerShieldRoutes(app,{repo,reddit});
  registerPreventionOperationsRoutes(app,{repo});

  // Preventer: internal, read-only activity & draft checks. No automatic
  // posting, voting, or manipulation of Reddit sessions occurs here.
  async function preventionContext(id) {
    const account = await requireAccount(id);
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const [items, checks, onboarding] = await Promise.all([
      repo.getContentItems(account.id, since),
      repo.getRecentChecks(account.id, 15),
      repo.getPreventionProfile(account.id),
    ]);
    const activity = analyzeActivity(items);
    const readiness = assessReadiness({ account, checks, onboarding, activity });
    return { account, items, activity, readiness };
  }

  app.get('/api/preventer/accounts/:id', async (req, res) => {
    const { account, activity, readiness } = await preventionContext(req.params.id);
    res.json({ account_id: account.id, username: account.username, activity, readiness });
  });

  app.put('/api/preventer/accounts/:id/onboarding', async (req, res) => {
    const account = await requireAccount(req.params.id);
    const body = req.body ?? {};
    const fields = ['email_verified', 'two_factor_enabled', 'rules_reviewed'];
    const patch = {};
    for (const field of fields) {
      if (Object.hasOwn(body, field)) {
        if (body[field] !== null && typeof body[field] !== 'boolean') {
          throw new HttpError(400, `${field} must be true, false or null.`);
        }
        patch[field] = body[field];
      }
    }
    if (Object.hasOwn(body, 'notes')) {
      if (typeof body.notes !== 'string' || body.notes.length > 1000) throw new HttpError(400, 'Notes must be under 1000 characters.');
      patch.notes = body.notes.trim();
    }
    if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to update.');
    await repo.upsertPreventionProfile(account.id, patch);
    const { readiness } = await preventionContext(account.id);
    res.json({ readiness });
  });

  app.post('/api/preventer/preflight', async (req, res) => {
    const body = req.body ?? {};
    if (!UUID_RE.test(String(body.accountId ?? ''))) throw new HttpError(400, 'Choose a monitored account.');
    const subreddit = String(body.subreddit ?? '').trim().replace(/^r\//i, '');
    if (!/^[A-Za-z0-9_]{2,24}$/.test(subreddit)) throw new HttpError(400, 'Enter a valid subreddit name.');
    const kind = body.kind;
    if (!['post', 'comment'].includes(kind)) throw new HttpError(400, 'Kind must be post or comment.');
    const title = String(body.title ?? '');
    const content = String(body.text ?? '');
    const rulesText = String(body.rulesText ?? '');
    const url = String(body.url ?? '').trim();
    if (title.length > 300 || content.length > 10000 || rulesText.length > 4000 || url.length > 2000) throw new HttpError(400, 'Draft or rules text exceeds the permitted length.');
    if (!content.trim() && !title.trim() && !url) throw new HttpError(400, 'Enter a draft or link to scan.');
    if (url) {
      try { if (!['http:', 'https:'].includes(new URL(url).protocol)) throw Error(); }
      catch { throw new HttpError(400, 'Use a valid http/https URL.'); }
    }
    const { account, items, activity, readiness } = await preventionContext(body.accountId);
    const report = scanDraft({ draft: { subreddit, kind, title, text: content, rulesText, url }, account, readiness, activity, items });
    res.json({ report, activity, readiness });
  });

  app.get('/api/accounts', async (req, res) => {
    const [accounts, openAlerts] = await Promise.all([
      repo.listAccounts(),
      repo.listAlerts({ openOnly: true, limit: 500 }),
    ]);
    const openByAccount = {};
    for (const alert of openAlerts) {
      openByAccount[alert.account_id] = (openByAccount[alert.account_id] ?? 0) + 1;
    }
    res.json({
      accounts: accounts.map((account) => ({
        ...account,
        open_alerts: openByAccount[account.id] ?? 0,
        checking: checker.isChecking(account.id),
      })),
      scheduler: scheduler.status(),
    });
  });

  // One-off check for any username: runs the full pipeline against the live
  // API and returns the report without adding the account to monitoring.
  app.post('/api/check-live', async (req, res) => {
    const username = normalizeUsername((req.body ?? {}).username);
    if (!USERNAME_RE.test(username)) {
      throw new HttpError(400, 'Enter a valid Reddit username (3-20 letters, numbers, _ or -).');
    }
    try {
      res.json(await checkLiveProfile({ reddit, username }));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      // A live API failure is a report, not a 500: surface the message.
      throw new HttpError(502, `Reddit check failed: ${err.message || String(err)}`);
    }
  });

  app.post('/api/accounts', async (req, res) => {
    const body = req.body ?? {};
    const username = normalizeUsername(body.username);
    if (!USERNAME_RE.test(username)) {
      throw new HttpError(400, 'Enter a valid Reddit username (3-20 letters, numbers, _ or -).');
    }
    const account = await repo.createAccount({
      username,
      label: cleanText(body.label, 60),
      notes: cleanText(body.notes, 1000),
    });
    // The first check runs in the background so the form answers immediately.
    checker.checkAccount(account).catch((err) => log.error(`First check failed for u/${username}:`, err));
    res.status(201).json({ account: { ...account, open_alerts: 0, checking: true } });
  });

  app.get('/api/accounts/:id', async (req, res) => {
    const account = await requireAccount(req.params.id);
    const [checks, removed, recent, alerts] = await Promise.all([
      repo.getRecentChecks(account.id, 200),
      repo.listContent(account.id, { removedOnly: true, limit: 50 }),
      repo.listContent(account.id, { limit: 25 }),
      repo.listAlerts({ accountId: account.id, limit: 20 }),
    ]);
    const lastCheck = checks[0] ?? null;
    res.json({
      account: { ...account, checking: checker.isChecking(account.id) },
      latestCheck: checks.find((check) => !check.error) ?? null,
      lastError: lastCheck?.error ? { checked_at: lastCheck.checked_at, error: lastCheck.error } : null,
      history: checks
        .filter((check) => !check.error)
        .reverse()
        .map((check) => ({
          checked_at: check.checked_at,
          status: check.status,
          risk_score: check.risk_score,
          link_karma: check.link_karma,
          comment_karma: check.comment_karma,
          items_sampled: check.items_sampled,
          items_removed: check.items_removed,
        })),
      removed,
      recent,
      alerts,
    });
  });

  app.patch('/api/accounts/:id', async (req, res) => {
    const account = await requireAccount(req.params.id);
    const body = req.body ?? {};
    const patch = {};
    if ('label' in body) patch.label = cleanText(body.label, 60);
    if ('notes' in body) patch.notes = cleanText(body.notes, 1000);
    if ('paused' in body) patch.paused = Boolean(body.paused);
    if ('stealth_mode' in body) patch.stealth_mode = Boolean(body.stealth_mode);
    if (Object.keys(patch).length === 0) throw new HttpError(400, 'Nothing to update');
    res.json({ account: await repo.updateAccount(account.id, patch) });
  });

  // Stealth: get the fingerprint fields the form should render.
  app.get('/api/accounts/:id/stealth/fingerprint', async (req, res) => {
    const account = await requireAccount(req.params.id);
    res.json({
      account_id: account.id,
      stealth_mode: account.stealth_mode,
      fields: fingerprintFields(),
      current: account.fingerprint ?? null,
      suggested: suggestFingerprint(account),
    });
  });

  // Stealth: save the fingerprint for an account.
  app.put('/api/accounts/:id/stealth/fingerprint', async (req, res) => {
    const account = await requireAccount(req.params.id);
    const body = req.body ?? {};
    const { ok, value, errors } = validateFingerprint(body);
    if (!ok) throw new HttpError(400, errors.join(' '));
    // Preserve any existing warm-up plan.
    const existingPlan = account.fingerprint?.warmup ?? null;
    const fingerprint = existingPlan ? { ...value, warmup: existingPlan } : value;
    const updated = await repo.updateAccount(account.id, { fingerprint });
    res.json({ account: updated });
  });

  // Stealth: start a warm-up plan.
  app.post('/api/accounts/:id/stealth/warmup/start', async (req, res) => {
    const account = await requireAccount(req.params.id);
    if (!account.stealth_mode) throw new HttpError(400, 'Stealth mode is not enabled for this account.');
    // Estimate account age from the last check if available.
    const checks = await repo.getRecentChecks(account.id, 1);
    const check = checks[0];
    const ageDays = check?.account_created_at
      ? Math.floor((Date.now() - Date.parse(check.account_created_at)) / (24 * 60 * 60 * 1000))
      : 0;
    const plan = createWarmupPlan(ageDays);
    const existing = account.fingerprint ?? {};
    const fingerprint = { ...existing, warmup: plan };
    const updated = await repo.updateAccount(account.id, { fingerprint });
    res.json({ account: updated, plan });
  });

  // Stealth: record a warm-up action as performed.
  app.post('/api/accounts/:id/stealth/warmup/action', async (req, res) => {
    const account = await requireAccount(req.params.id);
    const plan = account.fingerprint?.warmup;
    if (!plan) throw new HttpError(400, 'No warm-up plan is active.');
    if (plan.actions_done >= plan.actions_target) throw new HttpError(400, 'Warm-up plan is already complete.');
    const body = req.body ?? {};
    const action = String(body.action ?? 'upvote').slice(0, 60);
    await repo.insertWarmupLog(account.id, action);
    const updatedPlan = { ...plan, actions_done: plan.actions_done + 1 };
    const fingerprint = { ...account.fingerprint, warmup: updatedPlan };
    const updated = await repo.updateAccount(account.id, { fingerprint });
    res.json({ account: updated, plan: updatedPlan });
  });

  // Stealth: get the warm-up log.
  app.get('/api/accounts/:id/stealth/warmup/log', async (req, res) => {
    const account = await requireAccount(req.params.id);
    const log = await repo.getWarmupLog(account.id, 50);
    const plan = account.fingerprint?.warmup ?? null;
    res.json({
      plan,
      progress: plan ? warmupProgress(plan) : null,
      log,
    });
  });

  // Stealth: clear the warm-up plan and log.
  app.delete('/api/accounts/:id/stealth/warmup', async (req, res) => {
    const account = await requireAccount(req.params.id);
    const fingerprint = { ...account.fingerprint };
    delete fingerprint.warmup;
    await repo.clearWarmupLog(account.id);
    const updated = await repo.updateAccount(account.id, { fingerprint });
    res.json({ account: updated });
  });

  // Vote history. Reddit doesn't publish an account's votes, so there is
  // nothing to fetch: the owner imports post_votes.csv / comment_votes.csv
  // from their Reddit data export (see src/votes.js).
  app.get('/api/accounts/:id/votes', async (req, res) => {
    const account = await requireAccount(req.params.id);
    const direction = ['up', 'down'].includes(req.query.direction) ? req.query.direction : null;
    const kind = VOTE_KINDS.has(req.query.kind) ? req.query.kind : null;
    const limit = Math.min(5000, Math.max(1, Number(req.query.limit) || 1000));
    const [votes, shared, accounts] = await Promise.all([
      repo.listAccountVotes(account.id),
      repo.listSharedVotes(),
      repo.listAccounts(),
    ]);
    const matching = votes
      .filter((vote) => (!direction || vote.direction === direction) && (!kind || vote.kind === kind))
      .sort(voteOrder);
    res.json({
      summary: summarizeVotes(votes),
      votes: matching.slice(0, limit),
      matching: matching.length,
      shared: sharedVotesFor(account.id, shared, new Map(accounts.map((row) => [row.id, row.username]))),
      last_imported_at: votes.reduce((latest, vote) => (latest === null || vote.updated_at > latest ? vote.updated_at : latest), null),
    });
  });

  // Body: the CSV file itself (text/csv). kind=post for post_votes.csv,
  // kind=comment for comment_votes.csv; the file replaces that kind's votes.
  // Import times strictly increase, so a later import always tells its rows
  // apart from the ones it replaces, even within one millisecond.
  let lastImportAt = 0;
  const nextImportTime = () => {
    lastImportAt = Math.max(Date.now(), lastImportAt + 1);
    return new Date(lastImportAt).toISOString();
  };
  app.post(
    '/api/accounts/:id/votes/import',
    express.text({ type: ['text/csv', 'text/plain'], limit: '25mb' }),
    async (req, res) => {
      const account = await requireAccount(req.params.id);
      const kind = String(req.query.kind ?? '');
      if (!VOTE_KINDS.has(kind)) {
        throw new HttpError(400, 'Say which file this is: kind=post for post_votes.csv, kind=comment for comment_votes.csv.');
      }
      if (typeof req.body !== 'string' || !req.body.trim()) throw new HttpError(400, 'Upload the CSV file as text/csv.');
      const { votes, skipped, error } = parseVoteCsv(req.body, kind);
      if (error) throw new HttpError(400, error);
      const skippedTotal = Object.values(skipped).reduce((sum, n) => sum + n, 0);
      // A file where no row is usable is the wrong file, not "no votes": importing
      // it would delete every stored vote of this kind.
      if (votes.length === 0 && skippedTotal > 0) {
        const reasons = Object.entries(skipped).map(([reason, n]) => `${n} × ${reason}`).join('; ');
        throw new HttpError(400, `None of the ${skippedTotal} rows could be imported (${reasons}).`);
      }
      const { removed } = await repo.replaceAccountVotes(account.id, kind, votes, nextImportTime());
      res.json({
        kind,
        imported: votes.length,
        removed,
        skipped,
        summary: summarizeVotes(await repo.listAccountVotes(account.id)),
      });
    },
  );

  app.delete('/api/accounts/:id/votes', async (req, res) => {
    const account = await requireAccount(req.params.id);
    await repo.clearAccountVotes(account.id);
    res.status(204).end();
  });

  app.delete('/api/accounts/:id', async (req, res) => {
    const account = await requireAccount(req.params.id);
    await repo.deleteAccount(account.id);
    res.status(204).end();
  });

  app.post('/api/accounts/:id/check', async (req, res) => {
    const account = await requireAccount(req.params.id);
    const result = await checker.checkAccount(account);
    if (!result) throw new HttpError(409, 'A check for this account is already running.');
    res.json(result);
  });

  app.post('/api/check-all', (req, res) => {
    res.status(202).json({ started: scheduler.trigger() });
  });

  app.get('/api/alerts', async (req, res) => {
    const openOnly = ['1', 'true'].includes(String(req.query.open));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const accountId = UUID_RE.test(String(req.query.accountId ?? '')) ? req.query.accountId : null;
    res.json({ alerts: await repo.listAlerts({ openOnly, accountId, limit }) });
  });

  app.post('/api/alerts/ack-all', async (req, res) => {
    await repo.ackAllAlerts();
    res.status(204).end();
  });

  app.post('/api/alerts/:id/ack', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) throw new HttpError(404, 'Alert not found');
    await repo.ackAlert(req.params.id);
    res.status(204).end();
  });
}
