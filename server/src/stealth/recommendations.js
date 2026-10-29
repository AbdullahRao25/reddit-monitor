// Stealth-mode recommendations.
//
// These are the advice lines the checker appends to the compliance
// recommendations, but only for accounts that opted into stealth mode.
//
// They used to live in warmup.js alongside an artificial warm-up scheduler
// that drove synthetic upvotes and filler comments to build "activity
// history". That scheduler is gone — these three survived it because none of
// them is about manufacturing engagement: they read what the account already
// did and say something about it.

import { fingerprintConsistencyScore } from './fingerprint.js';

/**
 * account:    the accounts row (stealth_mode, fingerprint, timezone_hint).
 * assessment: the risk assessment from risk.js, for its `level`.
 *
 * Returns recommendation objects in the same shape risk.js produces, so the
 * checker can concatenate the two lists.
 */
export function stealthRecommendations(account, assessment) {
  const recs = [];
  if (!account?.stealth_mode) return recs;

  // The declared environment does not match when the account actually posts.
  if (account.fingerprint) {
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

  if (assessment?.level === 'critical') {
    recs.push({
      key: 'stealth_shadowban',
      priority: 'urgent',
      title: 'Restricted while in stealth mode',
      body:
        'The account is in the critical band. Pause all activity for at least 48 hours, ' +
        'confirm the restriction from a logged-out browser, and review the official ' +
        'appeal route before posting again.',
    });
  }

  if (assessment?.level === 'high') {
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
