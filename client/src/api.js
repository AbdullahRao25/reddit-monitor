// Thin wrapper over the Node API. Every call resolves to parsed JSON (or
// null for 204) and rejects with an Error whose message is ready to show.

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("Can't reach the API server. Is it running?");
  }

  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw Object.assign(
      new Error(data?.error ?? `The API server didn't answer properly (HTTP ${res.status}). Is it running?`),
      { status: res.status },
    );
  }
  return data;
}

export const api = {
  status: () => request('GET', '/status'),
  accounts: () => request('GET', '/accounts'),
  account: (id) => request('GET', `/accounts/${id}`),
  addAccount: (fields) => request('POST', '/accounts', fields),
  updateAccount: (id, patch) => request('PATCH', `/accounts/${id}`, patch),
  deleteAccount: (id) => request('DELETE', `/accounts/${id}`),
  checkAccount: (id) => request('POST', `/accounts/${id}/check`),
  checkAll: () => request('POST', '/check-all'),
  checkLive: (username) => request('POST', '/check-live', { username }),
  alerts: ({ open = false, limit = 50 } = {}) =>
    request('GET', `/alerts?${new URLSearchParams({ ...(open ? { open: '1' } : {}), limit: String(limit) })}`),
  ackAlert: (id) => request('POST', `/alerts/${id}/ack`),
  ackAllAlerts: () => request('POST', '/alerts/ack-all'),

  // Stealth mode
  getFingerprint: (id) => request('GET', `/accounts/${id}/stealth/fingerprint`),
  saveFingerprint: (id, fingerprint) => request('PUT', `/accounts/${id}/stealth/fingerprint`, fingerprint),
  startWarmup: (id) => request('POST', `/accounts/${id}/stealth/warmup/start`),
  recordWarmupAction: (id, action) => request('POST', `/accounts/${id}/stealth/warmup/action`, { action }),
  getWarmupLog: (id) => request('GET', `/accounts/${id}/stealth/warmup/log`),
  clearWarmup: (id) => request('DELETE', `/accounts/${id}/stealth/warmup`),
};
