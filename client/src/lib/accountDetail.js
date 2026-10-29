const checkTime = check => Date.parse(check?.checked_at || check?.created_at || '') || 0;

// A finished manual check is newer evidence than a GET that captured an older
// snapshot. Keep it visible until detail polling catches up or observes a newer check.
export function reconcileManualCheck(detail, result) {
  if (!result?.check) return detail;
  const check = result.check;
  const observed = Math.max(checkTime(detail?.latestCheck), checkTime(detail?.lastError));
  if (observed >= checkTime(check)) return detail;
  const previous = detail || {};
  const diagnostics = check.diagnostics || check.factors?.find(factor => factor.key === 'reader_error')?.diagnostics || null;
  const failed = Boolean(check.error);
  const history = previous.history || [];
  const historyCheck = {...check, created_at:check.checked_at, karma:result.account?.karma ?? null};
  return {
    ...previous,
    account:{...previous.account,...result.account},
    latestCheck:failed ? previous.latestCheck || null : check,
    lastError:failed ? {checked_at:check.checked_at,error:check.error,diagnostics} : null,
    stale:failed,
    last_successful_check_at:failed ? previous.last_successful_check_at || previous.latestCheck?.checked_at || null : check.checked_at,
    history:failed || history.some(row => checkTime(row) === checkTime(check)) ? history : [...history,historyCheck],
  };
}
