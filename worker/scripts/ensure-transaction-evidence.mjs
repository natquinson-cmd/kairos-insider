import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

// Additive and idempotent: deployments never drop or rewrite filing history.
const base=['wrangler','d1','execute','kairos-history','--remote','--json'];
export function ensureTransactionEvidence(run) {
  const columns=()=>{
    const data=JSON.parse(run([...base,'--command','PRAGMA table_info(insider_transactions_history)']));
    if(!Array.isArray(data)||!data.length||data.some(x=>x.success===false||!Array.isArray(x.results)))throw Error('Cannot inspect insider history schema');
    const rows=data.flatMap(x=>x.results);
    if(!rows.length)throw Error('Insider history table is missing');
    return rows.map(x=>x.name);
  };
  if(columns().includes('transaction_evidence'))return false;
  run([...base,'--file','migrations/006_add_transaction_evidence.sql']);
  if(!columns().includes('transaction_evidence'))throw Error('Evidence column was not created');
  return true;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const changed=ensureTransactionEvidence(args=>{
    const result=spawnSync('npx',args,{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8'});
    if(result.error||result.status!==0)throw Error('D1 schema command failed: '+(result.error?.message||result.stderr||'nonzero exit'));
    return result.stdout;
  });
  console.log(changed?'Transaction evidence column added and verified.':'Transaction evidence column already present.');
}
