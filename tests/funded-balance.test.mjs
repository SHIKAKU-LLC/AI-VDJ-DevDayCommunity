import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptsFundedBalance,validTopUpProtection} from '../cloud/generation/funded-balance.mjs';
const now=()=>1000000;
const protection=()=>({kind:'existing-credit-only-v1',approved:true,thresholdUsd:10,topUpAmountUsd:50,maximumSpendUsd:1.5,observedAtMs:now(),evidenceSha256:'a'.repeat(64)});
test('existing-credit approval preserves the ON setting and reserves the whole run above the top-up trigger',()=>{
 const balance={usd:100,autoTopUp:true,topUpProtection:protection()};
 assert(acceptsFundedBalance(balance,{now,requiredUsd:1}));assert.equal(balance.autoTopUp,true);
 for(const usd of [11.5,11.49,10,0])assert(!acceptsFundedBalance({...balance,usd},{now,requiredUsd:1}));
 assert(!acceptsFundedBalance({...balance,topUpProtection:undefined},{now,requiredUsd:1}));
 assert(acceptsFundedBalance({usd:1,autoTopUp:false},{now,requiredUsd:1}));
});
test('top-up approval refuses stale evidence, unknown fields, absent consent and an expanded run budget',()=>{
 for(const patch of [{approved:false},{maximumSpendUsd:2.51},{maximumSpendUsd:0},{observedAtMs:now()+1},{observedAtMs:now()-3600001},{thresholdUsd:-1},{topUpAmountUsd:0},{evidenceSha256:'x'},{unreviewed:true}])assert(!validTopUpProtection({...protection(),...patch},{now}));
 assert(!validTopUpProtection(protection(),{now,requiredUsd:2}));
});
test('five-person existing-credit approval reserves USD 2.50 above the top-up trigger',()=>{
 const balance={usd:13,autoTopUp:true,topUpProtection:{...protection(),maximumSpendUsd:2.5}};
 assert(acceptsFundedBalance(balance,{now,requiredUsd:2.5}));
 assert(!acceptsFundedBalance({...balance,usd:12.5},{now,requiredUsd:2.5}));
 assert(!acceptsFundedBalance(balance,{now,requiredUsd:2.51}));
});
