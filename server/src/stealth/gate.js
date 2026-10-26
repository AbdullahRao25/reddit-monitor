// The active shield gate.
//
// A passive shield (the draft queue) tells you, after the fact, whether
// something you already posted got hit. This is the other half: a gate that
// stands between the account and Reddit's spam systems and decides, at the
// moment an action is about to leave, whether it may go out right now — and,
// if so, makes it look like the account's own browser doing it.
//
// Every call to `gateDecision()` answers one of three things:
//
//   pass  — a safe slot is open. The action may go out now. The decision
//           carries the headers the outbound request must carry so the
//           request's fingerprint matches the one the account claims
//           (accounts.fingerprint), plus a pacing token the client can
//           present to prove it is the holder of this exact decision.
//
//   hold  — pacing says "not yet." The action is fine, it is just not the
//           moment: the local hour is in the account's dead of night, or the
//           account is still inside the cool-down it owes itself after a
//           removal, or it has spent its fair share of actions for the
//           period. The decision carries `next_safe_at` — the earliest time
//           the same action could pass — and the caller queues it. Holds
//           fail open: nothing was wrong, it is simply not time.
//
//   block — danger. The account is in the critical band, just saw a removal
//           spike, or was restricted. Firing an action now would feed the
//           very signal that is already building against it. The decision
//           fails closed and names the reason.
//
// "Danger" is not re-invented here: it is the same `interventionFor()`
// verdict the monitor already computes on every check (shield/policy.js).
// Only a `critical` intervention blocks; a `review`-severity one (three
// failed checks) means "look at your connection," not "freeze the account,"
// so it holds at most, never blocks.
//
// Everything here is pure. It takes the account row, the latest check
// (or a pre-computed intervention), the pacing state and the fingerprint,
// and returns the decision. The routes around it (app.js) own persistence:
// they are the ones that insert a queue row on a hold, release it, and audit
// the outcome. That keeps this file testable with a memory repo and no clock
// of its own.

import { randomUUID } from 'node:crypto';
import { interventionFor } from '../shield/policy.js';
import { localHourIn } from '../behavior.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// The account's plausible posting window, in its own local time. Reddit reads
// a 3 am post as a bot post; a human reads it the same way. A window is a
// [startHour, endHour) range on the 24-hour clock; a wrap (e.g. 21 → 5)
// means "from 21:00 to 05:00."
//
// These are the edges of plausibility, not a personality. A fingerprint can
// narrow the window per account if the owner knows when their human is up,
// but this is the safe default: 08:00–22:00 local.
const DEFAULT_WINDOW_START = 8;
const DEFAULT_WINDOW_END = 22;

// How long an account owes itself a cool-down after Reddit removed something
// of its. Mirrors the earlyRisk COOLDOWN_WINDOW (3 days): that is the
// "pause immediately after a removal" advice, made into a gate.
const POST_REMOVAL_COOLDOWN = 3 * DAY;

// Pacing: the account is allowed at most this many gated actions per rolling
// day, with humanised jitter between them. A fixed interval is itself a tell
// (the OAuth client's ≥700 ms floor already reads machine-like), so the gap
// between two releases is drawn from a range, never a constant.
const ACTIONS_PER_DAY = 8;
const MIN_GAP = 20 * 60 * 1000; // 20 min
const MAX_GAP = 75 * 60 * 1000; // 75 min

// Verdicts.
const PASS = 'pass';
const HOLD = 'hold';
const BLOCK = 'block';

function clampHour(value) {
  const hour = Number(value);
  return Number.isFinite(hour) ? Math.min(23, Math.max(0, Math.floor(hour))) : null;
}

// The account's posting window: an optional pair of fingerprint overrides
// (posting_window: [start, end]) or the safe default.
function postingWindow(fingerprint) {
  const raw = Array.isArray(fingerprint?.posting_window) ? fingerprint.posting_window : null;
  const start = clampHour(raw?.[0] ?? DEFAULT_WINDOW_START);
  const end = clampHour(raw?.[1] ?? DEFAULT_WINDOW_END);
  return { start: start ?? DEFAULT_WINDOW_START, end: end ?? DEFAULT_WINDOW_END };
}

// Is this local hour inside the window? Handles the 21 → 5 wrap.
function inWindow(hour, { start, end }) {
  if (hour === null) return null; // unknown zone → can't decide, don't guess
  if (start <= end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

// The earliest moment, at or after `now`, that is inside the window in the
// account's timezone. Returns null when the zone is unknown.
function nextInWindow(now, timezone, window) {
  if (!timezone) return null;
  // Walk the day at 15-minute steps from now up to 48h out; the first local
  // hour that lands in-window is the answer. 15-min steps keep this cheap and
  // accurate to the quarter hour, which is all a human notice needs.
  const step = 15 * 60 * 1000;
  for (let t = now; t <= now + 48 * HOUR; t += step) {
    const hour = localHourIn(t, timezone);
    if (inWindow(hour, window)) return t;
  }
  return null;
}

// The account's timezone: the fingerprint claims one, the profile may hint
// at another. The fingerprint wins — that is the identity the gate is
// shaping requests to look like.
function timezoneOf(account) {
  return account?.fingerprint?.timezone || account?.timezone_hint || null;
}

// Headers a request for this account must carry. Kept deliberately small and
// mutually consistent: a browser that claims a locale sends the matching
// accept-language, a platform in its UA must not be contradicted elsewhere,
// and the timezone is exposed through a header a real client would set.
export function gateHeaders(fingerprint, timezone) {
  const fp = fingerprint ?? {};
  const ua = fp.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const locale = fp.locale || 'en-US';
  return {
    'user-agent': ua,
    'accept-language': locale,
    // A real client reports its time zone so the server can render times.
    'x-time-zone': timezone || fp.timezone || '',
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-encoding': 'gzip, deflate, br',
  };
}

// The pacing state for one account. `releases` is the list of timestamps
// (ms) the account's last actions were cleared for. Callers persist this —
// the queue rows in stealth_gate_queue are the durable form; the in-flight
// caller passes the recent ones so the decision is stateless here.
function recentReleases(releases = [], now, within = DAY) {
  return (releases ?? [])
    .filter((t) => Number.isFinite(t) && now - t < within)
    .sort((a, b) => a - b);
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

// The earliest this action may be released, given the pacing state:
//   - at least MIN_GAP after the last release (with jitter up to MAX_GAP),
//   - and not before the account has room in its daily budget.
// Returns { next_at, reason } where reason is null when the account is
// ready right now.
function nextRelease(releases, now) {
  const recent = recentReleases(releases, now);
  if (recent.length >= ACTIONS_PER_DAY) {
    // Budget exhausted: wait until the oldest of the last N releases ages
    // out of the rolling day.
    const oldest = recent[recent.length - ACTIONS_PER_DAY];
    const next_at = oldest + DAY;
    return { next_at, reason: `Daily budget of ${ACTIONS_PER_DAY} gated actions reached; next slot opens when the earliest one ages out.` };
  }
  if (recent.length > 0) {
    const last = recent[recent.length - 1];
    const gap = randomBetween(MIN_GAP, MAX_GAP);
    const ready = last + gap;
    if (ready > now) {
      return { next_at: ready, reason: `Still inside the ${Math.round(gap / 60000)}-minute cool-down after the last release.` };
    }
  }
  return { next_at: now, reason: null };
}

/**
 * Decide whether a single action may go out for an account right now.
 *
 * account:      the accounts row (stealth_mode, fingerprint, timezone_hint,
 *               status).
 * check:        the latest non-error health_checks row, or null. Used to
 *               derive the danger intervention.
 * intervention: a pre-computed interventionFor() result. If given, it is
 *               used as-is; otherwise it is derived from `check`+`account`.
 * releases:     timestamps of the account's most recent cleared actions
 *               (pacing input).
 * now:          current time in ms.
 *
 * Returns:
 *   verdict:        'pass' | 'hold' | 'block'
 *   reasons:        human-readable strings for the decision (may be several)
 *   next_safe_at:   ms timestamp the action could pass, or null when it may
 *                   pass now (pass) or never until a human decides (block)
 *   headers:        the fingerprint-coherent headers for a passing action,
 *                   or null on hold/block (they are computed at pass time so
 *                   the fingerprint the client sends can be the one that
 *                   was actually approved)
 *   token:          a UUID the caller persists and the client presents back
 *                   to claim this specific decision; null on block
 *   intervention:   the danger verdict that applied, if any
 */
export function gateDecision({
  account,
  check = null,
  intervention: interventionArg = null,
  releases = [],
  now = Date.now(),
}) {
  const reasons = [];
  const intervention = interventionArg ?? interventionFor({ check, account, consecutiveErrors: 0 });

  // 1. Danger — fail closed first. Only a critical intervention blocks;
  //    a review-severity one is a soft hold (see below).
  if (intervention && intervention.severity === 'critical') {
    return {
      verdict: BLOCK,
      reasons: [intervention.reason],
      next_safe_at: null,
      headers: null,
      token: null,
      intervention,
    };
  }

  // 2. Danger-soft — a review-severity intervention holds, it does not
  //    block: the account is not restricted, the monitor just can't see it
  //    clearly right now. Next safe = a little later, when a check lands.
  if (intervention && intervention.severity === 'review') {
    const next_at = now + HOUR;
    return {
      verdict: HOLD,
      reasons: [`Soft hold — ${intervention.reason}`],
      next_safe_at: next_at,
      headers: null,
      token: randomUUID(),
      intervention,
    };
  }

  // 3. Post-removal cool-down. If Reddit removed something of this account
  //    within the last three days, the account owes itself a pause. The
  //    latest check's items_removed + newly_removed is the public trace.
  const removals = Number(check?.newly_removed ?? 0);
  if (check && !check.error && removals > 0) {
    // We do not store "when the removal happened" per check, only the count.
    // The check's own timestamp is the best we have: if a check within the
    // cool-down window reports removals, the account is still in it.
    const checkAge = now - Date.parse(check.checked_at);
    if (checkAge <= POST_REMOVAL_COOLDOWN) {
      const next_at = Date.parse(check.checked_at) + POST_REMOVAL_COOLDOWN;
      reasons.push(`In the ${Math.round(POST_REMOVAL_COOLDOWN / DAY)}-day cool-down after ${removals} recent removal${removals === 1 ? '' : 's'}; the gate holds until the cool-down ends.`);
      // Still run the pacing / window checks below; the later of the two
      // wins, because the account must satisfy both to pass.
      // We capture the cool-down floor and merge with the pacing result.
      const pacing = nextRelease(releases, now);
      const window = postingWindow(account?.fingerprint);
      const tz = timezoneOf(account);
      const inWin = tz ? inWindow(localHourIn(now, tz), window) : true;
      const windowFloor = !inWin ? (nextInWindow(now, tz, window) ?? next_at) : null;
      const merged = [next_at, pacing.next_at, windowFloor].filter((t) => t != null && t > now);
      const mergedNext = merged.length ? Math.max(...merged) : null;
      return {
        verdict: HOLD,
        reasons,
        next_safe_at: mergedNext,
        headers: null,
        token: randomUUID(),
        intervention,
      };
    }
  }

  // 4. Posting window. Outside the account's local waking hours, hold until
  //    the window reopens.
  const tz = timezoneOf(account);
  const window = postingWindow(account?.fingerprint);
  const hourNow = tz ? localHourIn(now, tz) : null;
  const inWin = hourNow === null ? true : inWindow(hourNow, window);
  if (!inWin) {
    const next_at = nextInWindow(now, tz, window);
    reasons.push(`Outside the ${tz} posting window (${window.start}:00–${window.end}:00); the gate holds until the window reopens.`);
    // Pacing may push the slot further out; merge.
    const pacing = nextRelease(releases, now);
    const merged = [next_at, pacing.next_at].filter((t) => t != null && t > now);
    return {
      verdict: HOLD,
      reasons,
      next_safe_at: merged.length ? Math.max(...merged) : null,
      headers: null,
      token: randomUUID(),
      intervention,
    };
  }

  // 5. Pacing. Even inside the window and with no danger, the account is
  //    allowed only so many actions, spaced with jitter.
  const pacing = nextRelease(releases, now);
  if (pacing.reason) {
    reasons.push(pacing.reason);
    return {
      verdict: HOLD,
      reasons,
      next_safe_at: pacing.next_at,
      headers: null,
      token: randomUUID(),
      intervention,
    };
  }

  // 6. Pass.
  return {
    verdict: PASS,
    reasons: ['Safe slot: inside the posting window, clear of danger, pacing budget available.'],
    next_safe_at: now,
    headers: gateHeaders(account?.fingerprint, tz),
    token: randomUUID(),
    intervention,
  };
}
