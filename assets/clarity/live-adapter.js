/* Production data contract. Missing observations remain missing. */
(function(root,factory){const api=factory(typeof module==='object'?require('../insider-transaction.js'):root.KairosInsiderTransaction);if(typeof module==='object')module.exports=api;else root.KairosAdapter=api;})(typeof window==='object'?window:globalThis,(evidence)=>{
  const number=v=>v===null||v===undefined||typeof v==='boolean'||String(v).trim()===''?null:Number.isFinite(Number(v))?Number(v):null;
  const day=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}/.test(v)?v.slice(0,10):null;
  const keys=['insider','smartMoney','momentum','valuation','analyst','health','earnings'];
  const metric=v=>number(v?.numeric??v?.raw??v?.value??(typeof v?.display==='string'?v.display.replace(/[%×,]/g,''):v));
  const safeUrl=v=>{try{const u=new URL(v);return ['https:','http:'].includes(u.protocol)?u.href:null;}catch{return null;}};
  function stock(d){
    const f=d.fundamentals||{},b=d.score?.breakdown||{},sm=d.smartMoney||{},p=d.price||{};
    const history=(d.chart?.points||[]).filter(p=>day(p.date)&&number(p.close)>0).map(p=>({date:day(p.date),close:number(p.close),volume:number(p.volume)})).sort((a,b)=>a.date.localeCompare(b.date));
    const events=(d.insiders?.transactions||[]).map((t,i)=>({t,i,classification:evidence.classifyInsiderTransaction(t)})).filter(({t,classification:c})=>(c.eligiblePurchase||c.type==='sell'&&c.status==='excluded'&&c.reason==='not-purchase')&&day(t.fileDate||t.date)).map(({t,i,classification:c})=>{
      const publicationDate=day(t.fileDate||t.date);
      return {id:'tx-'+i,date:history.find(p=>p.date>=publicationDate)?.date||publicationDate,publicationDate,tradeDate:day(t.date),type:c.type,planned:c.planned,purchaseSignalEligible:c.eligiblePurchase,purchaseSignalStatus:c.status,purchaseSignalReason:c.reason,amount:number(t.value),currency:t.currency||p.currency||'USD',role:t.title||t.insider||'—',insiderName:t.insider||null,insiderId:t.insiderCik||null,shares:number(t.shares),sourceUrl:safeUrl(t.url||t.sourceUrl)};
    });
    const consensus=d.consensus||{};
    const zb=d.zonebourseConsensus||(consensus._partial&&consensus._source==='zonebourse'?{analystCount:consensus.totalAnalysts,recommendationMean:consensus.recommendationLabel||consensus.recommendationKey,targetMean:consensus.targetMeanPrice,targetCurrency:consensus.targetCurrency,sourceUrl:consensus.sourceUrl,fetchedAt:consensus.asOf}:{});
    const provider=value=>({yahoo:'Yahoo Finance',zonebourse:'Zonebourse',finnhub:'Finnhub'}[String(value||'').toLowerCase()]||value||null);
    const count=value=>number(value)>0&&Number.isInteger(number(value))?number(value):null;
    const currency=value=>/^[A-Z]{3}$/.test(value||'')?value:null;
    const suppliedCount=count(f.numberOfAnalystOpinions),zbCount=count(zb.analystCount);
    const hasTargets=['targetMeanPrice','targetLowPrice','targetHighPrice'].some(key=>number(f[key])>0);
    const analysts={
      asOf:day(d.updatedAt||zb.fetchedAt),
      analystCount:suppliedCount??zbCount,
      analystCountSource:suppliedCount?provider(f.analystCountSource)||'Yahoo Finance':zbCount?'Zonebourse':null,
      recommendation:f.recommendationKey||zb.recommendationMean||zb.consensus||null,
      recommendationSource:f.recommendationKey?provider(f.recommendationSource):zb.recommendationMean||zb.consensus?'Zonebourse':null,
      targetMean:number(hasTargets?f.targetMeanPrice:zb.targetMean),
      targetLow:number(hasTargets?f.targetLowPrice:zb.targetLow),
      targetHigh:number(hasTargets?f.targetHighPrice:zb.targetHigh),
      targetCurrency:hasTargets?currency(f.targetCurrency)||currency(p.currency):currency(zb.targetCurrency),
      targetSource:hasTargets?provider(f.targetSource):number(zb.targetMean)>0?'Zonebourse':null,
      sourceUrl:safeUrl(zb.sourceUrl),
      distributionSource:provider(consensus._source||consensus.source),
      distributionAsOf:day(consensus.period),
      synthesized:!!consensus._synthesized
    };
    for(const k of ['strongBuy','buy','hold','sell','strongSell'])analysts[k]=consensus._synthesized?null:number(consensus[k]);
    const fundamentals={...f,trailingPE:number(f.peRatio),forwardPE:number(f.forwardPE),priceSales:number(f.psRatio),priceBook:number(f.pbRatio),priceFcf:number(f.pfcfRatio)??number(f.pfcf)??metric(d.extendedRatios?.pfcf),evEbitda:metric(d.extendedRatios?.evEbitda)??number(f.evEbitda),grossMargin:metric(d.margins?.gross),operatingMargin:metric(d.margins?.operating),netMargin:metric(d.margins?.profit),roe:metric(d.returns?.roe),roa:metric(d.returns?.roa),roic:metric(d.returns?.roic),currentRatio:metric(d.financialPosition?.currentRatio),quickRatio:metric(d.financialPosition?.quickRatio),debtEquity:metric(d.financialPosition?.debtEquity)};
    Object.keys(fundamentals).forEach(k=>fundamentals[k]=number(fundamentals[k]));
    fundamentals.dividendYield=number(f.dividendYield)==null?null:Number(f.dividendYield)*100;
    const criteria=[['Marge nette positive',fundamentals.netMargin,0,true],['Rentabilité des actifs positive',fundamentals.roa,0,true],['Rentabilité des fonds propres positive',fundamentals.roe,0,true],['Marge brute positive',fundamentals.grossMargin,0,true],['Marge opérationnelle positive',fundamentals.operatingMargin,0,true],['Liquidité générale supérieure à 1',fundamentals.currentRatio,1,true],['Dette / fonds propres inférieur à 1',fundamentals.debtEquity<0?null:fundamentals.debtEquity,1,false]].map(([label,v,limit,up])=>({label,pass:v===null?null:up?v>limit:v<limit}));
    const suppliedCriteria=d.health?.kairosScore?.criteria;
    const criterionKeys=['netMargin','roa','roe','grossMargin','operatingMargin','currentRatio','debtEquity'];
    const healthCriteria=Array.isArray(suppliedCriteria)&&suppliedCriteria.length?suppliedCriteria.map(c=>({label:String(c.label||''),pass:typeof c.ok==='boolean'?c.ok:null,key:c.key||null,value:number(c.value),unit:c.unit,threshold:number(c.threshold),comparison:c.comparison,minimum:number(c.minimum)})):criteria.map((c,i)=>({...c,key:criterionKeys[i],value:fundamentals[criterionKeys[i]],unit:i<5?'percent':'ratio',threshold:i<5?0:1,comparison:i===6?'<':'>',minimum:i===6?0:null}));
    return {raw:d,ticker:d.ticker,name:d.company?.name||d.ticker,mark:String(d.ticker||'?').slice(0,2),color:'#1d3558',...d.company,currency:p.currency||'USD',exchange:d.company?.exchange||p.exchangeFull||p.exchange||'—',history,events,score:number(d.score?.total),weights:keys.map(k=>number(b[k]?.max)),dimensions:keys.map(k=>b[k]?.dataOk===true&&number(b[k]?.max)>0?number(b[k]?.score)/number(b[k].max)*100:null),axisDetails:keys.map(k=>b[k]?.detail||''),funds:sm.topFunds||[],fundHistory:[],activism:{filings:[]},financials:[],research:{asOf:day(d.updatedAt),financialPeriod:'Dernières données disponibles',fundamentals,analysts,health:{criteria:healthCriteria,source:Array.isArray(suppliedCriteria)&&suppliedCriteria.length?'kairos':null,altmanZ:metric(d.health?.altmanZ),piotroskiF:metric(d.health?.piotroskiF)},peers:d.peers||[]}};
  }
  function groups(filings,history,{includePassive=false}={}){
    const out=new Map(),dates=history.map(p=>p.date).sort();if(!dates.length)return [];
    for(const f of filings){if(!day(f.date)||f.date<dates[0]||f.date>dates.at(-1)||(!includePassive&&f.classification==='passive'))continue;const date=dates.find(d=>d>=f.date);if(!out.has(date))out.set(date,{key:date,date,filings:[]});out.get(date).filings.push(f);}
    return [...out.values()].sort((a,b)=>a.date.localeCompare(b.date));
  }
  return {number,day,metric,safeUrl,stock,groups};
});
