// Explainable operational safeguards. No Reddit posting, voting, spoofing or evasion.
const clean = v => String(v ?? '').toLowerCase().replace(/https?:\/\//g,'').replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
const urls = value => [...String(value ?? '').matchAll(/https?:\/\/[^\s<>"']+/gi)].map(m=>m[0].replace(/[),.;]+$/,''));
const canonicalUrl = value => {try {const u=new URL(value);if(!['http:','https:'].includes(u.protocol))return null;const host=u.hostname.toLowerCase().replace(/^www\./,'');if(host==='reddit.com'||host.endsWith('.reddit.com'))return null;return host+u.pathname.replace(/\/$/,'');} catch {return null;}};

// Drafts are shield_drafts rows: the draft text is in `body`.
export function collisionsFor(draft, otherDrafts = []) {
  const body = clean([draft.title,draft.body].filter(Boolean).join(' '));
  const targetUrls=new Set([...urls(draft.body),draft.url].map(canonicalUrl).filter(Boolean));
  const hits=[];
  for(const other of otherDrafts) {
    if(!other || other.account_id===draft.account_id || ['cancelled'].includes(other.state))continue;
    const otherBody=clean([other.title,other.body].filter(Boolean).join(' '));
    const duplicate=body.length>=45&&otherBody===body;
    const matchingUrls=[...urls(other.body),other.url].map(canonicalUrl).filter(v=>v&&targetUrls.has(v));
    if(duplicate||matchingUrls.length)hits.push({draft_id:other.id,account_id:other.account_id,reason:duplicate?'Same text across accounts':'Same external destination across accounts'});
  }
  return hits.slice(0,10);
}

export function decisionFor(report, activeHold, collisions=[]) {
  const findings=[...(report.flags??[])];
  if(collisions.length)findings.push({code:'cross_account_collision',severity:'review',title:'Cross-account overlap',detail:`${collisions.length} draft(s) from other accounts have identical text or a repeated destination. Verify independent, authentic participation.`});
  if(activeHold)findings.unshift({code:'active_safety_hold',severity:'hold',title:'Active safety hold',detail:activeHold.reason});
  const decision=findings.some(f=>f.severity==='hold')?'hold':findings.length?'review':'approve';
  return {decision,findings,scanned_at:new Date().toISOString(),source:'Monitor + Preventer + Shield',disclaimer:'Internal assessment only. No Reddit posting or enforcement bypass occurs.'};
}

export function interventionFor({check,account,consecutiveErrors=0}) {
  if(!check || !account)return null;
  if(check.error) {
    return consecutiveErrors>=3?{code:'check_failing',reason:'Three consecutive monitoring failures; review connection and visibility before publishing.',severity:'review'}:null;
  }
  if(['shadowbanned','suspended'].includes(account.status))return {code:'account_restricted',reason:`Account status reported as ${account.status}. Stop queued activity and review restriction/appeal options.`,severity:'critical'};
  if(Number(check.newly_removed)>=3)return {code:'removal_spike',reason:`${check.newly_removed} newly removed items in one check. Review the removal causes.`,severity:'critical'};
  if(check.risk_level==='critical'||Number(check.risk_score)>=75)return {code:'critical_risk',reason:'Risk score reached the critical range; require manual review before more submissions.',severity:'critical'};
  return null;
}

export function transitionFor(draft,action,{activeHold=null,decision=null,reason='',permalink=''}={}) {
  const state=draft?.state;
  if(!state)throw new Error('Draft not found');
  if(['cancelled','published'].includes(state))throw new Error('This draft is final.');
  if(action==='cancel')return {state:'cancelled'};
  if(action==='hold')return {state:'held'};
  if(action==='recheck')return {state:decision==='approve'?'approved':decision==='hold'?'held':'review'};
  if(action==='approve') {
    if(activeHold || decision==='hold')throw new Error('Resolve the safety hold or blocking findings before approval.');
    if(String(reason).trim().length<5)throw new Error('Enter an approval reason (at least five characters).');
    return {state:'approved'};
  }
  if(action==='mark_published') {
    if(state!=='approved'||activeHold||decision==='hold')throw new Error('Draft requires a fresh, clear preflight and approval before recording publication.');
    if(!/^https:\/\/(www\.|old\.)?reddit\.com\//i.test(String(permalink)))throw new Error('Provide a Reddit permalink.');
    return {state:'published',permalink};
  }
  throw new Error('Unsupported action');
}
