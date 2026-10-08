import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ensureTransactionEvidence} from '../scripts/ensure-transaction-evidence.mjs';

test('deployment migration adds the evidence column once and verifies it',()=>{
  const calls=[];let added=false;
  const changed=ensureTransactionEvidence(args=>{calls.push(args);if(args.includes('--file')){added=true;return '[]';}return JSON.stringify([{success:true,results:[{name:'ticker'},...(added?[{name:'transaction_evidence'}]:[])]}]);});
  assert.equal(changed,true);assert.equal(calls.filter(x=>x.includes('--file')).length,1);assert.equal(calls.length,3);
});
test('deployment migration leaves an existing evidence column untouched',()=>{
  let calls=0;assert.equal(ensureTransactionEvidence(()=>{calls++;return JSON.stringify([{success:true,results:[{name:'transaction_evidence'}]}]);}),false);assert.equal(calls,1);
});
test('deployment stops on failed queries or a missing table',()=>{
  for(const output of ['bad json','[]','[{"success":false}]','[{"success":true,"results":[]}]'])assert.throws(()=>ensureTransactionEvidence(()=>output));
});
