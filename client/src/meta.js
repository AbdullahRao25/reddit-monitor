// Display metadata. `tone` maps to the status palette (good / warning /
// serious / critical / neutral); every tone is shown with an icon and a
// text label, never by colour alone.

export const STATUS_META = {
  pending: { label: 'Not checked yet', icon: 'clock', tone: 'neutral' },
  active: { label: 'Visible', icon: 'eye', tone: 'good' },
  shadowbanned: { label: 'Shadowbanned', icon: 'eyeOff', tone: 'critical' },
  suspended: { label: 'Suspended', icon: 'ban', tone: 'critical' },
  not_found: { label: 'Not found', icon: 'help', tone: 'serious' },
  error: { label: 'Check failed', icon: 'alert', tone: 'warning' },
};

export const LEVEL_META = {
  low: { label: 'Low risk', icon: 'check', tone: 'good' },
  elevated: { label: 'Elevated', icon: 'alert', tone: 'warning' },
  high: { label: 'High risk', icon: 'alert', tone: 'serious' },
  critical: { label: 'Critical', icon: 'octagon', tone: 'critical' },
};

export const SEVERITY_META = {
  info: { label: 'Info', icon: 'info', tone: 'neutral' },
  warning: { label: 'Warning', icon: 'alert', tone: 'warning' },
  critical: { label: 'Critical', icon: 'octagon', tone: 'critical' },
};

export const PRIORITY_META = {
  urgent: { label: 'Do now', icon: 'octagon', tone: 'critical' },
  high: { label: 'Important', icon: 'alert', tone: 'serious' },
  normal: { label: 'Suggested', icon: 'info', tone: 'neutral' },
};

export const REMOVAL_META = {
  spam_filtered: { label: "Reddit's spam filter", icon: 'octagon', tone: 'critical' },
  removed_by_admin: { label: 'Reddit admins', icon: 'octagon', tone: 'critical' },
  removed_by_mod: { label: 'Subreddit moderators', icon: 'alert', tone: 'serious' },
  removed: { label: 'Removed', icon: 'alert', tone: 'serious' },
  deleted_by_author: { label: 'Deleted by you', icon: 'info', tone: 'neutral' },
  visible: { label: 'Visible', icon: 'eye', tone: 'good' },
};

export const STEALTH_META = {
  on: { label: 'Stealth on', icon: 'fingerprint', tone: 'neutral' },
  off: { label: 'Stealth off', icon: 'eyeOff', tone: 'neutral' },
};

// Worst first: hidden accounts, then by risk score.
export function accountSeverity(account) {
  if (account.status === 'shadowbanned' || account.status === 'suspended') return 200;
  if (account.status === 'not_found') return 150;
  return account.risk_score ?? -1;
}
