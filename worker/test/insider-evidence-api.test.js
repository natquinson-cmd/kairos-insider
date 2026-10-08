import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {DatabaseSync} from 'node:sqlite';
import {aggregateInsiderSignalRows, aggregateD1InsiderSignals, classifyInsiderTransaction, preferInsiderTransactionEvidence, validatedPurchaseClusters} from '../src/insider-transaction.js';

const source=fs.readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const today=new Date().toISOString().slice(0,10);
function harness(rows){
  const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE insider_transactions_history (ticker TEXT, company TEXT, insider TEXT, insider_cik TEXT, title TEXT, trans_type TEXT, trans_code TEXT, transaction_evidence TEXT, value REAL, shares REAL, price REAL, trans_date TEXT, filing_date TEXT, source TEXT, accession TEXT, cik TEXT, shares_after REAL, line_num INTEGER)');
  const insert=db.prepare('INSERT INTO insider_transactions_history VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  rows.forEach((row,i)=>insert.run('TEST','Test company',row.insider||'Buyer '+i,row.insiderCik||String(i+1),'CEO',row.type||'buy',row.code??null,row.evidence?JSON.stringify(row.evidence):null,100000,1000,100,today,today,'SEC',row.accession||'filing-'+i,'123',null,1));
  const HISTORY={prepare(sql){return {bind(...values){return {async all(){return {results:db.prepare(sql).all(...values)};},async first(){return db.prepare(sql).get(...values);}};},async all(){return {results:db.prepare(sql).all()};}};}};
  const context={console,Date,URL,Response,aggregateInsiderSignalRows,aggregateD1InsiderSignals,classifyInsiderTransaction,preferInsiderTransactionEvidence,jsonResponse:(data,status)=>Response.json(data,{status})};
  vm.createContext(context);
  const start=source.indexOf('async function handleSignalsInsiderClusters('),end=source.indexOf('async function handleSignalsInsiderNetFlow(',start);
  vm.runInContext(source.slice(start,end),context);
  const statsStart=source.indexOf('async function handleHistoryInsiderStats('),statsEnd=source.indexOf('// Normalisation pour matcher',statsStart);
  vm.runInContext(source.slice(statsStart,statsEnd),context);
  return {context,HISTORY,close:()=>db.close()};
}
test('D1 cluster participants exclude awards exercises unknown buys and employee plans',async()=>{
  const h=harness([{code:'P'}, {code:'A'}, {code:'M'}, {code:'F'}, {code:'G'}, {code:null}, {code:'P',evidence:{transactionFootnotes:[{id:'F1',text:'Shares acquired under the employee stock purchase plan.'}]}}]);
  try{const response=await h.context.handleSignalsInsiderClusters(new URL('https://api.invalid/api/signals/insider-clusters?minTx=2'),{HISTORY:h.HISTORY},'');assert.equal(response.status,200);assert.equal((await response.json()).total,0);}finally{h.close();}
});

test('D1 cluster counts documented P buyers and keeps raw awards out of value',async()=>{
  const h=harness([{code:'P'}, {code:'P'}, {code:'M'}]);
  try{const response=await h.context.handleSignalsInsiderClusters(new URL('https://api.invalid/api/signals/insider-clusters?minTx=2'),{HISTORY:h.HISTORY},'');const body=await response.json();assert.equal(body.total,1);assert.equal(body.items[0].buyValue,200000);}finally{h.close();}
});

test('D1 cluster query includes a corrected other grant before discarding stale P evidence',async()=>{
  const base={insider:'Buyer',insiderCik:'99',accession:'same-filing'};
  const h=harness([{...base,code:'P'}, {...base,code:'A',type:'other'}]);
  try{const response=await h.context.handleSignalsInsiderClusters(new URL('https://api.invalid/api/signals/insider-clusters?minTx=1'),{HISTORY:h.HISTORY},'');assert.equal((await response.json()).total,0);}finally{h.close();}
});

test('D1 correction spanning two bounded pages cannot leave its original P in a cluster',async()=>{
  const base={insider:'Buyer',insiderCik:'99',accession:'zz-corrected-filing'};
  const h=harness([...Array.from({length:999},()=>({code:'M'})), {...base,code:'P'}, {...base,code:'A',type:'other'}]);
  try{const response=await h.context.handleSignalsInsiderClusters(new URL('https://api.invalid/api/signals/insider-clusters?minTx=1'),{HISTORY:h.HISTORY},'');assert.equal(response.status,200);assert.equal((await response.json()).total,0);}finally{h.close();}
});

test('D1 history volumes exclude broad buy rows without documented purchase evidence',async()=>{
  const h=harness([{code:'P'},{code:'A'},{code:'M'},{code:null},{code:'P',evidence:{purchaseSignalEligible:false,purchaseSignalReason:'employee-plan'}}]);
  try{const response=await h.context.handleHistoryInsiderStats(new URL('https://api.invalid/api/history/insider-stats?ticker=TEST'),{HISTORY:h.HISTORY},'');const body=await response.json();assert.equal(response.status,200);assert.equal(body.buy.count,1);assert.equal(body.buy.totalValue,100000);}finally{h.close();}
});

test('distinct source transaction indices cannot be merged by exclusion evidence',()=>{
  const row={source:'SEC',accession:'one',ticker:'TEST',insider:'Buyer',date:today,shares:100,price:10,value:1000,type:'buy',code:'P',transactionIndex:1};
  const grant={...row,code:'A',transactionIndex:2};
  for(const rows of [[row,grant],[grant,row]])assert.equal(preferInsiderTransactionEvidence(rows).filter(row=>classifyInsiderTransaction(row).eligiblePurchase).length,1);
});

test('added security details do not resurrect an otherwise exact corrected purchase',()=>{
  const row={source:'SEC',accession:'one',ticker:'TEST',insider:'Buyer',date:today,shares:100,price:10,value:1000,type:'buy',code:'P'};
  const grant={...row,code:'A',securityTitle:'Common Stock'};
  for(const rows of [[row,grant],[grant,row]])assert.equal(preferInsiderTransactionEvidence(rows).filter(row=>classifyInsiderTransaction(row).eligiblePurchase).length,0);
  assert.equal(preferInsiderTransactionEvidence([{...row,securityTitle:'Class B'},grant]).length,2);
});

test('D1 historical top ranking requires purchase evidence across all repeated rows',async()=>{
  const h=harness([{code:'A',insider:'Grant',insiderCik:'90'},{code:'A',insider:'Grant',insiderCik:'90'},{code:'P',insider:'Buyer',insiderCik:'91'},{code:'P',insider:'Buyer',insiderCik:'91'}]);
  try{const response=await h.context.handleHistoryInsiderTop(new URL('https://api.invalid/api/history/insider-top'),{HISTORY:h.HISTORY},'');const body=await response.json();assert.equal(response.status,200);assert.equal(body.count,1);assert.equal(body.insiders[0].insider,'Buyer');assert.equal(body.insiders[0].total_value,200000);}finally{h.close();}
});

test('legacy KV clusters require three documented purchase actors',()=>{
  const row={source:'SEC',ticker:'TEST',cik:'123',date:today,type:'buy',code:'P',value:100};
  const payload={clusters:[{ticker:'TEST',cik:'123',insiderCount:9,totalValue:9999}]};
  assert.equal(validatedPurchaseClusters(payload,[{...row,insider:'One'},{...row,insider:'Two'},{...row,code:'A',insider:'Three'}]).clusters.length,0);
  const good=validatedPurchaseClusters(payload,[{...row,insider:'One'},{...row,insider:'Two'},{...row,insider:'Three'}]);
  assert.equal(good.clusters[0].insiderCount,3);assert.equal(good.clusters[0].totalValue,300);
});

test('English homepage SSR rewrites the current title and descriptions',()=>{
  const dictionary={window:{KairosI18n:{DICT:{fr:{},en:{}}}}};vm.runInNewContext(fs.readFileSync(new URL('../../assets/landing-i18n.js',import.meta.url),'utf8'),dictionary);
  const start=source.indexOf('function rewriteRootHtmlForEn('),end=source.indexOf('\n}',start)+2,context={};
  vm.runInNewContext(source.slice(start,end),context);
  const html=context.rewriteRootHtmlForEn(fs.readFileSync(new URL('../../index.html',import.meta.url),'utf8'));
  assert.ok(html.includes('<title>'+dictionary.window.KairosI18n.DICT.en['lp.page_title']+'</title>'));
  assert.ok(html.includes('content="'+dictionary.window.KairosI18n.DICT.en['lp.page_description']+'"'));
});
