// One adapter for all server requests (server/src/app.js). Responses are mapped onto the field names the screens use.
import { currentToken } from './auth.js';
// Same-origin '/api' in dev (Vite proxy); set VITE_API_BASE to the deployed
// backend's URL when the dashboard is hosted separately (Netlify -> the API host).
const ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {};
const BASE = (ENV.VITE_API_BASE || '/api').replace(/\/$/, '');
// body is sent as JSON; csv (a file's text) is sent as-is with text/csv.
async function request(path, {method='GET', body, csv, signal}={}) {
  let response;
  const headers = csv !== undefined ? {'Content-Type':'text/csv'} : body === undefined ? {} : {'Content-Type':'application/json'};
  const token = await currentToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    response = await fetch(`${BASE}${path}`, {
      method, signal, headers,
      ...(csv !== undefined ? {body:csv} : body === undefined ? {} : {body:JSON.stringify(body)}),
    });
  } catch { throw Object.assign(new Error('Cannot reach the API server. Is it running?'), {status:0}); }
  if (response.status === 204) return null;
  let json;
  try { json = await response.json(); } catch { json = null; }
  if (!response.ok) throw Object.assign(new Error(json?.error || json?.message || `${method} ${path}: HTTP ${response.status}`), {status:response.status});
  return json;
}
const id = (value) => encodeURIComponent(value);
const karmaOf = (row) => row?.link_karma === null || row?.link_karma === undefined ? null : row.link_karma + (row.comment_karma ?? 0);

// Accounts row -> what the tables and KPI cards read (karma, posts_30d, removed_30d).
export function normalizeAccount(a) {
  return {...a, karma:karmaOf(a), posts_30d:a.items_sampled ?? null, removed_30d:a.items_removed ?? null};
}
export function normalizeAlert(a) { return {...a, username:a.account?.username ?? a.username}; }

export const REMOVED = new Set(['removed_by_mod','spam_filtered','removed_by_admin','removed']);
export const REMOVAL_LABEL = {visible:'Visible', removed_by_mod:'Removed by mods', spam_filtered:'Spam filter', removed_by_admin:'Removed by admins', removed:'Removed', deleted_by_author:'Deleted by author'};

// GET /accounts/:id -> account, latest check, history, tracked content and alerts in one payload.
export function normalizeDetail(d) {
  const seen = new Set();
  const content = [...(d.removed ?? []), ...(d.recent ?? [])].filter(c => !seen.has(c.id) && seen.add(c.id)).map(c => ({
    id:c.id, kind:c.kind, type:c.kind, subreddit:c.subreddit ? `r/${c.subreddit}` : null, permalink:c.permalink,
    title:c.kind === 'comment' ? (c.title ? `On “${c.title}”` : 'Comment') : (c.title || 'Untitled post'),
    excerpt:c.excerpt === '[removed]' || c.excerpt === '[deleted]' ? 'Text no longer visible' : c.excerpt,
    status:REMOVAL_LABEL[c.removal_status] || c.removal_status, removal_status:c.removal_status, removed:REMOVED.has(c.removal_status),
    created_at:c.created_at, removal_detected_at:c.removal_detected_at,
  })).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return {
    ...d,
    account:normalizeAccount(d.account),
    history:(d.history ?? []).map(h => ({...h, created_at:h.checked_at, karma:karmaOf(h)})),
    content,
    alerts:(d.alerts ?? []).map(normalizeAlert),
  };
}

export const api = {
  status: () => request('/status'),
  checkLive: (username) => request('/check-live',{method:'POST',body:{username}}),
  accounts: async () => ((await request('/accounts')).accounts ?? []).map(normalizeAccount),
  alerts: async () => ((await request('/alerts?limit=200')).alerts ?? []).map(normalizeAlert),
  account: async (accountId) => normalizeDetail(await request(`/accounts/${id(accountId)}`)),
  createAccount: (username, fields={}) => request('/accounts',{method:'POST',body:{username,...fields}}),
  patchAccount: (accountId,values) => request(`/accounts/${id(accountId)}`,{method:'PATCH',body:values}),
  removeAccount: (accountId) => request(`/accounts/${id(accountId)}`,{method:'DELETE'}),
  checkAccount: (accountId) => request(`/accounts/${id(accountId)}/check`,{method:'POST'}),
  checkAll: () => request('/check-all',{method:'POST'}),
  resolveAlert: (alertId) => request(`/alerts/${id(alertId)}/ack`,{method:'POST'}),
  resolveAllAlerts: () => request('/alerts/ack-all',{method:'POST'}),
  fingerprint: (accountId) => request(`/accounts/${id(accountId)}/stealth/fingerprint`),
  putFingerprint: (accountId,details) => request(`/accounts/${id(accountId)}/stealth/fingerprint`,{method:'PUT',body:details}),
  startWarmup: (accountId) => request(`/accounts/${id(accountId)}/stealth/warmup/start`,{method:'POST'}),
  recordWarmup: (accountId,action) => request(`/accounts/${id(accountId)}/stealth/warmup/action`,{method:'POST',body:{action}}),
  warmupLog: (accountId) => request(`/accounts/${id(accountId)}/stealth/warmup/log`),
  deleteWarmup: (accountId) => request(`/accounts/${id(accountId)}/stealth/warmup`,{method:'DELETE'}),
  votes: (accountId, {direction, kind}={}) => request(`/accounts/${id(accountId)}/votes?${new URLSearchParams({...(direction?{direction}:{}),...(kind?{kind}:{})})}`),
  importVotes: (accountId, kind, csvText) => request(`/accounts/${id(accountId)}/votes/import?kind=${encodeURIComponent(kind)}`,{method:'POST',csv:csvText}),
  clearVotes: (accountId) => request(`/accounts/${id(accountId)}/votes`,{method:'DELETE'}),
  preventerAccount: (accountId) => request(`/preventer/accounts/${id(accountId)}`),
  preventerOnboarding: (accountId, values) => request(`/preventer/accounts/${id(accountId)}/onboarding`,{method:'PUT',body:values}),
  preventerScan: (draft) => request('/preventer/preflight',{method:'POST',body:draft}),
  preventionOverview: () => request('/prevention/overview'),
  preventionDetail: accountId => request(`/accounts/${id(accountId)}/prevention`),
  preventionVoteSources: accountId => request(`/accounts/${id(accountId)}/prevention/vote-sources`),
  preventionHold: (accountId,reason) => request(`/accounts/${id(accountId)}/prevention/reviews`,{method:'POST',body:{reason}}),
  preventionComplete: (accountId,reviewId,action,reason) => request(`/accounts/${id(accountId)}/prevention/reviews/${id(reviewId)}/${action}`,{method:'POST',body:{reason}}),
  shieldOverview: () => request('/shield/overview'),
  shieldAudit: () => request('/shield/audit'),
  shieldCollisions: () => request('/shield/collisions'),
  shieldCreateIncident: payload => request('/shield/incidents',{method:'POST',body:payload}),
  shieldUpdateIncident: (incidentId,payload) => request(`/shield/incidents/${id(incidentId)}`,{method:'PATCH',body:payload}),
  shieldCreateDraft: (draft) => request('/shield/drafts',{method:'POST',body:draft}),
  shieldDraftAction: (draftId,payload) => request(`/shield/drafts/${id(draftId)}/decision`,{method:'POST',body:payload}),
  shieldRecordOutcome: (draftId,payload) => request(`/shield/drafts/${id(draftId)}/outcomes`,{method:'POST',body:payload}),
  shieldOutcomes: (draftId) => request(`/shield/drafts/${id(draftId)}/outcomes`),
  shieldVerifyDraft: (draftId) => request(`/shield/drafts/${id(draftId)}/verify`,{method:'POST'}),
  shieldCreateHold: (payload) => request('/shield/holds',{method:'POST',body:payload}),
  shieldReleaseHold: (holdId,reason) => request(`/shield/holds/${id(holdId)}/release`,{method:'POST',body:{reason}}),
};

// Average risk across accounts for each of the last `days` days: per account, the last check on or before that day.
export function riskTrendFrom(histories, days=7) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const end = new Date(); end.setHours(23,59,59,999); end.setDate(end.getDate() - i);
    const scores = histories.map(h => [...h].reverse().find(c => new Date(c.created_at) <= end && c.risk_score !== null && c.risk_score !== undefined)?.risk_score).filter(v => v != null && Number.isFinite(Number(v)));
    if (scores.length) out.push({name:end.toLocaleDateString(undefined,{weekday:'short'}), risk:Math.round(scores.reduce((s, v) => s + v, 0) / scores.length)});
  }
  return out;
}

export function formatDate(value) { if(!value)return 'Never'; const d=new Date(value); return Number.isNaN(d.getTime())?'—':d.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}); }
export function formatRelative(value) { if (!value) return 'Never'; let s=(Date.now()-new Date(value).getTime())/1000; if(!Number.isFinite(s))return '—'; if(s<0) return 'Just now'; if(s<60)return 'Just now'; if(s<3600)return `${Math.floor(s/60)}m ago`; if(s<86400)return `${Math.floor(s/3600)}h ago`; return `${Math.floor(s/86400)}d ago`; }
// A visible ("active") account is labelled by its risk band, matching risk.js: <25 low, <50 elevated, <75 high, 75+ critical.
export function displayStatus(status,risk) { const v=String(status||'unknown').toLowerCase(); if(v==='active'&&risk!==undefined&&risk!==null){const r=Number(risk);return r>=75?'Critical risk':r>=50?'At risk':r>=25?'Warning':'Healthy'} return ({healthy:'Healthy',active:'Healthy',visible:'Healthy',at_risk:'At risk',warning:'Warning',shadowbanned:'Shadowbanned',not_found:'Not found',check_failed:'Check failed',error:'Check failed',suspended:'Suspended',pending:'Not checked yet'})[v] || v.replaceAll('_',' '); }
export function level(status,risk) { const s=String(status||'').toLowerCase(); if(s==='pending')return 'neutral'; if(['shadowbanned','suspended'].includes(s)||Number(risk)>=75)return 'critical'; if(['at_risk'].includes(s)||Number(risk)>=50)return 'danger'; if(['warning','check_failed','error','not_found'].includes(s)||Number(risk)>=25)return 'warning'; return 'healthy'; }
export function score(account){return Number(account?.risk_score ?? account?.riskScore ?? 0)}
export function number(n){return n===null||n===undefined?'—':Number(n).toLocaleString()}
export const safeUrl=(url)=>{try{const u=new URL(url);return ['http:','https:'].includes(u.protocol)?u.href:null}catch{return null}};
// Which vote file of Reddit's data export this is, from its name: post_votes.csv / comment_votes.csv.
export const voteFileKind=(name)=>{const m=String(name||'').replaceAll('\\','/').split('/').pop().match(/^(post|comment)_votes(?:\s*\(\d+\))?\.csv$/i);return m?m[1].toLowerCase():null;};
// "pics" -> "r/pics"; profile posts use Reddit's "u_name" community -> "u/name".
export const communityLabel=(sub)=>!sub?'—':sub.startsWith('u_')?`u/${sub.slice(2)}`:`r/${sub}`;
export const WARMUP_ACTIONS=[['upvote','Upvote a high-karma post'],['comment','Short comment on a high-karma thread'],['view_profile','View a few user profiles'],['browse_sub','Browse a subscribed subreddit']];
