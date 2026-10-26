// Prevention Operations: explainable, non-evasive account health controls.
// No Reddit network calls, votes, browser spoofing or automated publishing.
export const DAY = 86400000;
const validDate = value => {const ms=Date.parse(value ?? '');return Number.isFinite(ms)?ms:null;};
const finiteScore = value => value === null || value === undefined ? null : Number.isFinite(Number(value)) ? Math.max(0,Math.min(100,Number(value))) : null;

/** A descriptive extrapolation of the locally computed risk trend, not a Reddit enforcement prediction. */
export function assessHealthTrend(account, checks = [], now = Date.now()) {
  const points = checks.filter(c=>!c.error).map(c=>({t:validDate(c.checked_at),score:finiteScore(c.risk_score)}))
    .filter(p=>p.t!==null&&p.score!==null&&p.t<=now).sort((a,b)=>a.t-b.t);
  const distinct = points.filter((p,i)=>i===0||p.t!==points[i-1].t);
  const recent = distinct.slice(-15);
  const latest = recent.at(-1)?.score ?? finiteScore(account.risk_score);
  const stale = !account.last_checked_at || (now-validDate(account.last_checked_at))>2*DAY;
  if(recent.length<4 || (recent.at(-1).t-recent[0].t)<DAY) return {
    level: 'insufficient_data', score: latest, data_points:recent.length, stale,
    direction:'unknown', change_per_day:null, illustrative_days_to_75:null,
    explanation:'At least four successful checks spanning 24 hours are needed for a useful trend.',
    disclaimer:'Internal risk trend only; it does not predict Reddit enforcement or shadowban timing.'
  };
  const x0=recent[0].t;
  const xs=recent.map(p=>(p.t-x0)/DAY), ys=recent.map(p=>p.score);
  const xm=xs.reduce((a,b)=>a+b,0)/xs.length,ym=ys.reduce((a,b)=>a+b,0)/ys.length;
  const denominator=xs.reduce((a,x)=>a+(x-xm)**2,0);
  const slope=denominator>0?xs.reduce((a,x,i)=>a+(x-xm)*(ys[i]-ym),0)/denominator:0;
  const rounded=Math.round(slope*100)/100;
  const direction=rounded>=2?'increasing':rounded<=-2?'decreasing':'stable';
  const days = latest>=75?0:rounded>2?Math.ceil((75-latest)/rounded):null;
  return {
    level: latest>=75?'critical':direction==='increasing'?'rising':'stable_or_falling',score:latest,
    data_points:recent.length,stale,direction,change_per_day:rounded,
    illustrative_days_to_75:days!==null&&days<=30?days:null,
    explanation: days!==null&&days<=30
      ? `If this local score kept increasing at the same rate, it would mathematically reach 75 in about ${days} day(s). This is not an enforcement forecast.`
      : 'No meaningful near-term crossing of the internal 75-point band can be estimated from available checks.',
    disclaimer:'Internal, uncertain linear extrapolation—not Reddit CQS or a predicted shadowban date.'
  };
}

/** Operational remediation; never instructs identity evasion, fake engagement, or optimized posting schedules. */
export function buildSafetyPlan({account, checks=[], hold=null, trend, activity}={}) {
  const tasks=[];
  const add=(code,title,description,priority='normal')=>{if(!tasks.some(t=>t.code===code))tasks.push({code,title,description,priority});};
  const latest=checks.find(c=>!c.error);
  const failures=checks.slice(0,3).filter(c=>c.error).length;
  if(['shadowbanned','suspended'].includes(account?.status))add('restriction','Stop managed submissions and review appeal options','Check the account status through Reddit’s official account channels. Do not attempt to work around restrictions.','critical');
  if(hold)add('active_hold','Investigate the existing safety hold',hold.reason||'Resolve the hold through the Shield review process.','critical');
  if(failures===3)add('checks_failed','Investigate failed monitoring checks','Check browser availability and rate limits. A failed scraper is not proof of removal or a shadowban.','high');
  if(Number(latest?.newly_removed)>0 || Number(activity?.totals?.removed)>0)add('review_removals','Review removed content','Inspect subreddit rules and any moderator messages, then remove or revise content that violates them.','high');
  if(trend?.direction==='increasing')add('rising_risk','Review changes driving the internal risk score','Compare recent successful checks and inspect which factors changed. Do not interpret this trend as a ban countdown.','high');
  if(trend?.stale)add('stale_health','Refresh the public account health check','Collect a fresh check before using old results to approve managed drafts.');
  if(activity?.signals?.length)add('activity_patterns','Review repetitive activity', 'Inspect the activity warnings for duplicate content, excessive links, and unusual bursts.');
  if(!tasks.length)add('routine_review','Continue ordinary account reviews','Keep security settings current, follow community rules, and review future removal notifications.');
  return {tasks, automatic_actions:[], disclaimer:'Human-led compliance actions only; no Reddit posting, fabricated engagement or enforcement evasion.'};
}

export function summarizeScoreProvenance(votes=[], publicContent=[]) {
  const voteSummary={source:'owner_csv_import',access:'account_owner_only',upvotes:0,downvotes:0,post_votes:0,comment_votes:0};
  for(const vote of votes){if(vote.direction==='up')voteSummary.upvotes++;if(vote.direction==='down')voteSummary.downvotes++;if(vote.kind==='post')voteSummary.post_votes++;if(vote.kind==='comment')voteSummary.comment_votes++;}
  const scores=publicContent.filter(i=>Number.isFinite(Number(i.score))&&i.score!==null);
  return {private_votes:voteSummary,public_content_scores:{source:'public_content_listing',items_with_score:scores.length,
    total_observed_net_score:scores.reduce((s,i)=>s+Number(i.score),0)},
    warning:'Public net scores are not the votes this account cast. They cannot identify voters or individual vote direction. No live private votes were fetched.'};
}
