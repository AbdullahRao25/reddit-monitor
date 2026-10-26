import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveAlerts } from '../src/alerts.js';

const account = (overrides = {}) => ({ username: 'tester', status: 'active', risk_level: 'low', ...overrides });
const assessment = (level, score, factors = [{ label: 'High removal rate', points: 20 }]) => ({
  level,
  score,
  factors,
  recommendations: [],
});
const types = (alerts) => alerts.map((a) => a.type);

test('rising into high or critical alerts; smaller rises do not', () => {
  assert.deepEqual(types(deriveAlerts({ account: account(), status: 'active', assessment: assessment('elevated', 30) })), []);
  const high = deriveAlerts({ account: account(), status: 'active', assessment: assessment('high', 55) });
  assert.deepEqual(types(high), ['risk_high']);
  assert.equal(high[0].severity, 'warning');
  assert.match(high[0].message, /Biggest factor: high removal rate/);
});

test('high -> critical is its own alert type, so an open "high" alert cannot suppress it', () => {
  const alerts = deriveAlerts({
    account: account({ risk_level: 'high' }),
    status: 'active',
    assessment: assessment('critical', 90),
  });
  assert.deepEqual(types(alerts), ['risk_critical']);
  assert.equal(alerts[0].severity, 'critical');
});

test('staying at the same level does not re-alert', () => {
  assert.deepEqual(
    types(deriveAlerts({ account: account({ risk_level: 'critical' }), status: 'active', assessment: assessment('critical', 95) })),
    [],
  );
});

test('spam-filter removals take precedence over a generic removal spike', () => {
  const newlyRemoved = [
    { id: 't3_a', removal_status: 'spam_filtered' },
    { id: 't3_b', removal_status: 'removed_by_mod' },
    { id: 't3_c', removal_status: 'removed_by_mod' },
  ];
  const alerts = deriveAlerts({ account: account(), status: 'active', assessment: assessment('low', 10), newlyRemoved });
  assert.deepEqual(types(alerts), ['spam_filter_hit']);
  assert.match(alerts[0].message, /1 new item by u\/tester/);
});

const earlyRisk = (level, score, topLabel) => ({
  score,
  level,
  top: { key: 'early_new_account', label: topLabel, points: 25 },
});

test('early_risk_high fires the first time the early score crosses into high', () => {
  for (const prev of [null, 'low', 'elevated']) {
    const alerts = deriveAlerts({
      account: account({ risk_level: 'low', early_risk_level: prev }),
      status: 'active',
      assessment: assessment('low', 10),
      earlyRisk: earlyRisk('high', 60, 'Very new account'),
    });
    assert.deepEqual(types(alerts), ['early_risk_high'], `prev=${prev}`);
    assert.equal(alerts[0].severity, 'warning');
    assert.match(alerts[0].message, /early shadowban risk \(high, score 60\)/);
    assert.match(alerts[0].message, /very new account/);
    // The previous level is reported as a rank: low/unknown 0, elevated 1.
    assert.deepEqual(alerts[0].details, { from: prev === 'elevated' ? 1 : 0, to: 'high', score: 60 });
  }
});

test('early_risk_critical fires when the early level escalates from high to critical', () => {
  const alerts = deriveAlerts({
    account: account({ risk_level: 'low', early_risk_level: 'high' }),
    status: 'active',
    assessment: assessment('low', 10),
    earlyRisk: earlyRisk('critical', 85, 'No pause after a removal'),
  });
  assert.deepEqual(types(alerts), ['early_risk_critical']);
  assert.equal(alerts[0].severity, 'critical');
  assert.deepEqual(alerts[0].details, { from: 2, to: 'critical', score: 85 });
});

test('early_risk_critical also fires on a direct jump from low into critical', () => {
  const alerts = deriveAlerts({
    account: account({ risk_level: 'low', early_risk_level: null }),
    status: 'active',
    assessment: assessment('low', 10),
    earlyRisk: earlyRisk('critical', 90, 'Removed by Reddit\'s spam filter'),
  });
  assert.deepEqual(types(alerts), ['early_risk_critical']);
  assert.equal(alerts[0].severity, 'critical');
});

test('early risk at low or elevated never alerts, and the same level does not re-alert', () => {
  assert.deepEqual(
    types(
      deriveAlerts({
        account: account({ early_risk_level: 'low' }),
        status: 'active',
        assessment: assessment('low', 10),
        earlyRisk: earlyRisk('elevated', 30, 'Young account'),
      }),
    ),
    [],
  );
  assert.deepEqual(
    types(
      deriveAlerts({
        account: account({ early_risk_level: 'high' }),
        status: 'active',
        assessment: assessment('low', 10),
        earlyRisk: earlyRisk('high', 62, 'Very new account'),
      }),
    ),
    [],
  );
  assert.deepEqual(
    types(
      deriveAlerts({
        account: account({ early_risk_level: 'critical' }),
        status: 'active',
        assessment: assessment('low', 10),
        earlyRisk: earlyRisk('critical', 91, 'Removed by Reddit\'s spam filter'),
      }),
    ),
    [],
  );
});

test('early-risk alerts only fire while the account is active and the check succeeded', () => {
  assert.deepEqual(
    types(
      deriveAlerts({
        account: account({ early_risk_level: null }),
        status: 'active',
        assessment: assessment('low', 10),
        earlyRisk: null,
      }),
    ),
    [],
  );
  // Suspended: the status alert fires, but the early block is skipped.
  const suspended = deriveAlerts({
    account: account({ early_risk_level: null }),
    status: 'suspended',
    assessment: assessment('low', 10),
    earlyRisk: earlyRisk('high', 60, 'Very new account'),
  });
  assert.deepEqual(types(suspended), ['suspended']);
});

test('errors only alert after repeated failures', () => {
  assert.deepEqual(types(deriveAlerts({ account: account(), error: 'boom', consecutiveErrors: 2 })), []);
  assert.deepEqual(types(deriveAlerts({ account: account(), error: 'boom', consecutiveErrors: 3 })), ['check_failing']);
});
