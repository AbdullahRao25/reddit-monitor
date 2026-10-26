// Demo server: the real API, checker and scheduler, wired to the in-memory
// repo from the tests and a simulated Reddit (demoReddit.js). Three weeks of
// history are produced by running the real checker on a simulated clock, then
// the clock switches to real time and the scheduler keeps checking live.
//
// For trying the dashboard without Supabase or Reddit credentials. Nothing is
// persisted: every restart re-seeds. Run from reddit-monitor/: npm run demo

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApp } from '../src/app.js';
import { createChecker } from '../src/checker.js';
import { config } from '../src/config.js';
import { createScheduler } from '../src/scheduler.js';
import { createWarmupPlan } from '../src/stealth/warmup.js';
import { createMemoryRepo, silentLog } from '../test/helpers.js';
import { createDemoReddit, DEMO_PERSONAS } from './demoReddit.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SEED_DAYS = 21;
const SEED_STEP = 6 * HOUR;

const now = Date.now();
let simulated = null;
const clock = () => simulated ?? Date.now();

const repo = createMemoryRepo({ now: clock });
const reddit = createDemoReddit({ now, clock });
const checker = createChecker({ repo, reddit, now: clock, log: silentLog });

const FINGERPRINT = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  timezone: 'America/Los_Angeles',
  viewport: '1536x864',
  locale: 'en-US',
};

// The stealth persona starts a warm-up plan a week ago and logs an action
// roughly every 11 hours since.
const WARMUP_START = now - 7 * DAY;
const WARMUP_ACTIONS = ['browse_sub', 'upvote', 'comment', 'upvote', 'view_profile', 'browse_sub', 'comment'];

async function advanceWarmup(id, persona, until) {
  let account = await repo.getAccount(id);
  if (!account.fingerprint?.warmup) {
    if (until < WARMUP_START) return;
    simulated = WARMUP_START;
    const ageDays = Math.floor(persona.ageDays - (now - WARMUP_START) / DAY);
    account = await repo.updateAccount(id, {
      fingerprint: { ...account.fingerprint, warmup: createWarmupPlan(ageDays, WARMUP_START) },
    });
  }
  let plan = account.fingerprint.warmup;
  for (let t = WARMUP_START + 3 * HOUR + plan.actions_done * 11 * HOUR; t <= until; t += 11 * HOUR) {
    simulated = t;
    await repo.insertWarmupLog(id, WARMUP_ACTIONS[plan.actions_done % WARMUP_ACTIONS.length]);
    plan = { ...plan, actions_done: plan.actions_done + 1 };
  }
  await repo.updateAccount(id, { fingerprint: { ...account.fingerprint, warmup: plan } });
  simulated = until;
}

async function seed() {
  const ids = new Map();
  const start = now - SEED_DAYS * DAY;

  for (let t = start; t <= now - HOUR; t += SEED_STEP) {
    for (const [index, persona] of DEMO_PERSONAS.entries()) {
      // Stagger accounts a couple of minutes apart, like a sequential run.
      simulated = t + index * 2 * 60 * 1000;
      if (simulated < now - persona.monitorDays * DAY) continue;

      if (!ids.has(persona.username)) {
        const account = await repo.createAccount({
          username: persona.username,
          label: persona.label ?? null,
          notes: persona.notes ?? null,
        });
        ids.set(persona.username, account.id);
        if (persona.stealth) {
          await repo.updateAccount(account.id, { stealth_mode: true, fingerprint: { ...FINGERPRINT } });
        }
      }
      const id = ids.get(persona.username);
      if (persona.pausedDays && simulated >= now - persona.pausedDays * DAY) {
        await repo.updateAccount(id, { paused: true });
        continue;
      }
      if (persona.stealth) await advanceWarmup(id, persona, simulated);
      await checker.checkAccount(await repo.getAccount(id));
    }
  }

  // Alerts older than two days have been looked at already.
  for (const alert of repo.alerts) {
    if (Date.parse(alert.created_at) < now - 2 * DAY) {
      alert.acknowledged_at = new Date(Date.parse(alert.created_at) + 3 * HOUR).toISOString();
    }
  }
  simulated = null;
}

const started = performance.now();
await seed();
reddit.setLatency([250, 700]);

const scheduler = createScheduler({ repo, checker, intervalMinutes: config.checkIntervalMinutes });
const clientDist = fileURLToPath(new URL('../../client/dist', import.meta.url));
const api = createApp({ repo, reddit, checker, scheduler, clientDist: existsSync(clientDist) ? clientDist : null });

// Same status shape as the real server, flagged so the dashboard can say it's a demo.
const app = express();
app.disable('x-powered-by');
app.get('/api/status', (req, res) => {
  res.json({
    ready: true,
    demo: true,
    missing: [],
    database: { ok: true, error: null },
    reddit: { ok: true, error: null },
    scheduler: scheduler.status(),
  });
});
app.use(api);

app.listen(config.port, config.host, (err) => {
  if (err) {
    console.error(`Could not start the demo API on ${config.host}:${config.port}: ${err.message}`);
    process.exit(1);
  }
  console.log(
    `Demo API listening on http://${config.host}:${config.port} ` +
      `(${repo.accounts.size} accounts, ${repo.checks.length} checks seeded in ${Math.round(performance.now() - started)} ms)`,
  );
  scheduler.start();
});
