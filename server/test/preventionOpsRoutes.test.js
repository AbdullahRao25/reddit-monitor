import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryRepo} from './helpers.js';
import {registerPreventionOperationsRoutes} from '../src/prevention/routes.js';
const NOW=Date.parse('2026-10-26T12:00:00Z');
function harness(){
 const repo=createMemoryRepo({now:()=>NOW});const routes=new Map();
 const app={get:(p,h)=>routes.set('GET '+p,h),post:(p,h)=>routes.set('POST '+p,h)};
 registerPreventionOperationsRoutes(app,{repo});
 async function invoke(method,path,{params={},body={}}={}){
  const handler=routes.get(method+' '+path); assert.ok(handler,`Missing route ${method} ${path}`);
  const result={statusCode:200};
  const res={status(s){result.statusCode=s;return this;},json(json){result.data=json;return this;}};
  await handler({params,body},res);return result;
 }
 return {repo,invoke};
}

test('prevention overview exposes stored trend without Reddit API requests',async()=>{
 const {repo,invoke}=harness();const account=await repo.createAccount({username:'test'});
 const result=await invoke('GET','/api/prevention/overview');
 assert.equal(result.data.accounts.length,1);assert.equal(result.data.accounts[0].account_id,account.id);
 assert.equal(result.data.read_only,true);
});
test('review queue supports hold and clear without publishing',async()=>{
 const {repo,invoke}=harness();const account=await repo.createAccount({username:'test'});
 const params={id:account.id};
 const created=await invoke('POST','/api/accounts/:id/prevention/reviews',{params,body:{reason:'Repeated content needs review'}});
 assert.equal(created.statusCode,201);assert.equal(created.data.review.state,'held');
 const list=await invoke('GET','/api/accounts/:id/prevention/reviews',{params});assert.equal(list.data.reviews.length,1);
 const completed=await invoke('POST','/api/accounts/:id/prevention/reviews/:reviewId/:action',
   {params:{...params,reviewId:created.data.review.id,action:'clear'},body:{reason:'Completed review of the content'}});
 assert.equal(completed.data.review.state,'cleared');
 assert.match(completed.data.notice,/does not post to Reddit/i);
});
test('review cannot release while Shield safety hold remains active',async()=>{
 const {repo,invoke}=harness();const account=await repo.createAccount({username:'test'});
 await repo.createShieldHold({account_id:account.id,reason:'Incident under review',code:'manual',source:'operator'});
 const created=await invoke('POST','/api/accounts/:id/prevention/reviews',{params:{id:account.id},body:{reason:'Needs a compliance review'}});
 await assert.rejects(()=>invoke('POST','/api/accounts/:id/prevention/reviews/:reviewId/:action',{
  params:{id:account.id,reviewId:created.data.review.id,action:'release'},body:{reason:'Review was completed adequately'}
 }),e=>e.status===409);
});
test('vote source endpoint never converts public scores into personal votes',async()=>{
 const {repo,invoke}=harness();const account=await repo.createAccount({username:'test'});
 repo.content.set('t3_post',{id:'t3_post',account_id:account.id,created_at:new Date(NOW).toISOString(),score:99});
 const response=await invoke('GET','/api/accounts/:id/prevention/vote-sources',{params:{id:account.id}});
 assert.equal(response.data.private_votes.upvotes,0);
 assert.equal(response.data.public_content_scores.total_observed_net_score,99);
 assert.match(response.data.warning,/cannot identify voters/i);
});
