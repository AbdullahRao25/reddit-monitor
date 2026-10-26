import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../src/lib/api.js';

const ID = '11111111-1111-4111-8111-111111111111';

test('Preventer reads activity + readiness from the backend',async()=>{
  const before=globalThis.fetch;
  globalThis.fetch=async(path)=>{
    assert.equal(path,`/api/preventer/accounts/${ID}`);
    return {ok:true,status:200,json:async()=>({activity:{totals:{items:2}},readiness:{decision:'review'}})};
  };
  try{const data=await api.preventerAccount(ID);assert.equal(data.activity.totals.items,2)}finally{globalThis.fetch=before}
});

test('onboarding checklist is written using PUT, with nullable booleans',async()=>{
  const before=globalThis.fetch;
  globalThis.fetch=async(path,params)=>{
    assert.equal(path,`/api/preventer/accounts/${ID}/onboarding`);
    assert.equal(params.method,'PUT');
    assert.deepEqual(JSON.parse(params.body),{email_verified:null,two_factor_enabled:true,rules_reviewed:false,notes:''});
    return {ok:true,status:200,json:async()=>({readiness:{decision:'review'}})};
  };
  try{const data=await api.preventerOnboarding(ID,{email_verified:null,two_factor_enabled:true,rules_reviewed:false,notes:''});assert.equal(data.readiness.decision,'review')}finally{globalThis.fetch=before}
});

test('preflight sends a draft for read-only analysis, not publication',async()=>{
  const before=globalThis.fetch;
  globalThis.fetch=async(path,params)=>{
    assert.equal(path,'/api/preventer/preflight');assert.equal(params.method,'POST');
    assert.equal(JSON.parse(params.body).subreddit,'example');
    return {ok:true,status:200,json:async()=>({report:{decision:'ready'}})};
  };
  try{const response=await api.preventerScan({accountId:ID,subreddit:'example',kind:'post',title:'Hello',text:'World'});assert.equal(response.report.decision,'ready')}finally{globalThis.fetch=before}
});
