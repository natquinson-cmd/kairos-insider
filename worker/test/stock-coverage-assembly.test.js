import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchYahooFundamentals, handleStockAnalysis } from '../src/stock-api.js';

const session = {cookie:'test',crumb:'test',at:Date.now()};
const fixture = {
  price:{symbol:'TEST',currency:'EUR',marketCap:{raw:1000}},
  financialData:{financialCurrency:'EUR',grossMargins:{raw:.4},operatingMargins:{raw:.2},profitMargins:{raw:.1},returnOnAssets:{raw:.08},returnOnEquity:{raw:.15},quickRatio:{raw:0},currentRatio:{raw:2},debtToEquity:{raw:50},totalRevenue:{raw:500},totalCash:{raw:60},totalDebt:{raw:20},freeCashflow:{raw:40}},
  defaultKeyStatistics:{enterpriseValue:{raw:960},enterpriseToEbitda:{raw:8},netIncomeToCommon:{raw:50},trailingEps:{raw:2}},
  summaryDetail:{forwardPE:{raw:12},dividendYield:{raw:0},beta:{raw:0}},
  earningsHistory:{history:[{quarter:{raw:1782777600,fmt:'2026-06-30'},epsActual:{raw:2},epsEstimate:{raw:1.8}}]},
  calendarEvents:{earnings:{earningsDate:[{raw:1798761600},{raw:1798848000}],earningsAverage:{raw:2.2}}},
};
const env = () => ({CACHE:{get:async key=>key==='yahoo:session'?session:null,put:async()=>{}}});
test('Yahoo parser retains financial fields, real zeros, currencies and period-end semantics',async t=>{
  t.mock.method(globalThis,'fetch',async()=>Response.json({quoteSummary:{result:[fixture]}}));
  const d=await fetchYahooFundamentals('TEST',{CACHE:{get:async()=>session}});
  assert.equal(d.stats.grossMargin,.4);assert.equal(d.stats.quickRatio,0);assert.equal(d.stats.beta,0);
  assert.equal(d.stats.enterpriseValue,960);assert.equal(d.stats.financialCurrency,'EUR');
  assert.equal(d.earnings.history[0].periodEnd,'2026-06-30');assert.equal(d.earnings.history[0].date,null);
  assert.equal(d.earnings.next.date,'2027-01-01');assert.equal(d.earnings.next.dateEnd,'2027-01-02');
  assert.equal(d.earnings.next.confirmed,false);assert.equal(d.earnings.next.currency,'EUR');
});
test('stock assembly fills financial gaps and health from Yahoo when other providers are empty',async t=>{
  t.mock.method(globalThis,'fetch',async url=>{
    if(String(url).includes('/quoteSummary/'))return Response.json({quoteSummary:{result:[fixture]}});
    if(String(url).includes('/chart/'))return Response.json({chart:{result:[{meta:{currency:'EUR',regularMarketPrice:100,regularMarketTime:1782864000},timestamp:[1782777600],indicators:{quote:[{close:[99]}]}}]}});
    return new Response('{}',{status:404});
  });
  const e=env();e.CACHE.get=async key=>key.includes('session')?session:null;
  const d=await handleStockAnalysis('TEST',e);
  assert.equal(d.fundamentals.enterpriseValue,960);assert.equal(d.margins.gross.raw,40);
  assert.equal(d.financialPosition.debtEquity.raw,.5);assert.equal(d.returns.roa.raw,8);
  assert.equal(d.health.kairosScore.total,7);assert.equal(d.score.breakdown.health.dataOk,true);
  assert.equal(d.earnings.history.length,1);assert.equal(d.earnings.next.dateEnd,'2027-01-02');
});
test('ADR fallback does not inject US share counts, EPS or monetary totals into European listings',async t=>{
  t.mock.method(globalThis,'fetch',async url=>String(url).includes('/chart/')?Response.json({chart:{result:[{meta:{currency:'EUR',regularMarketPrice:100},timestamp:[],indicators:{quote:[{}]}}]}}):new Response('{}',{status:404}));
  const e={FINNHUB_KEY:'test',CACHE:{get:async key=>key.startsWith('finnhub-metrics:v5:')?{_usedSymbol:'LVMUY',fetchedAt:new Date().toISOString(),marketCap:999,eps:3,sharesOut:123,forwardPE:77,peRatio:20,high52w:123,extendedRatios:{evEbitda:10}}:null,put:async()=>{}}};
  const d=await handleStockAnalysis('MC.PA',e);
  for(const key of ['marketCap','eps','sharesOut','high52w'])assert.ok(d.fundamentals[key]==null,key);
  assert.equal(d.fundamentals.peRatio,20);
});
test('assembly does not skip a missing immediately prior session when calculating daily change',async t=>{
  t.mock.method(globalThis,'fetch',async url=>String(url).includes('/chart/')?Response.json({chart:{result:[{
    meta:{currency:'USD',regularMarketPrice:105,regularMarketTime:Date.parse('2026-10-09T20:00:00Z')/1000},
    timestamp:[Date.parse('2026-10-07T14:00:00Z')/1000,Date.parse('2026-10-08T14:00:00Z')/1000],
    indicators:{quote:[{close:[90,null]}]},
  }]}}):new Response('{}',{status:404}));
  const d=await handleStockAnalysis('TEST',env());
  assert.equal(d.chart.points.length,1);assert.equal(d.price.changePct,null);
});
