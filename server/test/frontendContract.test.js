import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRemoval } from '../src/content.js';
import { assessEarlyRisk } from '../src/stealth/earlyRisk.js';

test('sitewide removal categories accept Reddit raw value and internal alias', () => {
 assert.equal(classifyRemoval({name:'t3_a',removed_by_category:'reddit',selftext:''}),'spam_filtered');
 assert.equal(classifyRemoval({name:'t3_a',removed_by_category:'spam_filtered',selftext:''}),'spam_filtered');
});
test('activity before a removal does not count toward no-pause signal', () => {
 const now=Date.parse('2026-10-20T12:00:00Z'), day=86400000;
 const items=[
  {id:'r',kind:'post',createdAt:now-day,removalStatus:'spam_filtered'},
  {id:'a',kind:'post',createdAt:now-2*day,removalStatus:'visible'},
  {id:'b',kind:'post',createdAt:now-2*day+1000,removalStatus:'visible'},
  {id:'c',kind:'post',createdAt:now-day+3600000,removalStatus:'visible'},
 ];
 const result=assessEarlyRisk({account:{stealth_mode:true},profile:null,items,now});
 assert.equal(result.signals.some(s=>s.key==='early_no_cooldown'),false);
});
