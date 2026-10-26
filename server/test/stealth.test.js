import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fingerprintConsistencyScore,
  fingerprintFields,
  suggestFingerprint,
  validateFingerprint,
} from '../src/stealth/fingerprint.js';
import {
  createWarmupPlan,
  isMature,
  nextWarmupAction,
  recordWarmupAction,
  stealthRecommendations,
  warmupProgress,
} from '../src/stealth/warmup.js';
import {
  DAY,
  HOUR,
  NOW,
  createFakeReddit,
  createMemoryRepo,
  healthyProfile,
  rawComment,
  rawPost,
  silentLog,
} from './helpers.js';
import { createChecker } from '../src/checker.js';
import { createApp } from '../src/app.js';
import { once } from 'node:events';

// ---------------------------------------------------------------- fingerprint

test('fingerprintFields lists the four fields the form renders', () => {
  assert.deepEqual(
    fingerprintFields().map((f) => f.key),
    ['userAgent', 'timezone', 'viewport', 'locale'],
  );
});

test('validateFingerprint accepts a realistic fingerprint and trims it', () => {
  const result = validateFingerprint({
    userAgent: '  Mozilla/5.0 (Windows NT 10.0; Win64; x64)  ',
    timezone: 'America/New_York',
    viewport: '1920x1080',
    locale: 'en-US',
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.userAgent, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
});

test('validateFingerprint rejects non-objects and missing fields', () => {
  assert.equal(validateFingerprint(null).ok, false);
  assert.equal(validateFingerprint('string').ok, false);
  assert.equal(validateFingerprint([]).ok, false);
  const result = validateFingerprint({ userAgent: 'Mozilla/5.0' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('timezone')));
});

test('validateFingerprint rejects each field type individually', () => {
  const base = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    timezone: 'America/New_York',
    viewport: '1920x1080',
    locale: 'en-US',
  };
  assert.equal(validateFingerprint({ ...base, userAgent: 'short' }).ok, false, 'short UA');
  assert.equal(validateFingerprint({ ...base, timezone: 'NY' }).ok, false, 'no slash in tz');
  assert.equal(validateFingerprint({ ...base, timezone: 'America/123' }).ok, false, 'digits in tz');
  assert.equal(validateFingerprint({ ...base, viewport: '1920' }).ok, false, 'no x in viewport');
  assert.equal(validateFingerprint({ ...base, viewport: 'w1920h1080' }).ok, false, 'bad viewport');
  assert.equal(validateFingerprint({ ...base, locale: 'English' }).ok, false, 'non-BCP47 locale');
  assert.equal(validateFingerprint({ ...base, locale: 'en-us' }).ok, false, 'lowercase region');
});

test('fingerprintConsistencyScore is null without a fingerprint', () => {
  assert.equal(fingerprintConsistencyScore({ username: 'x' }, null), null);
});

test('fingerprintConsistencyScore starts at 100 for a fully consistent profile', () => {
  const account = { username: 'x', timezone_hint: 'America/New_York', posting_hours: [14, 15, 16] };
  const fp = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
    timezone: 'America/New_York',
    viewport: '1920x1080',
    locale: 'en-US',
  };
  assert.equal(fingerprintConsistencyScore(account, fp), 100);
});

test('fingerprintConsistencyScore penalises timezone mismatch', () => {
  const account = { username: 'x', timezone_hint: 'America/New_York' };
  const fp = {
    userAgent: 'Mozilla/5.0 Chrome/120',
    timezone: 'Europe/Berlin',
    viewport: '1920x1080',
    locale: 'de',
  };
  assert.equal(fingerprintConsistencyScore(account, fp), 70);
});

test('fingerprintConsistencyScore penalises a non-browser UA', () => {
  const account = { username: 'x' };
  const fp = {
    userAgent: 'python-requests/2.31.0',
    timezone: 'America/New_York',
    viewport: '1920x1080',
    locale: 'en-US',
  };
  assert.equal(fingerprintConsistencyScore(account, fp), 85);
});

test('fingerprintConsistencyScore stacks penalties and never goes below 0', () => {
  // timezone −30 + suspicious hours −20 + curl UA −15 = 35
  const account = {
    username: 'x',
    timezone_hint: 'America/New_York',
    posting_hours: [2, 3, 4],
  };
  const fp = {
    userAgent: 'curl/8.0',
    timezone: 'Europe/Berlin',
    viewport: '1920x1080',
    locale: 'de',
  };
  assert.equal(fingerprintConsistencyScore(account, fp), 35);

  // suspicious hours (−20) + curl UA (−15), no tz hint = 65
  const noTzHint = { username: 'x', posting_hours: [2, 3, 4] };
  assert.equal(fingerprintConsistencyScore(noTzHint, fp), 65);
});

test('suggestFingerprint uses the account timezone hint when present', () => {
  assert.equal(suggestFingerprint({ timezone_hint: 'Asia/Tokyo' }).timezone, 'Asia/Tokyo');
  assert.equal(suggestFingerprint({}).timezone, 'America/New_York');
  assert.equal(suggestFingerprint(null).timezone, 'America/New_York');
});

// ---------------------------------------------------------------- warmup

test('createWarmupPlan: newer accounts get longer, slower warm-ups', () => {
  const new_ = createWarmupPlan(3, NOW);
  assert.equal(new_.actions_target, 28, 'age<7: 14 days * 2/day');
  assert.equal(new_.daily_actions, 2);

  const mid = createWarmupPlan(15, NOW);
  assert.equal(mid.actions_target, 30, 'age<30: 10 days * 3/day');
  assert.equal(mid.daily_actions, 3);

  const old = createWarmupPlan(60, NOW);
  assert.equal(old.actions_target, 28, 'age>=30: 7 days * 4/day');
  assert.equal(old.daily_actions, 4);
});

test('createWarmupPlan target_at is in the future by the right number of days', () => {
  const plan = createWarmupPlan(3, NOW);
  const days = (Date.parse(plan.target_at) - NOW) / DAY;
  assert.ok(Math.abs(days - 14) < 0.01, `expected 14 days, got ${days}`);
  assert.ok(Date.parse(plan.started_at) >= NOW);
});

test('isMature: requires 30 days age AND 100+ total karma', () => {
  const oldProfile = { createdAt: NOW - 60 * DAY, linkKarma: 50, commentKarma: 60 };
  assert.equal(isMature({}, oldProfile), true);

  const youngProfile = { createdAt: NOW - 10 * DAY, linkKarma: 500, commentKarma: 500 };
  assert.equal(isMature({}, youngProfile), false, 'too young despite high karma');

  const lowKarma = { createdAt: NOW - 60 * DAY, linkKarma: 50, commentKarma: 40 };
  assert.equal(isMature({}, lowKarma), false, 'old enough but under 100 karma');

  assert.equal(isMature({}, null), false, 'no profile');
});

test('nextWarmupAction: null when stealth is off', () => {
  const account = { stealth_mode: false, fingerprint: { warmup: createWarmupPlan(3, NOW) } };
  assert.equal(nextWarmupAction(account, healthyProfile(), [], NOW), null);
});

test('nextWarmupAction: null when the account is mature', () => {
  const account = { stealth_mode: true, fingerprint: { warmup: createWarmupPlan(3, NOW) } };
  const matureProfile = { createdAt: NOW - 60 * DAY, linkKarma: 200, commentKarma: 200 };
  assert.equal(nextWarmupAction(account, matureProfile, [], NOW), null);
});

test('nextWarmupAction: null with no plan or a complete plan', () => {
  const noPlan = { stealth_mode: true, fingerprint: null };
  assert.equal(nextWarmupAction(noPlan, healthyProfile(), [], NOW), null);

  const complete = {
    stealth_mode: true,
    fingerprint: { warmup: { actions_done: 10, actions_target: 10, daily_actions: 2, target_at: new Date(NOW + DAY).toISOString() } },
  };
  assert.equal(nextWarmupAction(complete, healthyProfile(), [], NOW), null);
});

test('nextWarmupAction: respects the daily cap', () => {
  const plan = createWarmupPlan(3, NOW); // daily_actions: 2
  const account = { stealth_mode: true, fingerprint: { warmup: plan } };
  const twoToday = [
    { action: 'upvote', performed_at: new Date(NOW - HOUR).toISOString() },
    { action: 'comment', performed_at: new Date(NOW - 2 * HOUR).toISOString() },
  ];
  assert.equal(nextWarmupAction(account, healthyProfile(), twoToday, NOW), null);
});

test('nextWarmupAction: returns an action for a young, planned, stealth account', () => {
  const plan = createWarmupPlan(3, NOW);
  const account = { stealth_mode: true, fingerprint: { warmup: plan } };
  const young = { ...healthyProfile(), createdAt: NOW - 5 * DAY }; // not yet mature
  const lastAction = { action: 'upvote', performed_at: new Date(NOW - 3 * DAY).toISOString() };
  const result = nextWarmupAction(account, young, [lastAction], NOW);
  assert.ok(result, 'expected an action');
  assert.notEqual(result.action, 'upvote', 'should not repeat the last action');
  assert.ok(result.detail.includes('1 of 28'), `detail: ${result.detail}`);
});

test('recordWarmupAction increments actions_done', () => {
  const plan = createWarmupPlan(3, NOW);
  const updated = recordWarmupAction(plan, NOW);
  assert.equal(updated.actions_done, 1);
  assert.equal(plan.actions_done, 0, 'original not mutated');
});

test('warmupProgress: 0 with no plan, 100 at or beyond target', () => {
  assert.equal(warmupProgress(null), 0);
  assert.equal(warmupProgress({ actions_done: 0, actions_target: 0 }), 0);
  assert.equal(warmupProgress({ actions_done: 7, actions_target: 28 }), 25);
  assert.equal(warmupProgress({ actions_done: 28, actions_target: 28 }), 100);
  assert.equal(warmupProgress({ actions_done: 30, actions_target: 28 }), 100, 'clamped');
});

test('stealthRecommendations: empty when stealth is off', () => {
  const account = { stealth_mode: false, fingerprint: null };
  assert.deepEqual(stealthRecommendations(account, healthyProfile(), { level: 'low', recommendations: [] }, []), []);
});

test('stealthRecommendations: warmup_in_progress while the plan is incomplete', () => {
  const plan = { ...createWarmupPlan(3, NOW), actions_done: 5 };
  const account = { stealth_mode: true, fingerprint: { warmup: plan } };
  const recs = stealthRecommendations(account, healthyProfile(), { level: 'low' }, []);
  assert.ok(recs.some((r) => r.key === 'warmup_in_progress'));
  assert.ok(recs.some((r) => /18%/.test(r.title)), 'progress in title');
});

test('stealthRecommendations: warmup_complete when the plan is done', () => {
  const plan = { ...createWarmupPlan(3, NOW), actions_done: 28 };
  const account = { stealth_mode: true, fingerprint: { warmup: plan } };
  const recs = stealthRecommendations(account, healthyProfile(), { level: 'low' }, []);
  assert.ok(recs.some((r) => r.key === 'warmup_complete'));
});

test('stealthRecommendations: no_warmup_plan for a young stealth account with no plan', () => {
  const young = { ...healthyProfile(), createdAt: NOW - 5 * DAY };
  const account = { stealth_mode: true, fingerprint: null };
  const recs = stealthRecommendations(account, young, { level: 'low' }, []);
  assert.ok(recs.some((r) => r.key === 'no_warmup_plan' && r.priority === 'high'));
});

test('stealthRecommendations: no_warmup_plan is absent once the account is mature', () => {
  const mature = { ...healthyProfile(), createdAt: NOW - 40 * DAY };
  const account = { stealth_mode: true, fingerprint: null };
  const recs = stealthRecommendations(account, mature, { level: 'low' }, []);
  assert.ok(!recs.some((r) => r.key === 'no_warmup_plan'));
});

test('stealthRecommendations: fingerprint_mismatch when the score is low', () => {
  const account = {
    stealth_mode: true,
    timezone_hint: 'America/New_York',
    fingerprint: {
      userAgent: 'curl/8.0',
      timezone: 'Europe/Berlin',
      viewport: '1920x1080',
      locale: 'de',
    },
  };
  const recs = stealthRecommendations(account, healthyProfile(), { level: 'low' }, []);
  assert.ok(recs.some((r) => r.key === 'fingerprint_mismatch' && r.priority === 'high'));
});

test('stealthRecommendations: stealth_shadowban when assessment is critical', () => {
  const account = { stealth_mode: true, fingerprint: null };
  const recs = stealthRecommendations(account, healthyProfile(), { level: 'critical' }, []);
  assert.ok(recs.some((r) => r.key === 'stealth_shadowban' && r.priority === 'urgent'));
});

test('stealthRecommendations: stealth_high_risk when assessment is high', () => {
  const account = { stealth_mode: true, fingerprint: null };
  const recs = stealthRecommendations(account, healthyProfile(), { level: 'high' }, []);
  assert.ok(recs.some((r) => r.key === 'stealth_high_risk' && r.priority === 'high'));
  assert.ok(!recs.some((r) => r.key === 'stealth_shadowban'), 'high is not critical');
});

// ---------------------------------------------------------------- checker

function checkerSetup() {
  let clock = NOW;
  const repo = createMemoryRepo({ now: () => clock });
  const reddit = createFakeReddit();
  const checker = createChecker({ repo, reddit, now: () => clock, log: silentLog });
  reddit.state.posts = [rawPost({ id: 'p0', createdAt: NOW - DAY })];
  reddit.state.comments = [rawComment({ id: 'c0', createdAt: NOW - 8 * HOUR, body: 'a comment' })];
  return {
    repo,
    reddit,
    checker,
    advance: (ms) => {
      clock += ms;
    },
    check: async (id) => checker.checkAccount(await repo.getAccount(id)),
  };
}

test('a stealth account with a mismatched fingerprint gets fingerprint_mismatch in its check', async () => {
  const t = checkerSetup();
  const account = await t.repo.createAccount({ username: 'stealthy' });
  await t.repo.updateAccount(account.id, {
    stealth_mode: true,
    timezone_hint: 'America/New_York',
    fingerprint: {
      userAgent: 'curl/8.0',
      timezone: 'Europe/Berlin',
      viewport: '1920x1080',
      locale: 'de',
    },
  });
  const result = await t.check(account.id);
  const keys = result.check.recommendations.map((r) => r.key);
  assert.ok(keys.includes('fingerprint_mismatch'), `keys: ${keys.join(', ')}`);
});

test('a stealth account with a consistent fingerprint gets no mismatch rec', async () => {
  const t = checkerSetup();
  const account = await t.repo.createAccount({ username: 'clean' });
  await t.repo.updateAccount(account.id, {
    stealth_mode: true,
    timezone_hint: 'America/New_York',
    fingerprint: {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120',
      timezone: 'America/New_York',
      viewport: '1920x1080',
      locale: 'en-US',
    },
  });
  const result = await t.check(account.id);
  const keys = result.check.recommendations.map((r) => r.key);
  assert.ok(!keys.includes('fingerprint_mismatch'), `keys: ${keys.join(', ')}`);
});

test('a stealth account with a warm-up plan gets warmup_in_progress in its check', async () => {
  const t = checkerSetup();
  // Make the profile young so it is not mature.
  t.reddit.state.about = { state: 'active', profile: { ...healthyProfile(), createdAt: NOW - 5 * DAY } };
  const account = await t.repo.createAccount({ username: 'warmer' });
  await t.repo.updateAccount(account.id, {
    stealth_mode: true,
    fingerprint: { warmup: createWarmupPlan(5, NOW) },
  });
  const result = await t.check(account.id);
  const keys = result.check.recommendations.map((r) => r.key);
  assert.ok(keys.includes('warmup_in_progress'), `keys: ${keys.join(', ')}`);
});

test('a non-stealth account does not get stealth recommendations', async () => {
  const t = checkerSetup();
  t.reddit.state.about = { state: 'active', profile: { ...healthyProfile(), createdAt: NOW - 5 * DAY } };
  const account = await t.repo.createAccount({ username: 'plain' });
  const result = await t.check(account.id);
  const keys = result.check.recommendations.map((r) => r.key);
  for (const key of ['warmup_in_progress', 'no_warmup_plan', 'fingerprint_mismatch', 'stealth_shadowban', 'stealth_high_risk']) {
    assert.ok(!keys.includes(key), `unexpected ${key} in ${keys.join(', ')}`);
  }
});

// ---------------------------------------------------------------- checker: early risk

test('a stealth check stores the early risk, its factors, and its recs', async () => {
  const t = checkerSetup();
  const account = await t.repo.createAccount({ username: 'early' });
  await t.repo.updateAccount(account.id, { stealth_mode: true });
  const result = await t.check(account.id);

  assert.ok(result.check.early_risk, 'check.early_risk should be set for a stealth account');
  assert.match(result.check.early_risk.level, /^(low|elevated|high|critical)$/);
  assert.ok(result.check.early_risk.score >= 0 && result.check.early_risk.score <= 100);

  const stored = await t.repo.getAccount(account.id);
  assert.equal(stored.early_risk_level, result.check.early_risk.level);

  const keys = result.check.recommendations.map((r) => r.key);
  for (const key of keys.filter((k) => k.startsWith('early_'))) {
    assert.ok(!key.startsWith('early_early_'), `double-prefixed rec key: ${key}`);
  }
});

test('an account with a fresh sitewide removal and no cooldown escalates its early risk', async () => {
  const t = checkerSetup();
  // One spam-filtered post plus four more within 3 days: the spam filter has
  // hit and the account kept going -> early_sitewide_removals (15) +
  // early_no_cooldown (20) = 35, elevated.
  t.reddit.state.posts = [
    rawPost({ id: 'p0', createdAt: NOW - 2 * DAY, removedBy: 'spam_filtered' }),
    rawPost({ id: 'p1', createdAt: NOW - DAY }),
    rawPost({ id: 'p2', createdAt: NOW - 2 * DAY }),
    rawPost({ id: 'p3', createdAt: NOW - DAY }),
    rawPost({ id: 'p4', createdAt: NOW - 6 * HOUR }),
  ];
  t.reddit.state.comments = [];
  const account = await t.repo.createAccount({ username: 'hot' });
  await t.repo.updateAccount(account.id, { stealth_mode: true });
  const result = await t.check(account.id);

  const early = result.check.early_risk;
  assert.equal(early.score, 35);
  assert.equal(early.level, 'elevated');
  const stored = await t.repo.getAccount(account.id);
  assert.equal(stored.early_risk_level, 'elevated');
  assert.ok(early.top, 'should name the strongest signal');
});

test('a non-stealth check stores no early risk at all', async () => {
  const t = checkerSetup();
  const account = await t.repo.createAccount({ username: 'plain' });
  const result = await t.check(account.id);

  assert.equal(result.check.early_risk, null);
  const stored = await t.repo.getAccount(account.id);
  assert.equal(stored.early_risk_level, null);
  for (const factor of result.check.factors) {
    assert.ok(!factor.key.startsWith('early_'), `unexpected early factor: ${factor.key}`);
  }
  for (const rec of result.check.recommendations) {
    assert.ok(!rec.key.startsWith('early_'), `unexpected early rec: ${rec.key}`);
  }
});

// ---------------------------------------------------------------- api

function fakeChecker() {
  return {
    busy: false,
    async checkAccount() {
      return this.busy ? null : { account: {}, check: {}, alerts: [] };
    },
    isChecking: () => false,
  };
}

const fakeScheduler = () => ({
  trigger() {
    return true;
  },
  status: () => ({ running: false, lastRunAt: null, nextRunAt: null, intervalMinutes: 60 }),
});

async function withServer(deps, fn) {
  const app = createApp({ log: silentLog, ...deps });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  try {
    await fn(call);
  } finally {
    server.close();
  }
}

const configured = () => ({
  checker: fakeChecker(),
  scheduler: fakeScheduler(),
  reddit: { verify: async () => {} },
});

test('PATCH /api/accounts/:id toggles stealth_mode', async () => {
  const repo = createMemoryRepo();
  const account = await repo.createAccount({ username: 'tester' });
  await withServer({ ...configured(), repo }, async (call) => {
    assert.equal((await call('GET', `/api/accounts/${account.id}`)).body.account.stealth_mode, false);
    const on = await call('PATCH', `/api/accounts/${account.id}`, { stealth_mode: true });
    assert.equal(on.status, 200);
    assert.equal(on.body.account.stealth_mode, true);
    const off = await call('PATCH', `/api/accounts/${account.id}`, { stealth_mode: false });
    assert.equal(off.body.account.stealth_mode, false);
  });
});

test('GET stealth/fingerprint returns fields, current and suggested', async () => {
  const repo = createMemoryRepo();
  const account = await repo.createAccount({ username: 'tester' });
  await withServer({ ...configured(), repo }, async (call) => {
    const res = await call('GET', `/api/accounts/${account.id}/stealth/fingerprint`);
    assert.equal(res.status, 200);
    assert.equal(res.body.stealth_mode, false);
    assert.equal(res.body.current, null);
    assert.deepEqual(res.body.fields.map((f) => f.key), ['userAgent', 'timezone', 'viewport', 'locale']);
    assert.equal(res.body.suggested.viewport, '1920x1080');
  });
});

test('PUT stealth/fingerprint validates and saves, preserving the warm-up plan', async () => {
  const repo = createMemoryRepo();
  const account = await repo.createAccount({ username: 'tester' });
  await withServer({ ...configured(), repo }, async (call) => {
    const bad = await call('PUT', `/api/accounts/${account.id}/stealth/fingerprint`, { userAgent: 'short' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /timezone/);

    const plan = createWarmupPlan(3, NOW);
    await repo.updateAccount(account.id, { fingerprint: { warmup: plan } });

    const ok = await call('PUT', `/api/accounts/${account.id}/stealth/fingerprint`, {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120',
      timezone: 'America/New_York',
      viewport: '1920x1080',
      locale: 'en-US',
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.account.fingerprint.timezone, 'America/New_York');
    assert.deepEqual(ok.body.account.fingerprint.warmup, plan, 'warm-up plan preserved');
  });
});

test('POST stealth/warmup/start requires stealth mode and creates a plan', async () => {
  const repo = createMemoryRepo();
  const account = await repo.createAccount({ username: 'tester' });
  await withServer({ ...configured(), repo }, async (call) => {
    assert.equal((await call('POST', `/api/accounts/${account.id}/stealth/warmup/start`)).status, 400);

    await repo.updateAccount(account.id, { stealth_mode: true });
    const started = await call('POST', `/api/accounts/${account.id}/stealth/warmup/start`);
    assert.equal(started.status, 200);
    assert.ok(started.body.plan.actions_target > 0);
    assert.equal(started.body.account.fingerprint.warmup.actions_done, 0);
  });
});

test('POST stealth/warmup/action records an action and advances the plan', async () => {
  const repo = createMemoryRepo();
  const account = await repo.createAccount({ username: 'tester' });
  const plan = createWarmupPlan(3, NOW);
  await repo.updateAccount(account.id, { stealth_mode: true, fingerprint: { warmup: plan } });
  await withServer({ ...configured(), repo }, async (call) => {
    const action = await call('POST', `/api/accounts/${account.id}/stealth/warmup/action`, { action: 'upvote' });
    assert.equal(action.status, 200);
    assert.equal(action.body.plan.actions_done, 1);
    const log = await call('GET', `/api/accounts/${account.id}/stealth/warmup/log`);
    assert.equal(log.body.log.length, 1);
    assert.equal(log.body.log[0].action, 'upvote');
    assert.equal(log.body.progress, Math.round((1 / plan.actions_target) * 100));
  });
});

test('POST stealth/warmup/action is 400 when the plan is complete', async () => {
  const repo = createMemoryRepo();
  const account = await repo.createAccount({ username: 'tester' });
  const done = { ...createWarmupPlan(3, NOW), actions_done: 28 };
  await repo.updateAccount(account.id, { stealth_mode: true, fingerprint: { warmup: done } });
  await withServer({ ...configured(), repo }, async (call) => {
    const res = await call('POST', `/api/accounts/${account.id}/stealth/warmup/action`, { action: 'upvote' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /complete/);
  });
});

test('DELETE stealth/warmup clears the plan and the log', async () => {
  const repo = createMemoryRepo();
  const account = await repo.createAccount({ username: 'tester' });
  const plan = createWarmupPlan(3, NOW);
  await repo.updateAccount(account.id, { stealth_mode: true, fingerprint: { warmup: plan } });
  await repo.insertWarmupLog(account.id, 'upvote');
  await withServer({ ...configured(), repo }, async (call) => {
    const cleared = await call('DELETE', `/api/accounts/${account.id}/stealth/warmup`);
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.account.fingerprint.warmup, undefined);
    const log = await call('GET', `/api/accounts/${account.id}/stealth/warmup/log`);
    assert.equal(log.body.log.length, 0);
    assert.equal(log.body.plan, null);
  });
});

test('stealth routes 404 for an unknown account', async () => {
  const repo = createMemoryRepo();
  await withServer({ ...configured(), repo }, async (call) => {
    const id = '00000000-0000-4000-8000-000000000000';
    assert.equal((await call('GET', `/api/accounts/${id}/stealth/fingerprint`)).status, 404);
    assert.equal((await call('POST', `/api/accounts/${id}/stealth/warmup/start`)).status, 404);
  });
});
