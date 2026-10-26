import test from 'node:test';
import assert from 'node:assert/strict';
import { api, normalizeAccount, normalizeDetail, riskTrendFrom } from '../src/lib/api.js';

function mockFetch(body, status=200) {
 const old=globalThis.fetch; const calls=[];
 globalThis.fetch=async (url,opts={})=>{calls.push({url,opts});return {ok:status>=200&&status<300,status,json:async()=>body};};
 return {calls, restore:()=>{globalThis.fetch=old;}};
}

test('account and detail normalizers preserve backend data and calculate karma', () => {
 const acct=normalizeAccount({id:'x',username:'u',link_karma:2,comment_karma:5,items_sampled:9,items_removed:3});
 assert.equal(acct.karma,7); assert.equal(acct.posts_30d,9);assert.equal(acct.removed_30d,3);
 const d=normalizeDetail({account:acct,history:[{checked_at:'2026-01-01T00:00:00Z',link_karma:2,comment_karma:5}],removed:[],recent:[],alerts:[]});
 assert.equal(d.history[0].karma,7);
});
test('quick profile check calls live Express route without creating an account', async () => {
 const m=mockFetch({status:'active',assessment:{score:12}});
 try {const result=await api.checkLive('example');assert.equal(result.assessment.score,12);assert.equal(m.calls.length,1);assert.equal(m.calls[0].url,'/api/check-live');assert.equal(m.calls[0].opts.method,'POST');assert.deepEqual(JSON.parse(m.calls[0].opts.body),{username:'example'});}finally{m.restore()}
});
test('create account sends optional label and notes', async () => {
 const m=mockFetch({account:{username:'example'}},201);
 try {await api.createAccount('example',{label:'Test',notes:'Team notes'});assert.deepEqual(JSON.parse(m.calls[0].opts.body),{username:'example',label:'Test',notes:'Team notes'});}finally{m.restore()}
});
test('acknowledge all uses server endpoint', async () => {
 const m=mockFetch({},204);
 try {await api.resolveAllAlerts();assert.equal(m.calls[0].url,'/api/alerts/ack-all');assert.equal(m.calls[0].opts.method,'POST');}finally{m.restore()}
});
test('risk trend ignores checks without a risk score', () => {
 const points=riskTrendFrom([[{created_at:new Date().toISOString(),risk_score:null}]],2);
 assert.deepEqual(points,[]);
});
