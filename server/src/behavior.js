// Behavioral risk signals: how the account acts, not just what happened to
// it. Two things Reddit's spam systems act on that the other risk factors
// miss:
//
//   - Posting at hours that contradict the account's own local timezone.
//     An account that posts at 3 am in its claimed timezone looks
//     automated or run from a machine in another country.
//
//   - Posting again right after a removal. Spam-filter hits are strongest
//     when the same behaviour continues; a pause lets the filter's
//     confidence in the account recover.
//
// Both are computed from the items the checker already collects, so no new
// data is needed. The timezone comes from the account's stealth fingerprint
// when it has one, otherwise from the `timezone_hint` field. Without either
// there is nothing to compare against and the signal is skipped.

import { SITEWIDE_STATUSES } from './content.js';

const DAY = 24 * 60 * 60 * 1000;

// Local hours 0..5: the middle of the night for any human.
const NIGHT_END = 6;
// Enough recent activity for a share to mean anything.
const MIN_SAMPLE = 5;
// A pause is worth asking for if a removal landed within this window.
const COOLDOWN_WINDOW = 3 * DAY;

// The local hour of a timestamp in an IANA timezone, or null when the zone
// is unknown to this runtime (a typo in the fingerprint should not crash a
// check).
export function localHourIn(timestamp, timeZone) {
  try {
    const hour = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone,
    })
      .formatToParts(new Date(timestamp))
      .find((part) => part.type === 'hour')?.value;
    return hour === undefined ? null : Number(hour);
  } catch {
    return null;
  }
}

// Share of timestamps whose local hour in `timeZone` falls in 0..NIGHT_END.
export function midnightShare(timestamps, timeZone) {
  if (!timeZone) return null;
  let night = 0;
  let known = 0;
  for (const timestamp of timestamps) {
    const hour = localHourIn(timestamp, timeZone);
    if (hour === null) continue;
    known++;
    if (hour >= 0 && hour < NIGHT_END) night++;
  }
  return known ? night / known : null;
}

// Returns { factors, recs } in the same shape assessRisk builds. `items` are
// the checker's recent items ({ createdAt, removalStatus }), `timezone` an
// IANA zone or null, `now` in ms.
export function behaviorFactors({ items = [], timezone = null, now = Date.now() }) {
  const factors = [];
  const recs = [];

  const recent = items.filter((item) => now - item.createdAt <= 30 * DAY);

  // 1. Posting in the local middle of the night.
  if (timezone) {
    const share = midnightShare(recent.map((item) => item.createdAt), timezone);
    if (share !== null && recent.length >= MIN_SAMPLE && share >= 0.5) {
      const nightCount = Math.round(share * recent.length);
      factors.push({
        key: 'night_posting',
        label: 'Posting in the middle of the local night',
        points: 10,
        detail: `${nightCount} of ${recent.length} recent posts/comments landed between 12 am and 6 am in ${timezone}. Humans rarely post there; it makes the account look automated.`,
      });
      recs.push({
        key: 'fix_posting_hours',
        priority: 'normal',
        title: 'Post during waking hours in the claimed timezone',
        body: `Move this account's activity into normal waking hours in ${timezone}. ` +
          'Reddit correlates posting hours with the account and fingerprint; a pattern ' +
          'that is 2–5 am in its own timezone is one of the clearest bot signals.',
      });
    }
  }

  // 2. No pause after a removal.
  const freshRemoval = recent
    .filter((item) => SITEWIDE_STATUSES.has(item.removalStatus) && now - item.createdAt <= COOLDOWN_WINDOW)
    .length;
  const sinceRemoval = recent.filter(
    (item) => item.createdAt > now - COOLDOWN_WINDOW && !SITEWIDE_STATUSES.has(item.removalStatus),
  ).length;
  if (freshRemoval > 0 && sinceRemoval >= 3) {
    recs.push({
      key: 'post_removal_cooldown',
      priority: 'high',
      title: 'Pause for a few days after the recent removals',
      body: `${freshRemoval} item${freshRemoval === 1 ? ' was' : 's were'} removed by Reddit within the last 3 days, and the account has kept posting (${sinceRemoval} more since). Continuing the same activity straight after a removal is what turns a single filter hit into a shadowban. Post little or nothing for a few days, and make sure what comes next does not repeat the removed pattern.`,
    });
  }

  return { factors, recs };
}
