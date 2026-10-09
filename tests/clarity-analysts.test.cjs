const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const adapter=require('../assets/clarity/live-adapter.js');

const asml=()=>({ticker:'ASML.AS',updatedAt:'2026-10-09',price:{currency:'EUR'},chart:{points:[{date:'2026-10-09',close:1600}]},fundamentals:{source:'zonebourse',numberOfAnalystOpinions:32,recommendationKey:'strong_buy',targetMeanPrice:2057.3438,analystCountSource:'Yahoo Finance',recommendationSource:'Yahoo Finance',targetSource:'Yahoo Finance',targetCurrency:'EUR'},consensus:{_synthesized:true,strongBuy:17,buy:19,hold:6,sell:0,strongSell:0},zonebourseConsensus:{analystCount:42,recommendationMean:'ACHETER',targetMean:2057.34,targetCurrency:'EUR',sourceUrl:'https://www.zonebourse.com/consensus/',fetchedAt:'2026-10-09'}});

function panel(company,lang='fr',section='analysts') {
  const doc={body:{append(){}},addEventListener(){}};
  function element(){return {ownerDocument:doc,innerHTML:'',setAttribute(){},addEventListener(){},querySelectorAll(){return []},remove(){},replaceChildren(...children){this.children=children;}};}
  doc.createElement=element;
  const window={KairosUI:{lang},addEventListener(){}};
  const context=vm.createContext({window,AbortController,setTimeout,clearTimeout});
  for(const file of ['analysis-english.js','analysis.js'])vm.runInContext(fs.readFileSync(require.resolve('../assets/clarity/'+file),'utf8'),context);
  const host=element();window.KairosAnalysis.render(host,company);
  return host.children[0].innerHTML.match(new RegExp('<section[^>]*data-ka-panel="'+section+'"[\\s\\S]*?<\\/section>'))[0];
}

test('Yahoo analyst coverage survives absent detailed ratings and stays distinct from Zonebourse',()=>{
  const analysts=adapter.stock(asml()).research.analysts;
  assert.equal(analysts.analystCount,32);
  assert.equal(analysts.analystCountSource,'Yahoo Finance');
  assert.equal(analysts.recommendation,'strong_buy');
  assert.equal(analysts.targetMean,2057.3438);
  assert.equal(analysts.targetCurrency,'EUR');
  for(const key of ['strongBuy','buy','hold','sell','strongSell'])assert.equal(analysts[key],null);
});

test('summary-only consensus displays the count and readable recommendation without an invented distribution',()=>{
  const html=panel(adapter.stock(asml()));
  assert.match(html,/data-ka-metric="analystTotal"[\s\S]*?<strong[^>]*>32<\/strong>/);
  assert.match(html,/Achat fort/);
  assert.match(html,/Yahoo Finance/);
  assert.match(html,/2[\s\u202f]057,34 EUR/);
  assert.match(html,/répartition détaillée des avis[^<]*indisponible/i);
  assert.doesNotMatch(html,/ka-consensus-bar|data-ka-metric="bucket-|data-ka-metric="bullish"|strong_buy/);
});

test('the partial consensus is readable in English',()=>{
  const html=panel(adapter.stock(asml()),'en');
  assert.match(html,/Strong buy/);
  assert.match(html,/Analysts · targets/);
  assert.match(html,/detailed rating breakdown[^<]*unavailable/i);
  assert.match(html,/2,057\.34 EUR/);
  assert.doesNotMatch(html,/strong_buy|Avis à l’achat/);
});

test('Zonebourse fallback preserves its independent count, source link and target currency',()=>{
  const source=asml();source.fundamentals={};source.price.currency='USD';
  const company=adapter.stock(source),analysts=company.research.analysts;
  assert.equal(analysts.analystCount,42);
  assert.equal(analysts.analystCountSource,'Zonebourse');
  assert.equal(analysts.sourceUrl,'https://www.zonebourse.com/consensus/');
  assert.equal(analysts.targetCurrency,'EUR');
  const html=panel(company);
  assert.match(html,/Zonebourse/);
  assert.match(html,/2[\s\u202f]057,34 EUR/);
  assert.match(html,/devises/);
  assert.doesNotMatch(html,/data-ka-metric="targetPotential"|ka-target-track/);
});

test('genuine complete rating buckets keep their own denominator when coverage differs',()=>{
  const source=asml();source.consensus={strongBuy:3,buy:4,hold:2,sell:1,strongSell:0,_source:'finnhub',period:'2026-10-01'};
  const html=panel(adapter.stock(source));
  assert.match(html,/data-ka-metric="analystTotal"[\s\S]*?<strong[^>]*>32<\/strong>/);
  assert.match(html,/data-ka-metric="bullish"[\s\S]*?<strong[^>]*>70,0 %<\/strong>/);
  assert.match(html,/10 avis/);
  assert.match(html,/Finnhub/);
  assert.match(html,/ka-consensus-bar/);
});

test('partial actual buckets show only reported counts and never produce a percentage',()=>{
  const source=asml();source.consensus={strongBuy:3,buy:4};
  const html=panel(adapter.stock(source));
  assert.match(html,/data-ka-metric="bucket-strongBuy"/);
  assert.match(html,/data-ka-metric="bucket-buy"/);
  assert.doesNotMatch(html,/data-ka-metric="bucket-hold"|data-ka-metric="bullish"|ka-consensus-bar/);
});

test('available low and high targets remain visible without a mean or a comparable currency',()=>{
  const source=asml();source.fundamentals.targetMeanPrice=null;source.fundamentals.targetLowPrice=1700;source.fundamentals.targetHighPrice=2300;source.zonebourseConsensus=null;source.price.currency='USD';
  const html=panel(adapter.stock(source));
  assert.match(html,/1[\s\u202f]700,00 EUR/);
  assert.match(html,/2[\s\u202f]300,00 EUR/);
  assert.doesNotMatch(html,/ka-target-track|data-ka-metric="targetPotential"/);
});

test('unknown target currency is preserved as unknown and does not imply a percentage return',()=>{
  const source=asml();source.fundamentals={};delete source.zonebourseConsensus.targetCurrency;
  const html=panel(adapter.stock(source));
  assert.match(html,/devise non précisée/);
  assert.doesNotMatch(html,/data-ka-metric="targetPotential"|ka-target-track/);
});

test('complete comparable target ranges continue to render their range chart',()=>{
  const source=asml();source.fundamentals.targetLowPrice=1800;source.fundamentals.targetHighPrice=2400;
  const html=panel(adapter.stock(source));
  assert.match(html,/ka-target-track/);
  assert.match(html,/data-ka-metric="targetPotential"/);
});

test('the partial backend consensus remains usable without its raw Zonebourse payload',()=>{
  const source={ticker:'ASML.AS',price:{currency:'EUR'},fundamentals:{},consensus:{_partial:true,_source:'zonebourse',totalAnalysts:42,recommendationLabel:'ACHETER',targetMeanPrice:2057.34,targetCurrency:'EUR',sourceUrl:'https://www.zonebourse.com/consensus/',asOf:'2026-10-09'}};
  const company=adapter.stock(source);
  assert.equal(company.research.analysts.analystCount,42);
  assert.equal(company.research.analysts.targetMean,2057.34);
  assert.equal(company.research.analysts.asOf,'2026-10-09');
  const html=panel(company);
  assert.match(html,/Achat/);
  assert.match(html,/href="https:\/\/www.zonebourse.com\/consensus\/"/);
  assert.doesNotMatch(html,/ka-consensus-bar|data-ka-metric="bucket-/);
});

test('Yahoo provider metadata is normalized and target bounds never come from another provider',()=>{
  const source=asml();Object.assign(source.fundamentals,{analystCountSource:'yahoo',recommendationSource:'yahoo',targetSource:'yahoo'});Object.assign(source.zonebourseConsensus,{targetLow:1800,targetHigh:2400});
  const analysts=adapter.stock(source).research.analysts;
  assert.equal(analysts.analystCountSource,'Yahoo Finance');
  assert.equal(analysts.recommendationSource,'Yahoo Finance');
  assert.equal(analysts.targetSource,'Yahoo Finance');
  assert.equal(analysts.targetLow,null);
  assert.equal(analysts.targetHigh,null);
});

test('missing observations do not turn into zero ratings, zero coverage or fabricated targets',()=>{
  const html=panel(adapter.stock({ticker:'NONE',fundamentals:{}}));
  assert.doesNotMatch(html,/ka-consensus-bar|data-ka-metric="bucket-|data-ka-metric="analystTotal"|data-ka-metric="targetMean"|data-ka-metric="targetPotential"/);
  assert.match(html,/objectifs de cours sont indisponibles/);
});

test('the target gap uses the current quote even when chart history ends earlier',()=>{
  const source=asml();source.price.current=1630.6;source.price.regularMarketTime=1791473901;
  source.chart.points=[{date:'2026-10-07',close:1610.2}];
  Object.assign(source.fundamentals,{targetLowPrice:1800,targetHighPrice:2400});
  const html=panel(adapter.stock(source));
  assert.match(html,/data-ka-metric="targetPotential"[\s\S]*?<strong[^>]*>\+26,2 %<\/strong>/);
  assert.match(html,/Cours de référence/);
  assert.match(html,/1[\s\u202f]630,60/);
  assert.match(html,/8 octobre 2026/);
  assert.match(html,/Analystes · objectifs/);
  assert.doesNotMatch(html,/\+27,8 %|1[\s\u202f]610,20/);
  const english=panel(adapter.stock(source),'en');
  assert.match(english,/Reference price/);
  assert.match(english,/October 8, 2026/);
});

test('invalid current quotes fall back to the latest chart close and its date',()=>{
  for(const current of [null,undefined,0,-1,NaN,'unavailable']){
    const source=asml();source.price.current=current;source.price.regularMarketTime=1791473901;
    source.chart.points=[{date:'2026-10-07',close:1610.2}];
    Object.assign(source.fundamentals,{targetLowPrice:1800,targetHighPrice:2400});
    const html=panel(adapter.stock(source));
    assert.match(html,/data-ka-metric="targetPotential"[\s\S]*?<strong[^>]*>\+27,8 %<\/strong>/);
    assert.match(html,/7 octobre 2026/);
    assert.doesNotMatch(html,/8 octobre 2026/);
  }
});

test('target coverage wording is reserved for an explicit Yahoo analyst count',()=>{
  const source=asml();source.fundamentals={};source.zonebourseConsensus=null;
  source.consensus={strongBuy:3,buy:4,hold:2,sell:1,strongSell:0,_source:'yahoo'};
  const html=panel(adapter.stock(source));
  assert.match(html,/Analystes suivis/);
  assert.doesNotMatch(html,/Analystes · objectifs/);
});
test('reported health scores remain visible without an unavailable label',()=>{
  const company=adapter.stock({ticker:'T',health:{altmanZ:3.45,piotroskiF:7}});
  const fr=panel(company,'fr','health');
  assert.match(fr,/data-ka-metric="altmanZ"[\s\S]*?<strong[^>]*>3,45<\/strong>/);
  assert.match(fr,/data-ka-metric="piotroskiF"[\s\S]*?<strong[^>]*>7<\/strong>/);
  assert.doesNotMatch(fr,/ka-unavailable|restent indisponibles/);
  assert.match(fr,/scores fournis par les sources/i);
  const en=panel(company,'en','health');assert.match(en,/scores supplied by the sources/i);
  const missing=panel(adapter.stock({ticker:'T'}),'en','health');assert.match(missing,/Altman Z and Piotroski F are unavailable/);
});
