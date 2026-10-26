import { HttpError } from '../errors.js';
import { analyzeActivity } from '../preventer/engine.js';
import { assessHealthTrend, buildSafetyPlan, summarizeScoreProvenance } from './ops.js';

const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const fail=(status,message)=>{throw new HttpError(status,message);};
const validAccount=async(repo,id)=>{
  if(!UUID.test(String(id)))fail(404,'Account not found');
  const a=await repo.getAccount(id);
  if(!a)fail(404,'Account not found');
  return a;
};
async function detail(repo,account){
  const since=new Date(Date.now()-30*86400000).toISOString();
  const [checks,items,hold,queued]=await Promise.all([
    repo.getRecentChecks(account.id,30),repo.getContentItems(account.id,since),
    repo.getActiveShieldHold(account.id),repo.listPreventionReviews(account.id)
  ]);
  const activity=analyzeActivity(items);
  const trend=assessHealthTrend(account,checks);
  return {account_id:account.id,username:account.username,trend,
    plan:buildSafetyPlan({account,checks,hold,activity,trend}),queue:queued,
    active_safety_hold:hold?{id:hold.id,reason:hold.reason,created_at:hold.created_at}:null,
    source:'stored_monitor_data',notice:'This endpoint only reads your database and does not contact Reddit.'};
}
export function registerPreventionOperationsRoutes(app,{repo}){
  app.get('/api/prevention/overview',async(req,res)=>{
    const accounts=await repo.listAccounts();
    const summaries=await Promise.all(accounts.map(async account=>{
      const [checks,queued,hold]=await Promise.all([repo.getRecentChecks(account.id,30),repo.listPreventionReviews(account.id),repo.getActiveShieldHold(account.id)]);
      return {account_id:account.id,username:account.username,status:account.status,
        trend:assessHealthTrend(account,checks),pending_reviews:queued.filter(q=>q.state==='held').length,
        active_safety_hold:!!hold};
    }));
    res.json({accounts:summaries,read_only:true,notice:'Health trends and review queue; no Reddit requests are sent.'});
  });
  app.get('/api/accounts/:id/prevention',async(req,res)=>{
    const account=await validAccount(repo,req.params.id);
    res.json(await detail(repo,account));
  });
  app.get('/api/accounts/:id/prevention/vote-sources',async(req,res)=>{
    const account=await validAccount(repo,req.params.id);
    const [votes,contents]=await Promise.all([repo.listAccountVotes(account.id),repo.listContent(account.id,{limit:100})]);
    res.json(summarizeScoreProvenance(votes,contents));
  });
  app.get('/api/accounts/:id/prevention/reviews',async(req,res)=>{
    const account=await validAccount(repo,req.params.id);
    res.json({reviews:await repo.listPreventionReviews(account.id)});
  });
  app.post('/api/accounts/:id/prevention/reviews',async(req,res)=>{
    const account=await validAccount(repo,req.params.id);
    const reason=String(req.body?.reason??'').trim();
    if(reason.length<10||reason.length>500)fail(400,'Enter a review reason of 10–500 characters.');
    const draftId=req.body?.draftId??null;
    if(draftId!==null){
      if(!UUID.test(String(draftId)))fail(400,'Invalid draft ID.');
      const draft=await repo.getShieldDraft(draftId);
      if(!draft||draft.account_id!==account.id)fail(404,'Draft not found on this account.');
    }
    const review=await repo.createPreventionReview({account_id:account.id,draft_id:draftId,reason,state:'held'});
    res.status(201).json({review,notice:'Saved for manual review only. No Reddit action is scheduled or sent.'});
  });
  app.post('/api/accounts/:id/prevention/reviews/:reviewId/:action',async(req,res)=>{
    const account=await validAccount(repo,req.params.id);
    const review=UUID.test(String(req.params.reviewId))?await repo.getPreventionReview(req.params.reviewId):null;
    if(!review||review.account_id!==account.id)fail(404,'Review item not found.');
    if(review.state!=='held')fail(409,'This review has already been completed.');
    const action=String(req.params.action);
    if(!['release','clear'].includes(action))fail(404,'Unsupported action.');
    const reason=String(req.body?.reason??'').trim();
    if(reason.length<10||reason.length>500)fail(400,'Enter a completion reason of 10–500 characters.');
    if(action==='release'){
      if(['shadowbanned','suspended'].includes(account.status))fail(409,'An account restriction must be resolved before review release.');
      if(await repo.getActiveShieldHold(account.id))fail(409,'Resolve the Shield safety hold before releasing this review.');
    }
    const result=await repo.finishPreventionReview(review.id,action==='release'?'released':'cleared',reason);
    res.json({review:result,notice:'This changes review status only. It does not post to Reddit or release any Shield drafts.'});
  });
}
