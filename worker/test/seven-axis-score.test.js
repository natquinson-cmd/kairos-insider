import {test} from 'node:test';
import assert from 'node:assert/strict';
import {computeKairosScore,handleStockAnalysis} from '../src/stock-api.js';
import {STOCK_ANALYSIS_VERSION} from '../src/watchlist-market-data.js';
import {normalizeScoreWeights,SCORE_WEIGHT_KEYS} from '../src/score-weights.js';
const input={insiders:{},smartMoney:{},quote:{},fundamentals:{},health:{},earnings:{}};
test('retired politician/guru data and saved weight cannot affect the seven-axis score',()=>{
  const absent=computeKairosScore(input);
  const retired=computeKairosScore({...input,govEtf:{inEtfs:[{etf:'GURU'}],totalPct:25},weights:{govGuru:100}});
  assert.deepEqual(retired,absent);
  assert.deepEqual(Object.keys(absent.breakdown),SCORE_WEIGHT_KEYS);
  assert.ok(Math.abs(Object.values(absent.breakdown).reduce((n,b)=>n+b.max,0)-100)<1e-8);
  assert.equal(absent.total,Math.round(Object.values(absent.breakdown).reduce((n,b)=>n+b.score,0)));
});
test('an unsupported cached score is retried after providers recover',async t=>{
 let fetches=0;t.mock.method(globalThis,'fetch',async()=>{fetches++;return new Response('{}',{status:404});});
 const cached={ticker:'AAPL',_cachedAt:Date.now(),score:{total:50,breakdown:{health:{dataOk:false}}},unsupported:true};
 const records=new Map([['yahoo-search:v4:AAPL',{symbol:'AAPL'}],[`stock-analysis:${STOCK_ANALYSIS_VERSION}:AAPL:full:1y`,cached]]);
 const result=await handleStockAnalysis('AAPL',{CACHE:{get:async key=>records.get(key)||null,put:async()=>{}}});
 assert.equal(result.unsupported,undefined);assert.ok(fetches>0);
});
test('active relative weights are retained and invalid or zero-only settings cannot corrupt the score',()=>{
  const w=normalizeScoreWeights({insider:40,govGuru:100});
  assert.equal(w.insider/w.smartMoney,2);
  for(const input of [null,{insider:NaN},{health:-2},Object.fromEntries(SCORE_WEIGHT_KEYS.map(k=>[k,0]))]){
    const values=Object.values(normalizeScoreWeights(input));
    assert.ok(values.every(Number.isFinite));assert.ok(Math.abs(values.reduce((a,b)=>a+b,0)-100)<1e-8);
  }
});
