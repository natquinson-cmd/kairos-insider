const {test}=require('node:test');
const assert=require('node:assert/strict');
const a=require('../assets/clarity/live-adapter.js');
test('health panel retains the server criteria used by the radar estimate',()=>{const c=a.stock({ticker:'AAPL',financialPosition:{debtEquity:{raw:1.35}},health:{kairosScore:{score:1,total:2,ratio:50,criteria:[{label:'Liquidité générale > 1',ok:false},{label:'Endettement maîtrisé',ok:true}]}}});assert.deepEqual(c.research.health.criteria.map(({label,pass})=>({label,pass})),[{label:'Liquidité générale > 1',pass:false},{label:'Endettement maîtrisé',pass:true}]);assert.equal(c.research.health.source,'kairos');});
test('health criteria expose observed values and the actual validation threshold',()=>{const c=a.stock({ticker:'T',margins:{gross:{raw:48.65}},health:{kairosScore:{criteria:[{key:'grossMargin',label:'Marge brute positive',ok:true,value:49,unit:'percent',threshold:0,comparison:'>'},{key:'debtEquity',label:'Endettement maîtrisé',ok:true,value:1.35,unit:'ratio',threshold:2,comparison:'<',minimum:0}]}}});const [gross,debt]=c.research.health.criteria;assert.equal(gross.value,49);assert.equal(gross.unit,'percent');assert.equal(debt.threshold,2);assert.equal(debt.minimum,0);assert.equal(debt.value,1.35);});
test('missing numeric data is not converted to zero',()=>{for(const x of [null,undefined,'',true,'abc'])assert.equal(a.number(x),null);assert.equal(a.number('12.5'),12.5);});
test('local health checks are not mislabeled as server scoring criteria',()=>{assert.equal(a.stock({ticker:'T'}).research.health.source,null);});
test('radar uses seven backend axes, excludes legacy govGuru and preserves unknown health',()=>{const c=a.stock({ticker:'TEST',chart:{points:[]},score:{total:72,breakdown:{insider:{score:15,max:20,dataOk:true},govGuru:{score:10,max:10,dataOk:true},health:{score:0,max:10,dataOk:false},earnings:{score:6,max:10,dataOk:true}}}});assert.equal(c.dimensions.length,7);assert.equal(c.dimensions[0],75);assert.equal(c.dimensions[2],null);assert.equal(c.dimensions[5],null);assert.equal(c.dimensions[6],60);assert.equal(c.score,72);assert.deepEqual(c.history,[]);});
test('transactions preserve filing and execution dates and actual identity',()=>{const c=a.stock({ticker:'T',chart:{points:[{date:'2026-09-18',close:12},{date:'2026-09-21',close:13}]},insiders:{transactions:[{fileDate:'2026-09-19',date:'2026-09-17',insider:'Jane Doe',insiderCik:'123',type:'buy',code:'P',value:500}]}});assert.equal(c.events[0].date,'2026-09-21');assert.equal(c.events[0].publicationDate,'2026-09-19');assert.equal(c.events[0].tradeDate,'2026-09-17');assert.equal(c.events[0].insiderName,'Jane Doe');});
test('stock chart excludes awards, employee plans, unknown purchases and mechanical disposals without dropping raw operations',()=>{
  const base={fileDate:'2026-09-19',date:'2026-09-17',value:500};
  const transactions=[
    {...base,type:'buy',code:'A',insider:'Award recipient'},
    {...base,type:'buy',code:'P',transactionFootnotes:[{id:'F1',text:'Purchased through the Employee Stock Purchase Plan.'}],insider:'Plan participant'},
    {...base,type:'buy',insider:'Legacy unknown'},
    {...base,type:'buy',code:'P',insider:'Cash buyer'},
    {...base,type:'buy',code:"Acquisition définitive d'actions gratuites (livraison)",insider:'Free shares'},
    {...base,type:'sell',code:'S',insider:'Seller'},
    {...base,type:'buy',code:'M',insider:'Option exercise'},
    {...base,type:'sell',code:'S',transactionFootnotes:[{id:'F2',text:'Shares withheld to satisfy tax withholding obligations.'}],insider:'Tax shares'},
    {...base,type:'buy',code:'P',purchaseSignalEligible:false,purchaseSignalReason:'employee-plan',insider:'Persisted exclusion'},
  ];
  const source={ticker:'T',insiders:{transactions}};
  const c=a.stock(source);
  assert.deepEqual(c.events.map(event=>event.insiderName),['Cash buyer','Seller']);
  assert.deepEqual(c.events.map(event=>event.type),['buy','sell']);
  assert.deepEqual(c.events.map(event=>event.id),['tx-3','tx-5']);
  assert.strictEqual(c.raw,source);
  assert.strictEqual(c.raw.insiders.transactions,transactions);
  assert.equal(c.raw.insiders.transactions.length,9);
  assert.equal(transactions[0].type,'buy');
});
test('chart recomputes the source classification and keeps 10b5-1 context',()=>{
  const c=a.stock({ticker:'T',insiders:{transactions:[
    {type:'other',code:'P',fileDate:'2026-09-19',form10b5One:true,purchaseSignalEligible:false,purchaseSignalReason:'employee-plan'},
    {type:'other',code:'P',fileDate:'2026-09-19',form10b5One:true},
    {type:'sell',code:'S',fileDate:'2026-09-20',form10b5One:true},
    {type:'buy',fileDate:'2026-09-20',purchaseSignalEligible:true},
  ]}});
  assert.equal(c.events.length,2);
  assert.equal(c.events[0].type,'buy');
  assert.equal(c.events[0].planned,true);
  assert.equal(c.events[0].purchaseSignalEligible,true);
  assert.equal(c.events[0].purchaseSignalStatus,'eligible');
  assert.equal(c.events[0].purchaseSignalReason,'reported-purchase');
  assert.equal(c.events[1].type,'sell');
  assert.equal(c.events[1].planned,true);
});
test('synthetic analyst counts and unsupported funds history are not presented as observations',()=>{const c=a.stock({ticker:'T',consensus:{_synthesized:true,strongBuy:9,buy:5},smartMoney:{fundCount:3,totalShares:100,topFunds:[]}});assert.equal(c.research.analysts.strongBuy,null);assert.deepEqual(c.fundHistory,[]);});
test('fractional dividend yield becomes percent while margin percentage stays unchanged',()=>{const c=a.stock({ticker:'T',fundamentals:{dividendYield:.003166},margins:{gross:{raw:48.65,display:'48.65%'}}});assert.equal(c.research.fundamentals.dividendYield,.3166);assert.equal(c.research.fundamentals.grossMargin,48.65);});
test('US valuation ratios use their supplied provider fields',()=>{const c=a.stock({ticker:'T',fundamentals:{pfcfRatio:12},extendedRatios:{evEbitda:{numeric:17}}});assert.equal(c.research.fundamentals.priceFcf,12);assert.equal(c.research.fundamentals.evEbitda,17);});
test('extended valuation metrics support formatted values and override ambiguous EV fallback',()=>{const c=a.stock({ticker:'T',fundamentals:{evEbitda:99},extendedRatios:{pfcf:'12.50',evEbitda:'17.25'}});assert.equal(c.research.fundamentals.priceFcf,12.5);assert.equal(c.research.fundamentals.evEbitda,17.25);});
test('negative debt equity remains visible but cannot pass the health criterion',()=>{for(const [value,expected] of [[-2,null],[null,null],[0,true],[.5,true],[1,false],[2,false]]){const c=a.stock({ticker:'T',financialPosition:{debtEquity:{numeric:value}}});assert.equal(c.research.fundamentals.debtEquity,value);assert.equal(c.research.health.criteria.at(-1).pass,expected);}});
test('provider display metrics retain suffixes and use the first valid observation',()=>{
  for(const [value,expected] of [['34.82%',34.82],['12.5×',12.5],['12.5x',12.5],['1,234.5',1234.5],[{numeric:'n/a',raw:34.82,display:'34.82%'},34.82],[{numeric:null,raw:'—',display:'0.00%'},0]])assert.equal(a.metric(value),expected);
  for(const value of [null,{},[],true,'—','N/A'])assert.equal(a.metric(value),null);
  const c=a.stock({ticker:'T',extendedRatios:{evEbitda:'17.25×',pfcf:'12.50x'}});
  assert.equal(c.research.fundamentals.evEbitda,17.25);assert.equal(c.research.fundamentals.priceFcf,12.5);
});
test('StockAnalysis analyst coverage retains its actual source without Yahoo data',()=>{
  const c=a.stock({ticker:'T',fundamentals:{analystCount:18}});
  assert.equal(c.research.analysts.analystCount,18);assert.equal(c.research.analysts.analystCountSource,'StockAnalysis');
  const preferred=a.stock({ticker:'T',fundamentals:{analystCount:18,numberOfAnalystOpinions:24,analystCountSource:'yahoo'}});
  assert.equal(preferred.research.analysts.analystCount,24);assert.equal(preferred.research.analysts.analystCountSource,'Yahoo Finance');
});
test('financial source currencies survive numeric normalization independently from the listing',()=>{
  const company=a.stock({ticker:'TTE.PA',price:{currency:'EUR'},fundamentals:{eps:6.32,revenue:185e9,netIncome:0,netCash:null,beta:1,_sources:{eps:{currency:'USD'},revenue:{currency:'USD'},netIncome:{currency:'USD'},netCash:{currency:'USD'},beta:{currency:'not-a-currency'}}}});
  assert.equal(company.currency,'EUR');assert.deepEqual(company.research.fundamentalCurrencies,{eps:'USD',revenue:'USD',netIncome:'USD'});
  assert.equal(company.research.fundamentals.eps,6.32);assert.equal(company.research.fundamentals.netIncome,0);
});
