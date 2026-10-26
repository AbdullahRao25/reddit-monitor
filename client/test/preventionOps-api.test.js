import test from 'node:test';
import assert from 'node:assert/strict';
import {api} from '../src/lib/api.js';
const A='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const R='bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const mock=async(impl,run)=>{const old=globalThis.fetch;globalThis.fetch=impl;try{await run();}finally{globalThis.fetch=old;}};
test('prevention dashboard reads locally stored overview',()=>mock(async(path)=>{
 assert.equal(path,'/api/prevention/overview');return {ok:true,status:200,json:async()=>({accounts:[]})};
},async()=>assert.deepEqual((await api.preventionOverview()).accounts,[])));
test('creating a review saves a local operator reason, not a Reddit action',()=>mock(async(path,options)=>{
 assert.equal(path,`/api/accounts/${A}/prevention/reviews`);
 assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(options.body),{reason:'Needs review'});
 return {ok:true,status:201,json:async()=>({review:{state:'held'}})};
},async()=>assert.equal((await api.preventionHold(A,'Needs review')).review.state,'held')));
test('release carries a reason and is not automatic publication',()=>mock(async(path,options)=>{
 assert.equal(path,`/api/accounts/${A}/prevention/reviews/${R}/release`);
 assert.equal(JSON.parse(options.body).reason,'Completed manual review');
 return {ok:true,status:200,json:async()=>({notice:'No Reddit action was sent.'})};
},async()=>assert.match((await api.preventionComplete(A,R,'release','Completed manual review')).notice,/No Reddit/)));
