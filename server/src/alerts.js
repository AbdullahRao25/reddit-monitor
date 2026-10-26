// Deciding which alerts a health check should raise.
//
// Alerts fire on CHANGES (visible -> shadowbanned, elevated -> high, new
// removals), not on every check that finds a known problem, so an account
// that stays shadowbanned produces one alarm rather than one per hour.

import { SITEWIDE_STATUSES } from './content.js';

const LEVEL_RANK = { low: 0, elevated: 1, high: 2, critical: 3 };
const HIDDEN_STATUSES = new Set(['shadowbanned', 'suspended', 'not_found']);

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function deriveAlerts({
  account,
  status,
  assessment,
  earlyRisk = null,
  newlyRemoved = [],
  hiddenItems = null,
  previousHidden = 0,
  error = null,
  consecutiveErrors = 0,
}) {
  const name = `u/${account.username}`;
  const previous = account.status;
  const alerts = [];

  if (error) {
    if (consecutiveErrors >= 3) {
      alerts.push({
        severity: 'warning',
        type: 'check_failing',
        message: `Health checks for ${name} have failed ${consecutiveErrors} times in a row: ${error}`,
        details: { error },
      });
    }
    return alerts;
  }

  if (status === 'shadowbanned' && previous !== 'shadowbanned') {
    alerts.push({
      severity: 'critical',
      type: 'shadowban_suspected',
      message: `${name} looks shadowbanned: its profile is no longer visible to other users.`,
      details: {},
    });
  }

  if (status === 'suspended' && previous !== 'suspended') {
    alerts.push({
      severity: 'critical',
      type: 'suspended',
      message: `${name} has been suspended by Reddit.`,
      details: {},
    });
  }

  if (status === 'not_found' && previous !== 'not_found') {
    alerts.push({
      severity: 'warning',
      type: 'not_found',
      message:
        `${name} was not found on Reddit. Check the spelling; if it is right and you can still ` +
        'log in, the account was probably shadowbanned when it was created.',
      details: {},
    });
  }

  if (status === 'active' && HIDDEN_STATUSES.has(previous)) {
    alerts.push({
      severity: 'info',
      type: 'recovered',
      message: `${name} is publicly visible again.`,
      details: { previous },
    });
  }

  if (status === 'active' && assessment) {
    const before = LEVEL_RANK[account.risk_level] ?? 0;
    const after = LEVEL_RANK[assessment.level];
    if (after > before && after >= LEVEL_RANK.high) {
      const top = assessment.factors.find((factor) => factor.points > 0);
      const critical = assessment.level === 'critical';
      alerts.push({
        severity: critical ? 'critical' : 'warning',
        // Separate types so an open "rose to high" alert doesn't suppress
        // the later escalation to critical.
        type: critical ? 'risk_critical' : 'risk_high',
        message:
          `${name} risk rose to ${assessment.level} (score ${assessment.score})` +
          (top ? `. Biggest factor: ${top.label.toLowerCase()}.` : '.'),
        details: { from: account.risk_level, to: assessment.level, score: assessment.score },
      });
    }

    const sitewide = newlyRemoved.filter((row) => SITEWIDE_STATUSES.has(row.removal_status));
    const sample = (rows) =>
      rows.slice(0, 10).map((row) => ({
        id: row.id,
        subreddit: row.subreddit,
        permalink: row.permalink,
        removal_status: row.removal_status,
      }));

    if (sitewide.length > 0) {
      alerts.push({
        severity: 'warning',
        type: 'spam_filter_hit',
        message: `Reddit's spam filter removed ${plural(sitewide.length, 'new item')} by ${name}.`,
        details: { items: sample(sitewide) },
      });
    } else if (newlyRemoved.length >= 3) {
      alerts.push({
        severity: 'warning',
        type: 'removal_spike',
        message: `${plural(newlyRemoved.length, 'post/comment')} by ${name} were removed since the last check.`,
        details: { items: sample(newlyRemoved) },
      });
    }

    // Posts/comments the public can't see (hidden as they were posted, so
    // never in any listing). Raised when the count goes up, including on the
    // first check: unlike old removals, this describes the account right now.
    if (hiddenItems > previousHidden) {
      alerts.push({
        severity: 'warning',
        type: 'content_hidden',
        message:
          `${name} has ${plural(hiddenItems, 'post/comment')} that the public can't see. ` +
          `${hiddenItems === 1 ? 'It looks' : 'They look'} normal to the account itself but ${hiddenItems === 1 ? 'was' : 'were'} ` +
          "most likely filtered by a subreddit's AutoModerator or Reddit's spam filter.",
        details: { hidden: hiddenItems, previous: previousHidden },
      });
    }

    // Stealth mode: the early shadowban signal can cross a threshold while
    // the account is still fully visible. This is the whole point of the
    // layer — warn while the damage is still reversible. Same transition
    // logic as the risk alert: fire only when the level goes up and lands
    // in high/critical, and use separate types so an open "high" alert does
    // not suppress the later escalation to critical.
    if (earlyRisk && earlyRisk.level !== 'low' && earlyRisk.level !== 'elevated') {
      const beforeEarly = earlyRiskPrevLevel(account);
      const after = LEVEL_RANK[earlyRisk.level];
      if (after > beforeEarly && after >= LEVEL_RANK.high) {
        const top = earlyRisk.top;
        const critical = earlyRisk.level === 'critical';
        alerts.push({
          severity: critical ? 'critical' : 'warning',
          type: critical ? 'early_risk_critical' : 'early_risk_high',
          message:
            `${name} is showing early shadowban risk (${earlyRisk.level}, score ${earlyRisk.score})` +
            (top ? `. Strongest signal: ${top.label.toLowerCase()}.` : '.'),
          details: { from: beforeEarly, to: earlyRisk.level, score: earlyRisk.score },
        });
      }
    }
  }

  return alerts;
}

// The previous early-risk level is stored on the account row only as part
// of the latest check's `early_risk` jsonb. The account row itself does not
// carry it, so callers must pass it via `account.early_risk_level`, which
// the checker sets before calling deriveAlerts.
function earlyRiskPrevLevel(account) {
  return LEVEL_RANK[account.early_risk_level] ?? 0;
}
