import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readWatchlistQuote, storeStockSummarySnapshot} from '../src/watchlist-market-data.js';
import {handleStockAnalysis} from '../src/stock-api.js';
const NOW=Date.parse('2026-10-08T15:00:00Z');
const ts=day=>Date.parse(day+'T15:00:00Z')/1000;
function storage(initial={}) {
  const records=new Map(Object.entries(initial)), writes=[];
  return {records,writes,env:{CACHE:{async get(key){return structuredClone(records.get(key)??null);},async put(key,value,options){records.set(key,JSON.parse(value));writes.push({key,options});}}}};
}
function chart(symbol='NVDA',meta={}){return {chart:{result:[{meta:{symbol,regularMarketPrice:126,regularMarketTime:NOW/1000,currency:'USD',chartPreviousClose:100,previousClose:100,...meta},timestamp:[ts('2026-10-06'),ts('2026-10-07'),ts('2026-10-08')],indicators:{quote:[{close:[115,120,126]}]}}]}};}
test('three-month quote daily change uses previous trading session, not range start, and cache skips repeat fetch',async t=>{
 const h=storage();let requests=0;t.mock.method(globalThis,'fetch',async()=>{requests++;return new Response(JSON.stringify(chart()));});
 const quote=await readWatchlistQuote(h.env,'NVDA',null,NOW);
 assert.equal(quote.price.changePct,5);assert.equal(quote.chart.points.length,3);
 assert.equal((await readWatchlistQuote(h.env,'NVDA',null,NOW+60000)).price.current,126);assert.equal(requests,1);
 assert.deepEqual(h.writes,[{key:'watchlist-quote:v1:NVDA',options:{expirationTtl:604800}}]);
});
test('during an unclosed session the previous dated close is still the comparison',async t=>{
 const h=storage(),body=chart();body.chart.result[0].timestamp.pop();body.chart.result[0].indicators.quote[0].close.pop();
 t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify(body)));
 assert.equal((await readWatchlistQuote(h.env,'NVDA',null,NOW)).price.changePct,5);
});
test('a missing immediately previous session close cannot become a two-session daily change',async t=>{
 const body=chart();body.chart.result[0].indicators.quote[0].close=[120,null,126];
 t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify(body)));
 const quote=await readWatchlistQuote(storage().env,'NVDA',null,NOW);
 assert.equal(quote.price.current,126);assert.equal(quote.price.changePct,null);
 assert.deepEqual(quote.chart.points.map(p=>p.close),[120,126]);
});
test('exchange-local dates keep an Australian current-session candle out of the daily reference',async t=>{
 const now=Date.parse('2026-10-08T05:00:00Z'),body=chart('BHP.AX',{regularMarketTime:now/1000,gmtoffset:39600});
 body.chart.result[0].timestamp=[Date.parse('2026-10-06T23:00:00Z')/1000,Date.parse('2026-10-07T23:00:00Z')/1000];
 body.chart.result[0].indicators.quote[0].close=[120,126];
 t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify(body)));
 assert.equal((await readWatchlistQuote(storage().env,'BHP.AX',null,now)).price.changePct,5);
});
test('quotes beyond retention do not reappear as a failed refresh fallback',async t=>{
 t.mock.method(globalThis,'fetch',async()=>new Response('{}',{status:503}));
 const h=storage({'watchlist-quote:v1:NVDA':{ticker:'NVDA',price:{current:122,regularMarketTime:(NOW-8*86400000)/1000},_quoteFetchedAt:NOW-8*86400000}});
 assert.equal(await readWatchlistQuote(h.env,'NVDA',null,NOW),null);
});
test('explicit regular-market previous close is accepted and missing quote date never invents a daily move',async t=>{
 let meta={regularMarketPreviousClose:125};t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify(chart('NVDA',meta))));
 assert.equal((await readWatchlistQuote(storage().env,'NVDA',null,NOW)).price.changePct,.8);
 meta={regularMarketTime:null};assert.equal((await readWatchlistQuote(storage().env,'NVDA',null,NOW)).price.changePct,null);
});
test('provider failure preserves a dated quote and cooldown prevents immediate retries',async t=>{
 const old={ticker:'NVDA',price:{current:122,currency:'USD',regularMarketTime:(NOW-86400000)/1000,changePct:1},_quoteFetchedAt:NOW-3600000};
 const h=storage({'watchlist-quote:v1:NVDA':old});let requests=0;t.mock.method(globalThis,'fetch',async()=>{requests++;throw new Error('offline');});
 for(let i=0;i<2;i++){const quote=await readWatchlistQuote(h.env,'NVDA',null,NOW+i*1000);assert.equal(quote.price.current,122);assert.equal(quote.quoteRefreshFailed,true);assert.equal(quote._quoteFetchedAt,old._quoteFetchedAt);}
 assert.equal(requests,1);
});
test('a fresh quote with missing chart observations retains the existing dated curve',async t=>{
 const old={ticker:'NVDA',price:{current:122,currency:'USD',regularMarketTime:(NOW-86400000)/1000},chart:{points:[{date:'2026-10-06',close:115},{date:'2026-10-07',close:122}]},_quoteFetchedAt:NOW-3600000};
 const body=chart();body.chart.result[0].timestamp=[];
 t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify(body)));
 const quote=await readWatchlistQuote(storage({'watchlist-quote:v1:NVDA':old}).env,'NVDA',null,NOW);
 assert.equal(quote.price.current,126);assert.deepEqual(quote.chart.points,old.chart.points);
});
test('a provider failure never copies full analysis details into the public quote cache',async t=>{
 t.mock.method(globalThis,'fetch',async()=>new Response('{}',{status:503}));
 const h=storage(),analysis={ticker:'NVDA',company:{name:'NVIDIA',employees:123},price:{current:122,currency:'USD',regularMarketTime:NOW/1000},score:{total:72},insiders:{transactions:[{name:'private analysis details'}]},_cachedAt:NOW-3600000};
 const quote=await readWatchlistQuote(h.env,'NVDA',analysis,NOW);
 assert.equal(quote.price.current,122);
 const saved=h.records.get('watchlist-quote:v1:NVDA');assert.equal(saved.insiders,undefined);assert.equal(saved.score,undefined);assert.deepEqual(saved.company,{name:'NVIDIA'});
});
test('different listing and older provider observation never replace an existing newer quote',async t=>{
 const old={ticker:'NVDA',price:{current:127,currency:'USD',regularMarketTime:NOW/1000},_quoteFetchedAt:NOW-3600000};
 let body=chart('NVDA.DE');t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify(body)));
 assert.equal(await readWatchlistQuote(storage().env,'NVDA',null,NOW),null);
 body=chart('NVDA',{regularMarketTime:(NOW-86400000)/1000});
 assert.equal((await readWatchlistQuote(storage({'watchlist-quote:v1:NVDA':old}).env,'NVDA',null,NOW)).price.current,127);
});
test('durable score snapshot is a minimal public projection and keeps its real calculation date',async()=>{
 const h=storage();await storeStockSummarySnapshot(h.env,{ticker:'NVDA',company:{name:'NVIDIA',secret:'no'},price:{current:126,currency:'USD',changePct:5,regularMarketTime:NOW/1000},score:{total:72,breakdown:{momentum:{score:10,max:15,dataOk:true}}},_cachedAt:NOW,insiders:{transactions:[{}]},news:[{}]});
 assert.deepEqual(h.records.get('stock-summary:v26:NVDA'),{ticker:'NVDA',company:{name:'NVIDIA'},price:{current:126,currency:'USD',changePct:5,regularMarketTime:NOW/1000},score:{total:72},_cachedAt:NOW});
 assert.equal(h.writes[0].options.expirationTtl,604800);
});

test('an analysis without any observed axis does not become a durable score',async()=>{
 const h=storage();await storeStockSummarySnapshot(h.env,{ticker:'NVDA',score:{total:50,breakdown:{momentum:{score:7,max:15,dataOk:false}}},_cachedAt:NOW});
 assert.equal(h.writes.length,0);
});
test('an already cached analysis backfills its durable score once without recomputing or making market requests',async t=>{
 t.mock.method(globalThis,'fetch',()=>assert.fail('A current analysis must not recompute'));
 const now=Date.now(),analysis={ticker:'NVDA',company:{name:'NVIDIA'},price:{current:126,currency:'USD',regularMarketTime:now/1000},score:{total:72},_cachedAt:now};
 const h=storage({'yahoo-search:v4:NVDA':{symbol:'NVDA'},'stock-analysis:v26:NVDA:full:1y':analysis});
 assert.equal((await handleStockAnalysis('NVDA',h.env)).score.total,72);
 assert.equal(h.records.get('stock-summary:v26:NVDA')?.score.total,72);
 await handleStockAnalysis('NVDA',h.env);
 assert.equal(h.writes.length,1);
});
