import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRecommendationTrend,synthesizeConsensusFromZonebourse,applyYahooFundamentals,fetchYahooFundamentals,computeKairosScore} from '../src/stock-api.js';
test('current recommendation counts are observed, complete, and not inferred from previous months',()=>{
 const row={period:'0m',strongBuy:10,buy:12,hold:8,sell:2,strongSell:0};
 assert.equal(normalizeRecommendationTrend([row]).total,32);
 assert.equal(normalizeRecommendationTrend([row]).bullishPct,68.75);
 for(const rows of [[{...row,period:'-1m'}],[{...row,sell:null}],[{...row,sell:-1}],[{...row,buy:.5}],null])assert.equal(normalizeRecommendationTrend(rows),null);
});
test('partial Zonebourse coverage never creates fictional votes or percentages',()=>{
 const c=synthesizeConsensusFromZonebourse({analystCount:42,gaugeNote:8.9,recommendationMean:'ACHETER',targetMean:2057,targetCurrency:'EUR'});
 assert.equal(c.totalAnalysts,42);assert.equal(c.targetCurrency,'EUR');
 for(const key of ['total','strongBuy','buy','hold','sell','strongSell','bullishPct'])assert.equal(c[key],undefined);
 assert.equal(synthesizeConsensusFromZonebourse({}).totalAnalysts,null);
});
test('Yahoo target range retains its listing currency and provenance without mixing another consensus',()=>{
 const stats={targetMeanPrice:2000,targetLowPrice:1400,targetHighPrice:2400,targetCurrency:'EUR',numberOfAnalystOpinions:32,recommendationKey:'strong_buy'};
 const f={currency:'EUR'};applyYahooFundamentals(f,stats);
 assert.equal(f.targetLowPrice,1400);assert.equal(f.targetHighPrice,2400);assert.equal(f.targetSource,'yahoo');assert.equal(f.analystCountSource,'yahoo');
 const usd={currency:'USD'};applyYahooFundamentals(usd,stats);assert.equal(usd.targetMeanPrice,undefined);
 const other={currency:'EUR',targetMeanPrice:2100};applyYahooFundamentals(other,stats);assert.equal(other.targetLowPrice,undefined);
});
test('Yahoo quotes deliver their real rating distribution and all price targets',async t=>{
 let requested;
 t.mock.method(globalThis,'fetch',async url=>{requested=String(url);return Response.json({quoteSummary:{result:[{price:{currency:'EUR'},financialData:{targetMeanPrice:{raw:2000},targetLowPrice:{raw:1400},targetHighPrice:{raw:2400}},recommendationTrend:{trend:[{period:'0m',strongBuy:10,buy:12,hold:8,sell:2,strongSell:0}]}}]}});});
 const d=await fetchYahooFundamentals('ASML.AS',{CACHE:{get:async()=>({cookie:'x',crumb:'x',at:Date.now()})}});
 assert.match(requested,/recommendationTrend/);assert.match(requested,/ASML.AS/);assert.equal(d.consensus.total,32);assert.equal(d.stats.targetHighPrice,2400);assert.equal(d.stats.targetCurrency,'EUR');
});
test('legacy synthesized votes cannot inflate the analyst score',()=>{
 const base={insiders:{},smartMoney:{},quote:{price:{current:100}},fundamentals:{targetMeanPrice:110},health:{},earnings:{}};
 const a=computeKairosScore(base).breakdown.analyst;
 const b=computeKairosScore({...base,consensus:{_synthesized:true,total:42,bullishPct:100}}).breakdown.analyst;
 assert.deepEqual(a,b);assert.match(a.detail,/Objectif/);
});
