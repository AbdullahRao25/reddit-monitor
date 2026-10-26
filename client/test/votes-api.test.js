import test from 'node:test';
import assert from 'node:assert/strict';
import {api,voteFileKind,communityLabel} from '../src/lib/api.js';
const D='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const withMock=async(impl,fn)=>{const old=globalThis.fetch;globalThis.fetch=impl;try{return await fn();}finally{globalThis.fetch=old;}};
test('vote files are recognised by their export names',()=>{
 assert.equal(voteFileKind('post_votes.csv'),'post');
 assert.equal(voteFileKind('comment_votes (1).csv'),'comment');
 assert.equal(voteFileKind('saved_items.csv'),null);
 assert.equal(voteFileKind('saved_comments.csv'),null);
 assert.equal(voteFileKind('posts.csv'),null);
 assert.equal(voteFileKind('comment_votes_extra.csv'),null);
 assert.equal(voteFileKind('POST_VOTES (2).CSV'),'post');
 assert.equal(communityLabel('u_spez'),'u/spez');assert.equal(communityLabel('pics'),'r/pics');
});
test('an import sends the raw CSV as text/csv with its kind',()=>withMock(async(path,options)=>{
 assert.equal(path,`/api/accounts/${D}/votes/import?kind=comment`);
 assert.equal(options.method,'POST');assert.equal(options.headers['Content-Type'],'text/csv');
 assert.equal(options.body,'id,permalink,direction\nc1,x,up');
 return {ok:true,status:200,json:async()=>({imported:1})};
},async()=>assert.equal((await api.importVotes(D,'comment','id,permalink,direction\nc1,x,up')).imported,1)));
test('vote filters become query parameters',()=>withMock(async(path)=>{
 assert.equal(path,`/api/accounts/${D}/votes?direction=down`);
 return {ok:true,status:200,json:async()=>({votes:[]})};
},async()=>api.votes(D,{direction:'down'})));
