import test from 'node:test';
import assert from 'node:assert/strict';
import { collisionsFor, decisionFor, interventionFor, transitionFor } from '../src/shield/policy.js';
import { createMemoryRepo } from './helpers.js';

const uid='11111111-1111-4111-8111-111111111111';
test('collision detector flags duplicate cross-account content, not same account or cancelled entries',()=>{
 const t='An extended explanation about project architecture and detailed practical examples that is definitely long enough';
 const draft={account_id:uid,title:t,body:'',url:''};
 const other=[{id:'a',account_id:'other',title:t,state:'review'}, {id:'b',account_id:uid,title:t,state:'approved'}, {id:'c',account_id:'other',title:t,state:'cancelled'}];
 assert.equal(collisionsFor(draft,other).length,1);
});
test('collision detector reads the stored draft body for repeated destinations',()=>{
 const draft={account_id:uid,title:'',body:'See https://www.example.com/page/ for details',url:''};
 const other=[{id:'a',account_id:'other',title:'Different',body:'Mine is at https://example.com/page',url:'',state:'review'}];
 assert.equal(collisionsFor(draft,other)[0]?.reason,'Same external destination across accounts');
});
test('decision policy elevates active holds and collisions',()=>{
 const base={flags:[]};
 assert.equal(decisionFor(base,null).decision,'approve');
 assert.equal(decisionFor(base,null,[{id:1}]).decision,'review');
 assert.equal(decisionFor(base,{reason:'Human review needed'}).decision,'hold');
});
test('circuit breaker only holds on meaningful signals and repeated errors',()=>{
 const active={status:'active'};
 assert.equal(interventionFor({check:{risk_score:30},account:active}),null);
 assert.equal(interventionFor({check:{error:'Timeout'},account:active,consecutiveErrors:1}),null);
 assert.equal(interventionFor({check:{error:'Timeout'},account:active,consecutiveErrors:3}).code,'check_failing');
 assert.equal(interventionFor({check:{risk_score:10},account:{status:'suspended'}}).code,'account_restricted');
 assert.equal(interventionFor({check:{newly_removed:3},account:active}).code,'removal_spike');
});
test('approval requires reason, cannot override hold, and publication only records a permalink',()=>{
 const draft={state:'review'};
 assert.throws(()=>transitionFor(draft,'approve',{reason:'ok'}),/reason/);
 assert.throws(()=>transitionFor(draft,'approve',{reason:'Reviewed carefully',activeHold:{reason:'On hold'}}),/hold/);
 assert.deepEqual(transitionFor(draft,'approve',{reason:'Reviewed carefully',decision:'review'}),{state:'approved'});
 assert.throws(()=>transitionFor({state:'approved'},'mark_published',{decision:'approve',permalink:'https://example.com'}),/Reddit permalink/);
 assert.equal(transitionFor({state:'approved'},'mark_published',{decision:'review',permalink:'https://www.reddit.com/r/example/comments/abc/post/'}).state,'published');
});

test('Shield API persists review, safety holds, manual publication and outcomes',async(t)=>{
 let createApp;
 try {({createApp}=await import('../src/app.js'));} catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'){t.skip('Express not installed');return;}throw e;}
 const repo=createMemoryRepo();
 const acct=await repo.createAccount({username:'shieldtester'});
 await repo.updateAccount(acct.id,{status:'active',link_karma:30,comment_karma:80,last_checked_at:new Date().toISOString()});
 await repo.insertCheck({account_id:acct.id,checked_at:new Date().toISOString(),account_created_at:new Date(Date.now()-200*86400000).toISOString()});
 await repo.upsertPreventionProfile(acct.id,{email_verified:true,two_factor_enabled:true,rules_reviewed:true});
 const app=createApp({repo,reddit:{verify:async()=>{}},checker:{isChecking:()=>false},scheduler:{status:()=>({}),trigger:()=>true},log:{warn:()=>{},error:()=>{}}});
 const server=app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
 const base=`http://127.0.0.1:${server.address().port}`;
 const req=async(path,method='GET',body)=>{const res=await fetch(`${base}/api/shield${path}`,{method,headers:{'content-type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});return {status:res.status,data:await res.json()};};
 const draftBody={accountId:acct.id,kind:'post',subreddit:'example',title:'Question about community software',text:'How do you approach scalable software?',rulesText:'Be civil'};
 const created=await req('/drafts','POST',draftBody);assert.equal(created.status,201);assert.equal(created.data.draft.state,'approved');
 // Only columns that exist in supabase/shield.sql: the text goes to `body`.
 assert.equal(created.data.draft.body,draftBody.text);assert.equal('text' in created.data.draft,false);
 const draftId=created.data.draft.id;
 let hold=await req('/holds','POST',{accountId:acct.id,reason:'Moderation review needed'});assert.equal(hold.status,201);
 assert.equal((await req('/overview')).data.drafts[0].state,'held');
 assert.equal((await req(`/drafts/${draftId}/decision`,'POST',{action:'approve',reason:'Reviewed thoroughly'})).status,409);
 assert.equal((await req('/holds','POST',{accountId:acct.id,reason:'Another hold'})).status,409);
 assert.equal((await req(`/holds/${hold.data.hold.id}/release`,'POST',{reason:'Confirmed case resolved'})).status,200);
 assert.equal((await req(`/drafts/${draftId}/decision`,'POST',{action:'recheck'})).data.draft.state,'approved');
 assert.equal((await req(`/drafts/${draftId}/decision`,'POST',{action:'mark_published',permalink:'https://www.reddit.com/r/example/comments/abc/first/'})).status,200);
 assert.equal((await req(`/drafts/${draftId}/outcomes`,'POST',{visibility:'visible',note:'Checked as operator'})).status,201);
 assert.equal((await req(`/drafts/${draftId}/outcomes`)).data.outcomes.length,1);
 const inc=await req('/incidents','POST',{accountId:acct.id,summary:'Account flagged incorrectly',notes:'Reviewing the report'});
 assert.equal(inc.status,201);
 assert.equal((await req(`/incidents/${inc.data.incident.id}`,'PATCH',{status:'reviewing',note:'Collected evidence'})).status,200);
 assert.equal((await req('/overview')).data.incidents[0].status,'reviewing');
 assert((await req('/audit')).data.events.length>=7);
});
