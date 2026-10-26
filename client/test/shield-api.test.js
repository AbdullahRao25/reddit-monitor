import test from 'node:test';
import assert from 'node:assert/strict';
import {api} from '../src/lib/api.js';
const D='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const withMock=async(impl,fn)=>{const old=globalThis.fetch;globalThis.fetch=impl;try{return await fn();}finally{globalThis.fetch=old;}};
test('Shield dashboard reads the backend rather than local demonstration data',()=>withMock(async(path)=>{
  assert.equal(path,'/api/shield/overview');return {ok:true,status:200,json:async()=>({drafts:[{id:D}],holds:[],incidents:[],events:[]})};
},async()=>assert.equal((await api.shieldOverview()).drafts.length,1)));
test('Shield submits drafts to the managed review endpoint, not Reddit',()=>withMock(async(path,options)=>{
 assert.equal(path,'/api/shield/drafts');assert.equal(options.method,'POST');
 assert.equal(JSON.parse(options.body).accountId,D);
 return {ok:true,status:201,json:async()=>({draft:{state:'review'}})};
},async()=>assert.equal((await api.shieldCreateDraft({accountId:D,subreddit:'example',kind:'post',text:'Test'})).draft.state,'review')));
test('Manual outcomes cannot be mistaken for auto-verified status',()=>withMock(async(path,options)=>{
 assert.equal(path,`/api/shield/drafts/${D}/outcomes`);assert.equal(JSON.parse(options.body).visibility,'unknown');
 return {ok:true,status:201,json:async()=>({outcome:{source:'manual',visibility:'unknown'}})};
},async()=>assert.equal((await api.shieldRecordOutcome(D,{visibility:'unknown'})).outcome.source,'manual')));
