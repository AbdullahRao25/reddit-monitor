// Warm-up scheduler for stealth mode.
//
// New or dormant Reddit accounts are treated as suspicious by Reddit's spam
// systems. A warm-up schedule gradually builds the account's activity
// history with low-risk actions (upvotes, short comments on high-karma
// threads) so the account looks like a normal human before it starts doing
// the "real" work (posting, commenting in target subreddits).
//
// The scheduler:
//   - Runs on a fixed interval (default: 60 min, same as the main checker).
//   - For each account with stealth_mode=true and a warm-up plan, performs
//     1–3 low-stakes actions per run.
//   - Tracks progress: each action is logged to warmup_log.
//   - Stops automatically when the account reaches the "mature" threshold
//     (30 days old AND 100+ total karma).
//   - Can be paused per-account by clearing the warm-up plan.
//
// The warm-up plan is stored in accounts.fingerprint as a sibling key
// `warmup` (or could be a separate column; for now it lives in the same
// jsonb to keep the schema simple).
//
// Plan shape: {
//   started_at: ISO string,
//   target_at:  ISO string,    // when warm-up should be complete
//   actions_done: number,
//   actions_target: number,    // total actions to perform
//   daily_actions: number,     // actions per day
// }

import { fingerprintConsistencyScore } from './fingerprint.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// An account is "mature" after this many days and this much total karma.
const MATURE_AGE_DAYS = 30;
const MATURE_KARMA = 100;

// Actions the warm-up scheduler can perform. These are low-stakes,
// low-visibility actions that build activity history without drawing
// attention.
const WARMUP_ACTIONS = [
  { key: 'upvote', label: 'Upvote a high-karma post', risk: 'low' },
  { key: 'comment', label: 'Post a short comment on a high-karma thread', risk: 'low' },
  { key: 'view_profile', label: 'View a few user profiles', risk: 'low' },
  { key: 'browse_sub', label: 'Browse a subscribed subreddit', risk: 'low' },
];

// Creates a warm-up plan for an account.
// accountAgeDays: how old the account is (days).
// Returns a plan object ready to persist.
export function createWarmupPlan(accountAgeDays, now = Date.now()) {
  const age = Math.max(0, accountAgeDays);
  // Newer accounts need a longer, slower warm-up.
  const targetDays = age < 7 ? 14 : age < 30 ? 10 : 7;
  const dailyActions = age < 7 ? 2 : age < 30 ? 3 : 4;
  const totalActions = dailyActions * targetDays;

  return {
    started_at: new Date(now).toISOString(),
    target_at: new Date(now + targetDays * DAY).toISOString(),
    actions_done: 0,
    actions_target: totalActions,
    daily_actions: dailyActions,
  };
}

// Checks whether an account is mature enough to stop warming up.
export function isMature(account, profile) {
  const ageDays = profile?.createdAt ? (Date.now() - profile.createdAt) / DAY : null;
  const totalKarma = (profile?.linkKarma ?? 0) + (profile?.commentKarma ?? 0);
  if (ageDays === null) return false;
  return ageDays >= MATURE_AGE_DAYS && totalKarma >= MATURE_KARMA;
}

// Decides what to do on a warm-up run for one account.
// Returns { action, detail } or null if no action is due.
//
// account: the accounts row (with stealth_mode, fingerprint).
// profile: the latest profile data from a check (or null).
// warmupLog: recent warm-up actions (newest first).
export function nextWarmupAction(account, profile, warmupLog, now = Date.now()) {
  if (!account.stealth_mode) return null;
  if (isMature(account, profile)) return null;

  const plan = account.fingerprint?.warmup;
  if (!plan || plan.actions_done >= plan.actions_target) return null;

  // Check daily cap: don't do more than daily_actions in the last 24h.
  const recentActions = warmupLog.filter(
    (row) => now - Date.parse(row.performed_at) <= DAY,
  );
  if (recentActions.length >= plan.daily_actions) return null;

  // Pick an action: weighted random, avoiding the last one.
  const lastKey = warmupLog[0]?.action;
  const available = WARMUP_ACTIONS.filter((a) => a.key !== lastKey);
  const pool = available.length > 0 ? available : WARMUP_ACTIONS;
  const action = pool[Math.floor(Math.random() * pool.length)];

  return {
    action: action.key,
    label: action.label,
    detail: `Warm-up action ${plan.actions_done + 1} of ${plan.actions_target}.`,
  };
}

// Updates the plan after an action is performed.
export function recordWarmupAction(plan, now = Date.now()) {
  return {
    ...plan,
    actions_done: plan.actions_done + 1,
  };
}

// Returns the progress of a warm-up plan as a 0–100 number.
export function warmupProgress(plan) {
  if (!plan || plan.actions_target === 0) return 0;
  return Math.min(100, Math.round((plan.actions_done / plan.actions_target) * 100));
}

// Builds the stealth-specific recommendations that the dashboard shows
// when stealth mode is ON. These are added to the compliance-oriented
// recommendations from risk.js.
export function stealthRecommendations(account, profile, assessment, warmupLog) {
  const recs = [];
  const plan = account.fingerprint?.warmup;

  // 1. Warm-up in progress
  if (account.stealth_mode && plan && plan.actions_done < plan.actions_target) {
    const progress = warmupProgress(plan);
    const daysLeft = Math.max(0, Math.ceil((Date.parse(plan.target_at) - Date.now()) / DAY));
    recs.push({
      key: 'warmup_in_progress',
      priority: 'normal',
      title: `Warm-up in progress (${progress}%)`,
      body:
        `The account is on a ${plan.actions_target}-action warm-up plan, ` +
        `${plan.actions_done} actions done, ~${daysLeft} day(s) left. ` +
        'Avoid heavy posting until the plan is complete.',
    });
  }

  // 2. Warm-up complete
  if (account.stealth_mode && plan && plan.actions_done >= plan.actions_target) {
    recs.push({
      key: 'warmup_complete',
      priority: 'normal',
      title: 'Warm-up complete',
      body:
        'The warm-up plan is finished. The account can now resume normal activity. ' +
        'Keep posting in 1–2 subreddits per day to stay consistent.',
    });
  }

  // 3. No warm-up plan (stealth ON but no plan)
  if (account.stealth_mode && !plan && profile?.createdAt) {
    const ageDays = Math.floor((Date.now() - profile.createdAt) / DAY);
    if (ageDays < MATURE_AGE_DAYS) {
      recs.push({
        key: 'no_warmup_plan',
        priority: 'high',
        title: 'Start a warm-up plan',
        body:
          `The account is ${ageDays} days old and stealth mode is ON, but there is no ` +
          'warm-up plan. New accounts get the strictest spam filtering; a warm-up ' +
          'plan builds activity history gradually.',
      });
    }
  }

  // 4. Fingerprint mismatch
  if (account.stealth_mode && account.fingerprint) {
    const score = fingerprintConsistencyScore(account, account.fingerprint);
    if (score !== null && score < 70) {
      recs.push({
        key: 'fingerprint_mismatch',
        priority: 'high',
        title: 'Fingerprint does not match posting pattern',
        body:
          `The saved fingerprint scores ${score}/100 against the account's posting history. ` +
          'Check that the timezone and User-Agent match the environment you actually ' +
          'use when posting from this account.',
      });
    }
  }

  // 5. Stealth mode ON but account is shadowbanned
  if (account.stealth_mode && assessment?.level === 'critical') {
    recs.push({
      key: 'stealth_shadowban',
      priority: 'urgent',
      title: 'Shadowbanned while in stealth mode',
      body:
        'The account is shadowbanned. Pause all activity, rotate to a different ' +
        'fingerprint environment (different timezone, User-Agent, and viewport), ' +
        'and wait at least 48 hours before resuming warm-up.',
    });
  }

  // 6. Stealth mode ON and risk is high
  if (account.stealth_mode && assessment?.level === 'high') {
    recs.push({
      key: 'stealth_high_risk',
      priority: 'high',
      title: 'High risk in stealth mode',
      body:
        'Reduce activity for 24–48 hours. Avoid posting in new subreddits and ' +
        'stick to the 1–2 communities where the account has existing karma. ' +
        'Check the fingerprint for consistency.',
    });
  }

  return recs;
}
