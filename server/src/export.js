// Gets the data back out.
//
// Everything this app learns about an account is observed once and then only
// stored here: Reddit does not keep a record of what your profile looked like
// to a logged-out visitor last Tuesday, so if this database is the only copy
// and it is also the only way to read it, the history is hostage to one
// Supabase project. These exports are the way out — for a backup, for a
// spreadsheet, or for an appeal that needs dates.
//
// Pure: the routes read the rows, these functions shape them.

// One RFC 4180 field. Quotes are doubled, and a field is quoted whenever it
// contains a delimiter, a quote or a newline.
function csvField(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  // A leading =, +, - or @ makes Excel and Sheets treat the field as a
  // formula. Reddit text routinely starts with one, so it is prefixed with a
  // single quote: the cell still reads correctly and nothing is executed.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /["\n\r,]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/**
 * Rows to CSV, with an explicit column list so the file's shape is a
 * decision and not whatever keys the first row happened to have.
 */
export function toCsv(rows, columns) {
  const lines = [columns.map(csvField).join(',')];
  for (const row of rows) lines.push(columns.map((column) => csvField(row?.[column])).join(','));
  // CRLF: what RFC 4180 specifies and what Excel expects.
  return `${lines.join('\r\n')}\r\n`;
}

// The exportable tables and the columns each one writes.
export const EXPORT_COLUMNS = {
  checks: [
    'checked_at',
    'status',
    'risk_score',
    'risk_level',
    'link_karma',
    'comment_karma',
    'items_sampled',
    'items_removed',
    'newly_removed',
    'account_created_at',
    'error',
  ],
  content: [
    'id',
    'kind',
    'subreddit',
    'title',
    'permalink',
    'url_domain',
    'score',
    'created_at',
    'removal_status',
    'removed_by_category',
    'removal_detected_at',
    'first_seen_at',
  ],
  alerts: ['created_at', 'severity', 'type', 'message', 'acknowledged_at'],
};

// Derived, so a table can never be exportable without columns or the other
// way round.
export const EXPORT_TABLES = Object.keys(EXPORT_COLUMNS);

/**
 * A filename safe on every platform: no path separators, no colons (the ISO
 * timestamp's would break the download on Windows), and dated so two exports
 * of the same account do not overwrite each other.
 */
export function exportFilename(username, { table = null, extension, now = Date.now() }) {
  const day = new Date(now).toISOString().slice(0, 10);
  const name = String(username ?? 'account').replace(/[^A-Za-z0-9_-]/g, '');
  return [`u-${name || 'account'}`, table, day].filter(Boolean).join('-') + `.${extension}`;
}

/**
 * The JSON bundle: everything the dashboard knows about one account, plus the
 * provenance a reader needs to interpret it later.
 */
export function accountBundle({ account, checks, content, alerts, now = Date.now() }) {
  return {
    exported_at: new Date(now).toISOString(),
    // What a reader six months from now needs in order to trust the numbers:
    // these rows are one monitor's observations of the public view, not
    // Reddit's own records.
    source: 'reddit-monitor: observations of the logged-out public view of this profile',
    account: {
      id: account.id,
      username: account.username,
      label: account.label,
      notes: account.notes,
      status: account.status,
      risk_score: account.risk_score,
      risk_level: account.risk_level,
      link_karma: account.link_karma,
      comment_karma: account.comment_karma,
      paused: account.paused,
      stealth_mode: account.stealth_mode,
      check_interval_minutes: account.check_interval_minutes ?? null,
      last_checked_at: account.last_checked_at,
      last_seen_active_at: account.last_seen_active_at,
      created_at: account.created_at,
    },
    counts: { checks: checks.length, content: content.length, alerts: alerts.length },
    checks,
    content,
    alerts,
  };
}
