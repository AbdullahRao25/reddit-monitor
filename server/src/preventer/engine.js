// Deterministic, explainable account-safety checks. These are internal review
// heuristics, NOT Reddit's CQS or a prediction of platform enforcement.
const DAY = 86400000;
const REMOVED = new Set(['removed', 'removed_by_mod', 'removed_by_admin', 'spam_filtered']);
const timeOf = value => { const t = Date.parse(String(value ?? '')); return Number.isFinite(t) ? t : null; };
const canonical = s => String(s ?? '').toLowerCase().replace(/https?:\/\//g, '').replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
const normalizeSub = s => String(s ?? '').replace(/^r\//i, '').toLowerCase();
const domainFrom = value => { try { return new URL(value).hostname.replace(/^www\./,'').toLowerCase(); } catch { return null; } };
const signal = (code, severity, title, detail) => ({ code, severity, title, detail });
const countDays = (t, now) => t === null ? null : Math.max(0, Math.floor((now - t) / DAY));

export function analyzeActivity(items = [], { now = Date.now() } = {}) {
  const recent = items.filter(item => { const t = timeOf(item.created_at); return t !== null && t <= now && now-t <= 30*DAY; });
  const seven = recent.filter(item => now-timeOf(item.created_at) <= 7*DAY);
  const prior = recent.filter(item => now-timeOf(item.created_at) > 7*DAY);
  const removed = recent.filter(item => REMOVED.has(item.removal_status));
  const todayCount = recent.filter(item => now-timeOf(item.created_at) <= DAY).length;
  const bySubreddit = new Map();
  const byDay = new Map();
  const byText = new Map();
  const byDomain = new Map();
  for (const item of recent) {
    const sub=normalizeSub(item.subreddit)||'unknown';
    bySubreddit.set(sub, (bySubreddit.get(sub)||0)+1);
    const day = new Date(timeOf(item.created_at)).toISOString().slice(0,10);
    byDay.set(day,(byDay.get(day)||0)+1);
    const text=canonical(item.title || item.excerpt);
    if (text.length>=45) byText.set(text,(byText.get(text)||0)+1);
    const domain=domainFrom(item.link_url);
    if (domain && !domain.endsWith('reddit.com')) byDomain.set(domain,(byDomain.get(domain)||0)+1);
  }
  const repeatedTexts=[...byText.entries()].filter(([,n])=>n>=2).sort((a,b)=>b[1]-a[1]);
  const repeatedDomains=[...byDomain.entries()].filter(([,n])=>n>=3).sort((a,b)=>b[1]-a[1]);
  const signals=[];
  const removalRate=recent.length ? removed.length/recent.length : 0;
  if (removed.length>=2 || (removed.length && removalRate>=0.25))
    signals.push(signal('removals','high','Recent removal pattern',`${removed.length} of ${recent.length} tracked items were removed in the last 30 days. Review moderator feedback and community rules.`));
  if (seven.length >= 5 && seven.length/7 > Math.max(1, (prior.length/23)*3))
    signals.push(signal('activity_surge','review','Large activity increase',`${seven.length} tracked items in the last 7 days versus ${prior.length} in the preceding 23 days. Investigate the change.`));
  if (repeatedTexts.length) signals.push(signal('repeated_content','high','Repeated text detected',`Similar stored titles or excerpts appeared multiple times (${repeatedTexts[0][1]} exact normalized matches).`));
  if (repeatedDomains.length) signals.push(signal('repeated_links','review','Repeated destination links',`Multiple recent posts link to ${repeatedDomains[0][0]}. Review relevance and community rules.`));
  const result = {
    window_days:30,
    totals:{items:recent.length,posts:recent.filter(i=>i.kind==='post').length,comments:recent.filter(i=>i.kind==='comment').length,removed:removed.length,removal_rate:Math.round(removalRate*100),last_7_days:seven.length,previous_23_days:prior.length,last_24_hours:todayCount},
    busiest_day: [...byDay.entries()].sort((a,b)=>b[1]-a[1])[0] ? {date:[...byDay.entries()].sort((a,b)=>b[1]-a[1])[0][0],count:Math.max(...byDay.values())} : null,
    top_subreddits:[...bySubreddit.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5).map(([name,count])=>({name,count})),
    signals,
    assessed_at:new Date(now).toISOString(),
    sample_limitations:'Based only on posts/comments successfully collected and stored by the monitor. Missing or inaccessible content can understate activity.',
  };
  return result;
}

export function assessReadiness({ account, checks = [], onboarding = null, activity = null, now = Date.now() }) {
  const latest=checks.find(c=>!c.error) ?? null;
  const profile=onboarding ?? {};
  const ageDays=countDays(timeOf(latest?.account_created_at),now);
  const checkDays=countDays(timeOf(latest?.checked_at || account?.last_checked_at),now);
  const karma=Number.isFinite(Number(account?.link_karma)) && Number.isFinite(Number(account?.comment_karma))
    ? Number(account.link_karma)+Number(account.comment_karma) : null;
  const findings=[];
  let points=100;
  const add=(code,severity,title,detail,penalty)=>{findings.push(signal(code,severity,title,detail));points=Math.max(0,points-penalty);};
  const restricted=['shadowbanned','suspended'].includes(account?.status);
  if (account?.paused) add('monitor_paused','hold','Monitoring paused','This account is paused in the Monitor. Review its status before planning activity.',20);
  if (restricted) add('restriction','hold','Account restriction reported',`Last check reports ${account.status}. Review account status and official appeal options.`,70);
  else if (account?.status !== 'active') add('visibility','hold','Public visibility not confirmed','Run a successful account check before reviewing a draft.',35);
  if (checkDays===null || checkDays>7) add('stale_check','review','Monitoring information is stale','Run a fresh public-profile check; previous results may no longer describe this account.',15);
  if (ageDays===null) add('unknown_age','review','Account age unavailable','Account creation date was not available from the last health check.',10);
  else if (ageDays<30) add('young_account','review','Recent account creation',`Account age is ${ageDays} days. Some communities may have age requirements.`,10);
  if (karma===null) add('unknown_karma','review','Karma totals unavailable','A public-profile check is needed to determine public karma totals.',5);
  else if (karma<10) add('low_karma','review','Limited public karma',`Account currently has ${karma} total public karma; subreddit requirements vary.`,10);
  if (activity?.signals?.some(x=>x.severity==='high')) add('activity_flags','review','Activity concerns detected','Review recent removals or repetition signals before publishing.',20);
  if (profile.email_verified !== true) add('email_review','review','Email verification not confirmed','Confirm account email verification in Reddit settings. This is a manually reported field.',5);
  if (profile.two_factor_enabled !== true) add('security_review','review','Two-factor authentication not confirmed','Review account security in Reddit settings. This is a manually reported field.',5);
  if (profile.rules_reviewed !== true) add('rules_review','review','Community-rule review not confirmed','Read the intended community rules before posting. This checklist is not a subreddit eligibility guarantee.',5);
  const decision=restricted || account?.paused || account?.status!=='active' ? 'hold' : findings.length ? 'review' : 'ready';
  return {decision,score:points,age_days:ageDays,karma,check_age_days:checkDays,findings,onboarding:{email_verified:profile.email_verified??null,two_factor_enabled:profile.two_factor_enabled??null,rules_reviewed:profile.rules_reviewed??null,notes:profile.notes??'',updated_at:profile.updated_at??null},assessed_at:new Date(now).toISOString(),disclaimer:'Internal heuristic only. Not Reddit CQS, an approval, a posting limit, or a promise against moderation.'};
}

function nearDuplicate(a,b) {
  const aa=canonical(a), bb=canonical(b);
  if (aa.length<45 || bb.length<45) return false;
  if (aa===bb) return true;
  const tokens = s => new Set(s.split(' ').filter(x=>x.length>2));
  const x=tokens(aa), y=tokens(bb);
  if(x.size<6 || y.size<6)return false;
  let shared=0;for(const word of x)if(y.has(word))shared++;
  return shared/Math.max(x.size,y.size)>=0.85;
}

export function scanDraft({ draft, account, readiness, activity, items=[], now=Date.now() }) {
  const title=String(draft.title??'').trim();
  const text=String(draft.text??'').trim();
  const content=[title,text].filter(Boolean).join('\n');
  const sub=normalizeSub(draft.subreddit);
  const rules=String(draft.rulesText??'').toLowerCase();
  const urls=[...content.matchAll(/https?:\/\/[^\s<>"']+/gi)].map(x=>x[0]);
  if (draft.url) urls.push(draft.url);
  const domains=urls.map(domainFrom).filter(Boolean);
  const flags=[];
  const add=(code,severity,title,detail)=>flags.push(signal(code,severity,title,detail));
  if (readiness.decision==='hold') add('account_hold','hold','Account needs attention','The latest account status does not establish that this account is ready to participate.');
  else if (readiness.decision==='review') add('account_review','review','Account readiness review','Review the account onboarding and health findings before publishing.');
  if (!rules.trim()) add('rules_missing','review','Subreddit rules not supplied','Paste the current community rules or review them directly before posting. The tool cannot validate undisclosed rules.');
  if (activity.signals.some(x=>x.code==='removals') && items.some(i=>normalizeSub(i.subreddit)===sub&&REMOVED.has(i.removal_status)))
    add('community_removals','hold','Recent removal in this community','A tracked submission in the selected subreddit was removed. Review the reason before posting similar material.');
  const duplicate=items.find(item=>nearDuplicate(content,`${item.title||''} ${item.excerpt||''}`));
  if (duplicate) add('draft_repeat','review','Draft resembles previous content',`Similar text was found in a tracked ${duplicate.kind||'item'}${duplicate.subreddit?` in r/${normalizeSub(duplicate.subreddit)}`:''}.`);
  if (urls.length>=3) add('many_links','review','Several external links','This draft contains multiple links. Check whether they are necessary and allowed.');
  if (domains.length && (/(?:no (?:external )?links|links? (?:are )?not allowed|no self.promo|no advertising|no promotional)/i.test(rules)))
    add('rule_links','hold','Link or promotion rule may apply','Provided rules appear to limit links or promotion. Confirm with the moderators before publishing.');
  if (/(?:no surveys|surveys? (?:are )?not allowed)/i.test(rules) && /\b(survey|questionnaire|poll respondents)\b/i.test(content))
    add('rule_survey','review','Survey restriction may apply','The supplied community rules mention surveys.');
  if (/(?:no recruiting|no job posts|no hiring)/i.test(rules) && /\b(hiring|recruiting|job opening|apply now)\b/i.test(content))
    add('rule_jobs','review','Recruitment rule may apply','The supplied community rules mention recruiting or job posts.');
  if (activity.signals.some(x=>x.code==='repeated_links') && domains.length) add('link_pattern','review','Existing link repetition signal','Recent monitored activity contains recurring destination links.');
  if (draft.kind==='post' && !title) add('post_title','review','Post title missing','Include a descriptive title if your selected post type requires it.');
  const decision=flags.some(x=>x.severity==='hold')?'hold':flags.length?'review':'ready';
  return {decision,flags,account_id:account.id,subreddit:sub,kind:draft.kind,scanned_at:new Date(now).toISOString(),disclaimer:'Draft review is heuristic and does not publish content, fetch all subreddit rules, or guarantee Reddit/moderator approval.'};
}
