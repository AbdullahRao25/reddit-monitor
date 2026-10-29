import { HttpError } from '../errors.js';
import { analyzeActivity, assessReadiness, scanDraft } from '../preventer/engine.js';
import { collisionsFor, decisionFor, transitionFor } from './policy.js';
import { isPlainObject as isPlain, UUID_RE } from '../routeGuards.js';

function invalid(message,status=400) {throw new HttpError(status,message);}
function requireUUID(value,description='ID') {if(!UUID_RE.test(String(value||'')))invalid(`Invalid ${description}.`);return value;}
function draftInput(body) {
  if(!isPlain(body))invalid('Enter a draft object.');
  const account_id=requireUUID(body.accountId,'account ID');
  const subreddit=String(body.subreddit??'').trim().replace(/^r\//i,'');
  if(!/^[A-Za-z0-9_]{2,24}$/.test(subreddit))invalid('Enter a valid subreddit.');
  if(!['post','comment'].includes(body.kind))invalid('Choose post or comment.');
  for(const field of ['title','text','url','rulesText']) if(body[field]!==undefined&&typeof body[field]!=='string')invalid(`${field} must be text.`);
  const title=String(body.title??'').trim(), text=String(body.text??'').trim();
  const url=String(body.url??'').trim(), rules_text=String(body.rulesText??'').trim();
  if(title.length>300||text.length>10000||url.length>2000||rules_text.length>4000)invalid('Draft exceeds length limits.');
  if(!title&&!text&&!url)invalid('Enter draft content.');
  if(url){let u;try{u=new URL(url);}catch{invalid('Enter a valid HTTP(S) URL.');}if(!['https:','http:'].includes(u.protocol))invalid('Use an HTTP(S) URL.');}
  // shield_drafts stores the draft text in its `body` column (supabase/shield.sql).
  return {account_id,subreddit,kind:body.kind,title,body:text,url,rules_text};
}
function trimReason(value) {const reason=String(value??'').trim();if(reason.length<5||reason.length>500)invalid('Enter a reason between 5 and 500 characters.');return reason;}

// All traffic is local API -> Supabase. No Reddit credentials, login cookies,
// publication, votes or automation is performed by this module.
export function registerShieldRoutes(app,{repo,reddit}) {
  async function accountFor(id) {requireUUID(id,'account ID');const account=await repo.getAccount(id);if(!account)invalid('Account not found.',404);return account;}
  async function getDraft(id) {requireUUID(id,'draft ID');const draft=await repo.getShieldDraft(id);if(!draft)invalid('Draft not found.',404);return draft;}
  async function assess(draft,{excludingId=null}={}) {
    const account=await accountFor(draft.account_id);
    const since=new Date(Date.now()-30*86400000).toISOString();
    const [items,checks,onboarding,hold,others]=await Promise.all([
      repo.getContentItems(account.id,since),repo.getRecentChecks(account.id,15),repo.getPreventionProfile(account.id),
      repo.getActiveShieldHold(account.id),repo.listShieldDrafts(200),
    ]);
    const activity=analyzeActivity(items);
    const readiness=assessReadiness({account,checks,onboarding,activity});
    const report=scanDraft({draft:{subreddit:draft.subreddit,kind:draft.kind,title:draft.title,text:draft.body,url:draft.url,rulesText:draft.rules_text},account,readiness,activity,items});
    const collisions=collisionsFor(draft,others.filter(x=>x.id!==excludingId));
    return {decision:decisionFor(report,hold,collisions),hold,collisions};
  }
  const audit=(account_id,draft_id,event_type,details={})=>repo.insertShieldEvent({account_id,draft_id,event_type,details});

  app.get('/api/shield/overview',async(req,res)=>{
    const [drafts,holds,events,accounts,incidents]=await Promise.all([repo.listShieldDrafts(150),repo.listShieldHolds(150),repo.listShieldEvents(100),repo.listAccounts(),repo.listShieldIncidents(100)]);
    res.json({drafts,holds,events,incidents,accounts:accounts.map(a=>({id:a.id,username:a.username,status:a.status,risk_score:a.risk_score,last_checked_at:a.last_checked_at})),notice:'Only managed drafts are controlled. No direct Reddit submissions are intercepted.'});
  });
  app.get('/api/shield/audit',async(req,res)=>res.json({events:await repo.listShieldEvents(200)}));
  app.post('/api/shield/incidents',async(req,res)=>{
    const account=await accountFor(req.body?.accountId);
    const summary=String(req.body?.summary??'').trim();
    if(summary.length<5||summary.length>500)invalid('Enter a summary between 5 and 500 characters.');
    const notes=String(req.body?.notes??'').trim();
    if(notes.length>2000)invalid('Incident notes must be <= 2000 characters.');
    const incident=await repo.createShieldIncident({account_id:account.id,summary,notes,status:'open'});
    await audit(account.id,null,'incident_created',{incident_id:incident.id,summary});
    res.status(201).json({incident});
  });
  app.patch('/api/shield/incidents/:id',async(req,res)=>{
    requireUUID(req.params.id,'incident ID');
    const incident=await repo.getShieldIncident(req.params.id);
    if(!incident)invalid('Incident not found.',404);
    const status=String(req.body?.status??'');
    if(!['open','reviewing','appealed','resolved'].includes(status))invalid('Invalid incident status.');
    const note=String(req.body?.note??'').trim();
    if(note.length<5||note.length>1000)invalid('Enter an update note between 5 and 1000 characters.');
    const updated=await repo.updateShieldIncident(incident.id,{status,notes:incident.notes?incident.notes+'\n'+note:note,updated_at:new Date().toISOString()});
    await audit(incident.account_id,null,'incident_updated',{incident_id:incident.id,from:incident.status,to:status,note});
    res.json({incident:updated});
  });

  app.get('/api/shield/collisions',async(req,res)=>{
    const drafts=await repo.listShieldDrafts(200);
    res.json({collisions:drafts.map(d=>({draft_id:d.id,account_id:d.account_id,matches:collisionsFor(d,drafts)})).filter(d=>d.matches.length)});
  });
  app.post('/api/shield/drafts',async(req,res)=>{
    const fields=draftInput(req.body);
    await accountFor(fields.account_id);
    // Always perform preflight before writing a draft; decision is auditable.
    const {decision}=await assess(fields);
    const state={approve:'approved',review:'review',hold:'held'}[decision.decision];
    const draft=await repo.createShieldDraft({...fields,state,last_decision:decision});
    await audit(fields.account_id,draft.id,'draft_created',{state,decision});
    res.status(201).json({draft,decision});
  });
  app.post('/api/shield/drafts/:id/decision',async(req,res)=>{
    const draft=await getDraft(req.params.id);
    const body=req.body??{};
    const action=String(body.action??'');
    if(!['approve','hold','cancel','recheck','mark_published'].includes(action))invalid('Unsupported action.');
    const reason=['approve','hold','cancel'].includes(action)?trimReason(body.reason):String(body.reason??'').slice(0,500);
    const {decision,hold}=await assess(draft,{excludingId:draft.id});
    let patch;
    try{patch=transitionFor(draft,action,{activeHold:hold,decision:decision.decision,reason,permalink:body.permalink});}
    catch(err){invalid(err.message,409);}
    const updated=await repo.updateShieldDraft(draft.id,{...patch,last_decision:decision,updated_at:new Date().toISOString()});
    await audit(draft.account_id,draft.id,`draft_${action}`,{reason,from:draft.state,to:patch.state,decision});
    res.json({draft:updated,decision});
  });
  app.post('/api/shield/drafts/:id/outcomes',async(req,res)=>{
    const draft=await getDraft(req.params.id);
    if(draft.state!=='published')invalid('Record publication before recording an outcome.',409);
    const visibility=String(req.body?.visibility??'');
    if(!['visible','removed','unknown'].includes(visibility))invalid('Invalid visibility state.');
    const note=String(req.body?.note??'').trim();
    if(note.length>500)invalid('Notes must be <= 500 characters.');
    const outcome=await repo.createShieldOutcome({account_id:draft.account_id,draft_id:draft.id,visibility,note,source:'manual'});
    await audit(draft.account_id,draft.id,'outcome_recorded',{visibility,note,source:'manual'});
    res.status(201).json({outcome,notice:'Operator-reported outcome; not verified automatically against Reddit.'});
  });
  app.get('/api/shield/drafts/:id/outcomes',async(req,res)=>{await getDraft(req.params.id);res.json({outcomes:await repo.listShieldOutcomes(req.params.id)});});
  app.post('/api/shield/drafts/:id/verify',async(req,res)=>{
    const draft=await getDraft(req.params.id);
    if(draft.state!=='published'||!draft.permalink)invalid('A manually recorded publication is required first.',409);
    const account=await accountFor(draft.account_id);
    if(typeof reddit?.getUserListing!=='function')invalid('Public listing checks are not configured.',503);
    // This is a conservative observation of the public account listing.
    // A missing result never proves removal or a shadowban.
    const listing=await reddit.getUserListing(account.username,draft.kind==='post'?'submitted':'comments');
    if(!Array.isArray(listing))invalid('Could not read the public listing; please try again.',502);
    const publishedPath=new URL(draft.permalink).pathname.replace(/\/$/,'').toLowerCase();
    const found=listing.some(item=>{
      try{return new URL(item.permalink,'https://www.reddit.com').pathname.replace(/\/$/,'').toLowerCase()===publishedPath;}
      catch{return false;}
    });
    const visibility=found?'visible':'unknown';
    const note=found?'Submission found in public account listing.':'Not present in the sampled listing; removal is NOT confirmed.';
    const outcome=await repo.createShieldOutcome({account_id:account.id,draft_id:draft.id,visibility,note,source:'public_listing'});
    await audit(account.id,draft.id,'visibility_checked',{visibility,note,source:'public_listing'});
    res.json({outcome,notice:note});
  });

  app.post('/api/shield/holds',async(req,res)=>{
    const account=await accountFor(req.body?.accountId);
    const reason=trimReason(req.body?.reason);
    const existing=await repo.getActiveShieldHold(account.id);
    if(existing)invalid('An active safety hold already exists for this account.',409);
    const hold=await repo.createShieldHold({account_id:account.id,reason,code:'manual',source:'operator'});
    await repo.holdShieldDrafts(account.id);
    await audit(account.id,null,'hold_created',{hold_id:hold.id,reason,source:'operator'});
    res.status(201).json({hold});
  });
  app.post('/api/shield/holds/:id/release',async(req,res)=>{
    requireUUID(req.params.id,'hold ID');
    const hold=await repo.getShieldHold(req.params.id);
    if(!hold)invalid('Hold not found.',404);
    if(hold.released_at)invalid('Hold already released.',409);
    const account=await accountFor(hold.account_id);
    if(['shadowbanned','suspended'].includes(account.status))invalid('Cannot release a hold while the account is reported restricted.',409);
    const reason=trimReason(req.body?.reason);
    const released=await repo.releaseShieldHold(hold.id,reason);
    // Drafts stay held until they receive a new preflight or manual review.
    await audit(account.id,null,'hold_released',{hold_id:hold.id,reason});
    res.json({hold:released,notice:'Held drafts remain held until individually reviewed.'});
  });
}
