import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeActivity, assessReadiness, scanDraft } from '../src/preventer/engine.js';
import { createMemoryRepo, DAY, NOW } from './helpers.js';

const mk=(id,daysAgo,{kind='post',subreddit='sample',title='Ordinary example',excerpt=null,removal_status='visible',link_url=null}={})=>({
  id:`t3_${id}`,kind,subreddit,title,excerpt,removal_status,link_url,
  created_at:new Date(NOW-daysAgo*DAY).toISOString(),
});
const active=()=>({id:'9cb25fe8-c2e5-44bb-8909-c6e735d14819',status:'active',last_checked_at:new Date(NOW).toISOString(),link_karma:30,comment_karma:40});
const checked=()=>[{checked_at:new Date(NOW).toISOString(),account_created_at:new Date(NOW-300*DAY).toISOString()}];

test('activity analyzer counts recent items, removal patterns and duplicates, excludes older items',()=>{
  const repeated='I was considering a solution for a similar technical situation in my local community and wanted some input';
  const items=[mk('a',1,{title:repeated,removal_status:'removed_by_mod'}),mk('b',2,{title:repeated,removal_status:'spam_filtered'}),mk('c',50),mk('d',6,{kind:'comment'})];
  const result=analyzeActivity(items,{now:NOW});
  assert.equal(result.totals.items,3);assert.equal(result.totals.posts,2);assert.equal(result.totals.removed,2);
  assert(result.signals.some(s=>s.code==='repeated_content'));
  assert(result.signals.some(s=>s.code==='removals'));
});

test('zero content produces zero rate, no false issues and no misleading freshness guarantee',()=>{
  const result=analyzeActivity([],{now:NOW});
  assert.equal(result.totals.removal_rate,0);assert.deepEqual(result.signals,[]);
  assert.match(result.sample_limitations,/Missing or inaccessible/);
});

test('readiness holds suspended accounts and labels checklist self-reported',()=>{
  const result=assessReadiness({account:{...active(),status:'suspended'},checks:checked(),onboarding:{email_verified:true,two_factor_enabled:true,rules_reviewed:true},now:NOW,activity:{signals:[]}});
  assert.equal(result.decision,'hold');assert(result.findings.some(f=>f.code==='restriction'));
  assert.match(result.disclaimer,/Not Reddit CQS/);
});

test('readiness can be ready with current observations and manual completed checklist',()=>{
  const result=assessReadiness({account:active(),checks:checked(),onboarding:{email_verified:true,two_factor_enabled:true,rules_reviewed:true},now:NOW,activity:{signals:[]}});
  assert.equal(result.decision,'ready');assert.equal(result.score,100);
});

test('draft scans flag same-community removals and supplied anti-link rule',()=>{
  const items=[mk('x',1,{subreddit:'example',removal_status:'removed_by_mod'})];
  const activity=analyzeActivity(items,{now:NOW});
  const readiness=assessReadiness({account:active(),checks:checked(),onboarding:{email_verified:true,two_factor_enabled:true,rules_reviewed:true},activity,now:NOW});
  const result=scanDraft({draft:{kind:'post',subreddit:'example',title:'Check this out',text:'A relevant link',url:'https://example.com',rulesText:'No external links allowed'},account:active(),readiness,activity,items,now:NOW});
  assert.equal(result.decision,'hold');
  assert(result.flags.some(s=>s.code==='rule_links'));
});

test('same content in stored history triggers duplicate warning',()=>{
  const text='I wanted to ask the community about which software architectures are useful for organizing an accounting application';
  const item=mk('a',1,{title:text});
  const result=scanDraft({draft:{kind:'post',subreddit:'sample',title:text,rulesText:'Stay on topic'},account:active(),readiness:{decision:'ready'},activity:{signals:[]},items:[item],now:NOW});
  assert(result.flags.some(s=>s.code==='draft_repeat'));
});

test('prevention onboarding storage mirrors production repository interface',async()=>{
  const repo=createMemoryRepo({now:()=>NOW});
  const user=await repo.createAccount({username:'testName'});
  assert.equal(await repo.getPreventionProfile(user.id),null);
  await repo.upsertPreventionProfile(user.id,{two_factor_enabled:true});
  await repo.upsertPreventionProfile(user.id,{email_verified:false});
  assert.deepEqual([ (await repo.getPreventionProfile(user.id)).two_factor_enabled,(await repo.getPreventionProfile(user.id)).email_verified ],[true,false]);
});

// Integration: exercise the real Express route wiring with the in-memory test repo.
test('API prevents invalid drafts, persists onboarding and performs a read-only scan',async(t)=>{
  let createApp;
  try{({createApp}=await import('../src/app.js'));}catch(err){if(err.code==='ERR_MODULE_NOT_FOUND'){t.skip('express package not installed');return;}throw err;}
  const repo=createMemoryRepo({now:()=>NOW});
  const account=await repo.createAccount({username:'tester'});
  await repo.updateAccount(account.id,{...active(),id:account.id});
  await repo.insertCheck({account_id:account.id,...checked()[0]});
  const app=createApp({repo,reddit:{verify:async()=>{}},checker:{isChecking:()=>false},scheduler:{status:()=>({running:false}),trigger:()=>true},log:{error:()=>{}}});
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>server.close());
  const url=`http://127.0.0.1:${server.address().port}`;
  const put=await fetch(`${url}/api/preventer/accounts/${account.id}/onboarding`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({email_verified:true,two_factor_enabled:true,rules_reviewed:true})});
  assert.equal(put.status,200);
  const profile=await (await fetch(`${url}/api/preventer/accounts/${account.id}`)).json();
  assert.equal(profile.readiness.decision,'ready');
  const scan=await fetch(`${url}/api/preventer/preflight`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({accountId:account.id,kind:'comment',subreddit:'test',text:'This is relevant',rulesText:'Be civil'})});
  assert.equal(scan.status,200);
  assert.equal((await scan.json()).report.decision,'ready');
  const bad=await fetch(`${url}/api/preventer/preflight`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({accountId:account.id,kind:'comment',subreddit:'test',text:'',rulesText:''})});
  assert.equal(bad.status,400);
});
