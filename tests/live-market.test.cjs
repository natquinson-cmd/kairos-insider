const {test}=require('node:test'),assert=require('node:assert/strict');const {convergences,validTicker}=require('../assets/clarity/live-market-model.js');
const market=require('../assets/clarity/live-market-model.js');
const now='2026-10-08',buy=(extra={})=>({ticker:'ABC',company:'Company',currency:'USD',type:'buy',transCode:'P',insider:'Alice Doe',insiderCik:'1',fileDate:'2026-10-08',date:'2026-10-06',value:100,...(extra.type==='sell'?{transCode:'S'}:{}),...extra});

test('purchase signals require source evidence and exclude free shares and employee plans',()=>{
 const rows=[buy({code:'P'}),buy({insider:'Bob',insiderCik:'2',code:"Acquisition définitive d'actions gratuites (livraison)",source:'amf'}),buy({insider:'Carol',insiderCik:'3',code:'P',transactionFootnotes:[{id:'F1',text:'Purchased under the employee stock purchase plan at a discount.'}]}),buy({insider:'Legacy',insiderCik:'4',transCode:null})];
 const result=market.purchases(rows,{days:7,now});
 assert.equal(result[0].purchaseCount,1);assert.equal(result[0].buyers,1);assert.equal(result[0].amount,100);
 assert.deepEqual(convergences(rows,{days:7,now}),[]);
});

test('documented European purchases and planned SEC purchases remain eligible',()=>{
 for(const evidence of [{code:'Kauf',source:'bafin'},{type:'P',code:'Acquisition',source:'amf'},{code:'P',form10b5One:true}]){
  assert.equal(market.purchases([buy(evidence)],{days:7,now}).length,1);
 }
});
test('purchase screen groups only actual fresh purchases and does not use trade dates as filing dates',()=>{
 const list=market.purchases([buy(),buy({type:'sell',value:900}),buy({transCode:'M'}),buy({transCode:'A'}),buy({fileDate:null}),buy({fileDate:'2026-10-01'}),buy({fileDate:'2026-10-09'})],{days:7,now});
 assert.equal(list.length,1);assert.equal(list[0].amount,100);assert.equal(list[0].purchaseCount,1);assert.equal(list[0].sales,900);
});
test('today means one UTC calendar date and does not silently become 24 hours',()=>{assert.equal(market.purchases([buy({fileDate:'2026-10-07'}),buy()],{days:1,now})[0].purchaseCount,1);});
test('buyer identity merges padded CIKs, spelling punctuation and name-only copies without counting unknown people',()=>{
 const result=market.purchases([buy(),buy({insiderCik:'0000000001',insider:'DOE, ALICE',value:200}),buy({insiderCik:null,insider:' Alice  Doe ',value:300}),buy({insiderCik:'0',insider:'Unknown',value:400})],{days:7,now})[0];
 assert.equal(result.buyers,1);assert.equal(result.amount,1000);
});
test('deduplication keeps genuine separate lines within an accession and normalizes numeric representations',()=>{
 const a=buy({accession:'0001-26-123',shares:10,price:10}),b=buy({accession:'0001-26-123',shares:20,price:10,value:200}),c=buy({accession:'0001-26-123',shares:10,price:10,lineId:'2'});
 const result=market.purchases([a,{...a,insiderCik:'0001',value:'100',shares:'10',price:'10'},b,c],{days:7,now})[0];assert.equal(result.purchaseCount,3);assert.equal(result.amount,400);
});

test('richer employee-plan evidence supersedes a bare P copy in either order',()=>{
 const bare=buy({accession:'0000000001-26-000001',shares:10,price:10}),excluded={...bare,securityTitle:'Common Stock',transactionFootnotes:[{id:'F1',text:'Purchased under the Employee Stock Purchase Plan.'}]};
 for(const rows of [[bare,excluded],[excluded,bare]]){
  const unique=market.deduplicate(rows);assert.equal(unique.length,1);assert.equal(market.classify(unique[0]).reason,'employee-plan');
  assert.deepEqual(market.purchases(rows,{days:7,now}),[]);
  assert.deepEqual(convergences([...rows,buy({insider:'Bob',insiderCik:'2'})],{days:7,now}),[]);
 }
});

test('a corrected grant code supersedes a stale purchase for the same filing line',()=>{
 const stale=buy({accession:'0000000001-26-000001',lineId:'0',shares:10,price:10}),corrected={...stale,type:'other',code:'A',transCode:'A'};
 for(const rows of [[stale,corrected],[corrected,stale]]){
  const unique=market.deduplicate(rows);assert.equal(unique.length,1);assert.equal(market.classify(unique[0]).reason,'grant');assert.deepEqual(market.purchases(rows,{days:7,now}),[]);
 }
});

test('richer purchase evidence can qualify a formerly undocumented copy',()=>{
 const documented=buy({accession:'0000000001-26-000001',shares:10,price:10}),legacy={...documented,transCode:null};
 for(const rows of [[legacy,documented],[documented,legacy]])assert.equal(market.purchases(rows,{days:7,now})[0].purchaseCount,1);
});

test('negative persisted evidence wins without depending on arrival order',()=>{
 const bare=buy({accession:'0000000001-26-000001',shares:10,price:10}),blocked={...bare,purchaseSignalEligible:false,purchaseSignalReason:'employee-plan'};
 for(const rows of [[bare,blocked],[blocked,bare]])assert.deepEqual(market.purchases(rows,{days:7,now}),[]);
});

test('distinct transaction lines and distinct filings cannot suppress genuine purchases',()=>{
 const eligible=buy({accession:'0000000001-26-000001',transactionIndex:0,shares:10,price:10}),plan={...eligible,transactionFootnotes:[{id:'F1',text:'Acquired through an employee stock purchase plan.'}]};
 for(const excluded of [{...plan,transactionIndex:1},{...plan,accession:'0000000001-26-000002'}]){
  for(const rows of [[eligible,excluded],[excluded,eligible]]){const result=market.purchases(rows,{days:7,now})[0];assert.equal(result.purchaseCount,1);assert.equal(result.amount,100);assert.equal(result.transactions.length,2);}
 }
});

test('same-size purchases and sales are distinct economic operations',()=>{
 const purchase=buy({accession:'0000000001-26-000001',shares:10,price:10}),sale={...purchase,type:'sell',transCode:'S'};
 const result=market.purchases([purchase,sale],{days:7,now})[0];assert.equal(result.purchaseCount,1);assert.equal(result.sales,100);assert.equal(result.transactions.length,2);
});

test('explicitly different share classes remain distinct even with a sparse duplicate',()=>{
 const base=buy({accession:'0000000001-26-000001',shares:10,price:10}),eligible={...base,securityTitle:'Class A Common Stock'},excluded={...base,securityTitle:'Class B Common Stock',transactionFootnotes:[{text:'Employee Stock Purchase Plan.'}]};
 for(const rows of [[base,eligible,excluded],[excluded,base,eligible],[eligible,excluded,base]]){
  const result=market.purchases(rows,{days:7,now})[0];assert.equal(result.purchaseCount,1);assert.equal(result.amount,100);assert.equal(result.purchases[0].securityTitle,'Class A Common Stock');
 }
});

test('unlinked records cannot replace each other merely because their amounts match',()=>{
 const purchase=buy({shares:10,price:10}),grant={...purchase,type:'other',transCode:'A'};
 assert.equal(market.deduplicate([purchase,grant]).length,2);
});
test('purchase grouping never adds different or unknown currencies together',()=>{
 const results=market.purchases([buy({ticker:' abc '}),buy({currency:'EUR',insider:'Bob',insiderCik:'2'}),buy({currency:''})],{days:7,now});assert.equal(results.length,3);assert.deepEqual(results.map(r=>r.currency).sort(),['','EUR','USD']);
});
test('sales cannot make an old purchase convergence fresh',()=>{
 const rows=[buy({fileDate:'2026-09-28',date:'2026-09-27'}),buy({insider:'Bob',insiderCik:'2',fileDate:'2026-09-29',date:'2026-09-28'}),buy({type:'sell'})];assert.equal(convergences(rows,{days:7,now}).length,0);
});
test('convergence uses complete trade window even when an earlier buyer publication is outside the filing filter',()=>{
 const rows=[buy({fileDate:'2026-09-28',date:'2026-09-27'}),buy({insider:'Bob',insiderCik:'2'})];const result=convergences(rows,{days:7,windowDays:30,now})[0];assert.equal(result.buyers,2);assert.equal(result.amount,200);assert.equal(result.lastPublication,'2026-10-08');assert.equal(convergences(rows,{days:7,windowDays:7,now}).length,0);
});
test('convergences exclude unknown future impossible and old trade dates',()=>{
 for(const date of [null,'2026-10-09','2026-02-30','2026-08-01'])assert.equal(convergences([buy(),buy({date,insider:'Bob',insiderCik:'2'})],{days:7,now}).length,0);
});
test('old and unknown trade dates remain explicit on purchases and are ranked after timely buys',()=>{
 const results=market.purchases([buy({ticker:'OLD',date:'2026-08-01',value:9999}),buy({ticker:'MISSING',date:null}),buy()],{days:7,now});assert.equal(results[0].ticker,'ABC');assert.equal(results.find(r=>r.ticker==='OLD').oldTradeCount,1);assert.equal(results.find(r=>r.ticker==='OLD').lateCount,1);assert.equal(results.find(r=>r.ticker==='MISSING').unknownTradeCount,1);
});
test('crossovers match explicit activist 13D symbols only and distinguish source unavailable from zero matches',()=>{
 const groups=market.purchases([buy(),buy({ticker:'ABC.PA'})],{days:7,now}),filings=[{form:'SCHEDULE 13D/A',isActivist:true,ticker:'abc',fileDate:now,percentDelta:1,sharesDelta:10,filerName:'Distinct Capital',filerCik:'9'},{form:'13G',isActivist:true,ticker:'ABC.PA',fileDate:now},{form:'13D',isActivist:false,ticker:'ABC.PA',fileDate:now},{form:'13D',isActivist:true,ticker:'AB',targetName:'Company',fileDate:now}];
 const result=market.crossovers(groups,{available:true,filings},{days:7,now});assert.equal(result.available,true);assert.equal(result.rows.length,1);assert.equal(result.rows[0].activistFilings[0].eventKind,'increase');assert.equal(market.crossovers(groups,{available:false},{days:7,now}).rows,null);
});
test('initial 13D and amendments do not imply new purchases; percent-only changes are not confirmed share increases',()=>{
 const group=market.purchases([buy()],{days:7,now}),filings=[{form:'SCHEDULE 13D',isActivist:true,ticker:'ABC',fileDate:now,isFirstFiling:true},{form:'13D/A',isActivist:true,ticker:'ABC',fileDate:now,percentDelta:1},{form:'13D/A',isActivist:true,ticker:'ABC',fileDate:now,sharesDelta:0}].map(f=>({...f,filerName:'Distinct Capital'}));
 assert.deepEqual(market.crossovers(group,{available:true,filings},{days:7,now}).rows[0].activistFilings.map(r=>r.eventKind),['initial','amendment','amendment']);
});
test('convergence distinguishes the rolling window end from the most recent executed purchase',()=>{const result=convergences([buy(),buy({insider:'Bob',insiderCik:'2',date:'2026-10-04'})],{days:7,now})[0];assert.equal(result.endDate,now);assert.equal(result.lastTradeDate,'2026-10-06');});
test('an ambiguous name-only row cannot add a third buyer to two known CIKs',()=>{const result=market.purchases([buy(),buy({insiderCik:'2',value:200}),buy({insiderCik:null,value:300})],{days:7,now})[0];assert.equal(result.buyers,2);});
test('hyphenated and compact accessions describe the same filing, not additional purchases',()=>{const result=market.purchases([buy({accession:'0000000001-26-000001'}),buy({accession:'000000000126000001'})],{days:7,now})[0];assert.equal(result.purchaseCount,1);});
test('native amounts in different currencies cannot reorder otherwise equal companies',()=>{const result=market.purchases([buy({ticker:'ZZZ',currency:'JPY',value:10000}),buy({ticker:'AAA',value:100})],{days:7,now});assert.deepEqual(result.map(r=>r.ticker),['AAA','ZZZ']);});
test('database execution codes exclude awards even if a legacy row says buy',()=>{assert.deepEqual(market.purchases([buy({trans_code:'A'})],{days:7,now}),[]);});
test('live convergence excludes missing publication and execution after publication',()=>{for(const extra of [{fileDate:null},{date:'2026-10-07',fileDate:'2026-10-06'}])assert.deepEqual(convergences([buy(),buy({insider:'Bob',insiderCik:'2',...extra})],{days:7,now}),[]);});
test('crossovers need an identified reporting actor distinct from the buying insider',()=>{
 const groups=market.purchases([buy()],{days:7,now}),filing={form:'13D',isActivist:true,ticker:'ABC',fileDate:now};
 for(const actor of [{},{filerCik:'0001'},{filerName:'DOE, ALICE'}])assert.equal(market.crossovers(groups,{available:true,filings:[{...filing,...actor}]},{days:7,now}).rows.length,0);
 assert.equal(market.crossovers(groups,{available:true,filings:[{...filing,filerCik:'9',filerName:'Other Capital'}]},{days:7,now}).rows.length,1);
});
test('convergence counts people rather than repeated purchases',()=>{const rows=[{ticker:'T',date:'2026-09-01',type:'buy',transCode:'P',insiderCik:'1',value:100},{ticker:'T',date:'2026-09-02',type:'buy',transCode:'P',insiderCik:'1',value:200}];assert.equal(convergences(rows).length,0);rows.push({ticker:'T',date:'2026-09-03',type:'buy',transCode:'P',insiderCik:'2',value:50});assert.equal(convergences(rows)[0].buyers,2);assert.equal(convergences(rows)[0].amount,350);});
test('convergence excludes unknown identities and purchases outside 30 days',()=>{const rows=[{ticker:'T',date:'2026-08-01',type:'buy',transCode:'P',insider:'A',value:100},{ticker:'T',date:'2026-09-15',type:'buy',transCode:'P',insider:'B',value:200},{ticker:'T',date:'2026-09-16',type:'buy',value:300}];assert.equal(convergences(rows).length,0);});
test('convergence keeps currencies separate',()=>{assert.equal(convergences([{ticker:'T',currency:'USD',date:'2026-09-01',type:'buy',transCode:'P',insider:'A'},{ticker:'T',currency:'EUR',date:'2026-09-02',type:'buy',transCode:'P',insider:'B'}]).length,0);});
test('all sales on the last day remain visible regardless of input ordering',()=>{const rows=[{ticker:'T',date:'2026-09-01',type:'buy',transCode:'P',insider:'A',value:100},{ticker:'T',date:'2026-09-01',type:'buy',transCode:'P',insider:'B',value:100},{ticker:'T',date:'2026-09-01',type:'sell',insider:'C',value:999}];assert.equal(convergences(rows)[0].sales,999);assert.equal(convergences(rows)[0].transactions.length,3);});
test('placeholder symbols cannot combine unrelated private issuers',()=>{const rows=[{ticker:'NONE',company:'Fund A',date:'2026-09-01',type:'buy',transCode:'P',insider:'A'},{ticker:'NONE',company:'Fund B',date:'2026-09-02',type:'buy',transCode:'P',insider:'B'}];assert.deepEqual(convergences(rows),[]);});
test('valid ticker check rejects placeholders and keeps exchange and share class suffixes',()=>{for(const value of [null,'','NONE',' none ','N/A','UNKNOWN','-','—'])assert.equal(validTicker(value),false);for(const value of ['AAPL','BRK.B','BRK-B','MC.PA','0700.HK',' sap.de '])assert.equal(validTicker(value),true);});
test('convergence groups canonical symbols and sums numeric string amounts',()=>{const rows=[{ticker:' t ',date:'2026-09-01',type:'buy',transCode:'P',insider:'A',value:'100.5'},{ticker:'T',date:'2026-09-01',type:'buy',transCode:'P',insider:'B',value:'200'},{ticker:'T',date:'2026-09-01',type:'sell',insider:'C',value:'50'}];const result=convergences(rows)[0];assert.equal(result.ticker,'T');assert.equal(result.amount,300.5);assert.equal(result.sales,50);});
test('missing purchase and sale amounts remain unknown while no sales means zero',()=>{for(const value of [null,undefined,'',true,'unknown']){const rows=[{ticker:'T',date:'2026-09-01',type:'buy',transCode:'P',insider:'A',value:100},{ticker:'T',date:'2026-09-01',type:'buy',transCode:'P',insider:'B',value}];assert.equal(convergences(rows)[0].amount,null);assert.equal(convergences(rows)[0].sales,0);rows.push({ticker:'T',date:'2026-09-01',type:'sell',insider:'C',value});assert.equal(convergences(rows)[0].sales,null);}});
