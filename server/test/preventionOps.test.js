import test from 'node:test';
import assert from 'node:assert/strict';
import { assessHealthTrend, buildSafetyPlan, summarizeScoreProvenance, DAY } from '../src/prevention/ops.js';
import { createMemoryRepo } from './helpers.js';
const NOW=Date.parse('2026-10-26T12:00:00Z');
const account = {id:'00000000-0000-4000-8000-000000000001', username:'example',status:'active',risk_score:42,last_checked_at:new Date(NOW).toISOString()};
const check=(daysAgo,risk_score)=>({checked_at:new Date(NOW-daysAgo*DAY).toISOString(),risk_score,status:'active'});

test('trends decline to infer risk with insufficient independent observations',()=>{
  const t=assessHealthTrend(account,[check(0,10),check(0.1,15)],NOW);
  assert.equal(t.level,'insufficient_data');assert.equal(t.illustrative_days_to_75,null);
});
test('trend reports stable scores without inventing a ban date',()=>{
  const t=assessHealthTrend(account,[check(4,32),check(3,33),check(2,32),check(0,32)],NOW);
  assert.equal(t.direction,'stable');assert.equal(t.illustrative_days_to_75,null);
  assert.match(t.disclaimer,/not.*predict|not.*predicted/i);
});
test('trend shows illustrative linear score crossing, explicitly not enforcement prediction',()=>{
  const t=assessHealthTrend(account,[check(3,20),check(2,32),check(1,42),check(0,55)],NOW);
  assert.equal(t.direction,'increasing');assert.ok(t.illustrative_days_to_75>=1);
  assert.match(t.explanation,/not an enforcement forecast/i);
});
test('monitor errors never become successful data points',()=>{
  const t=assessHealthTrend(account,[{...check(.3,99),error:'playwright failed'},check(0,42)],NOW);
  assert.equal(t.data_points,1);assert.equal(t.level,'insufficient_data');
});
test('severe status generates a human remediation plan, not a fake-engagement schedule',()=>{
  const result=buildSafetyPlan({account:{...account,status:'suspended'},checks:[],trend:{stale:true}});
  assert.equal(result.tasks[0].code,'restriction');assert.deepEqual(result.automatic_actions,[]);
  assert.doesNotMatch(JSON.stringify(result),/rotate|spoof|upvote a high|jitter/i);
});
test('separate imported personal votes from public score aggregates',()=>{
  const r=summarizeScoreProvenance([{direction:'up',kind:'post'},{direction:'down',kind:'comment'}],[{score:24},{score:0},{score:null}]);
  assert.equal(r.private_votes.upvotes,1);assert.equal(r.private_votes.downvotes,1);
  assert.equal(r.public_content_scores.items_with_score,2);
  assert.equal(r.public_content_scores.total_observed_net_score,24);
  assert.match(r.warning,/not.*votes this account cast/i);
});
test('review queue methods match memory repository contract and persist state transitions',async()=>{
  const repo=createMemoryRepo({now:()=>NOW});
  const a=await repo.createAccount({username:'example'});
  const row=await repo.createPreventionReview({account_id:a.id,draft_id:null,reason:'Please review this submission',state:'held'});
  assert.equal((await repo.listPreventionReviews(a.id)).length,1);
  assert.equal((await repo.getPreventionReview(row.id)).state,'held');
  const done=await repo.finishPreventionReview(row.id,'released','Completed manual examination.');
  assert.equal(done.state,'released');
  await assert.rejects(()=>repo.finishPreventionReview(row.id,'cleared','Again'),/no longer held/i);
  await repo.clearPreventionReviews(a.id);
  assert.equal((await repo.listPreventionReviews(a.id)).length,0);
});
test('delete account cascades memory review queue',async()=>{
  const repo=createMemoryRepo({now:()=>NOW});const a=await repo.createAccount({username:'example'});
  await repo.createPreventionReview({account_id:a.id,reason:'A legitimate test record',state:'held'});
  await repo.deleteAccount(a.id);assert.equal((await repo.listPreventionReviews(a.id)).length,0);
});
