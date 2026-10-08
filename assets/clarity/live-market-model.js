/* Filing dates determine freshness; execution dates determine convergence. */
(function(root,factory){const api=factory(typeof module==='object'?require('../insider-transaction.js'):root.KairosInsiderTransaction);if(typeof module==='object')module.exports=api;else root.KairosMarketLive=api;})(typeof window==='object'?window:this,(evidence)=>{
'use strict';
const ticker=value=>typeof value==='string'?value.trim().toUpperCase():'';
const placeholders=new Set(['NONE','N/A','NA','NULL','UNKNOWN','NAN','UNAVAILABLE','NOT AVAILABLE','NON RENSEIGNE']);
const validTicker=value=>/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(ticker(value))&&!placeholders.has(ticker(value));
const number=value=>value===null||value===undefined||typeof value==='boolean'||String(value).trim()===''?null:Number.isFinite(Number(value))?Number(value):null;
const day=value=>{const s=typeof value==='string'?value.slice(0,10):'';return /^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s?s:null;};
const today=value=>day(value)||new Date().toISOString().slice(0,10);
const before=(date,days)=>new Date(Date.parse(date+'T00:00:00Z')-(days-1)*86400000).toISOString().slice(0,10);
const within=(date,days,now)=>!!date&&date<=now&&(days==='all'||date>=before(now,Math.max(1,Number(days)||7)));
const publication=row=>day(row.fileDate||row.filingDate);
const trade=row=>day(row.date||row.transDate);
const currency=row=>String(row.currency||'').trim().toUpperCase();
const cik=value=>/^\d+$/.test(String(value||'').trim())?String(value).trim().replace(/^0+/,''):'';
const name=value=>{const text=String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().trim();return !text||placeholders.has(text)?'':text.replace(/[^\p{L}\p{N}]+/gu,' ').trim().split(/\s+/).sort().join(' ');};
const executionCode=row=>String(row.transCode||row.transactionCode||row.trans_code||row.code||'').trim().toUpperCase();
const classify=row=>evidence.classifyInsiderTransaction(row);
const purchase=row=>classify(row).eligiblePurchase;
function identities(rows){const aliases=new Map();for(const row of rows){const id=cik(row.insiderCik),label=name(row.insider);if(!id||!label)continue;if(!aliases.has(label))aliases.set(label,new Set());aliases.get(label).add(id);}return row=>{const id=cik(row.insiderCik),label=name(row.insider),known=aliases.get(label);return id?'cik:'+id:label?(known?.size===1?'cik:'+Array.from(known)[0]:known?.size>1?null:'name:'+label):null;};}
function deduplicate(rows){
 const identify=identities(rows),groups=new Map(),text=value=>typeof value==='string'?value.trim().toLowerCase().replace(/\s+/g,' '):'';
 for(const row of rows){
  const classification=classify(row),accession=String(row.accession||row.adsh||'').trim().replace(/-/g,''),sourceRef=accession||row.bdif_numero||row.sourceUrl||row.url||'',line=String(row.transactionId??row.lineId??row.transactionIndex??row.lineIndex??'');
  const metadata=[text(row.securityTitle||row.security_title||row.security||row.instrument)||null,text(row.ownershipNature||row.directOrIndirectOwnership)||null,number(row.sharesAfter)];
  const rawCode=executionCode(row),ad=String(row.ad||row.adType||'').toUpperCase(),side=ad==='D'||['S','F','D'].includes(rawCode)||classification.type==='sell'?'disposed':'acquired';
  // A source filing and economic line let a corrected code supersede its old copy.
  // Otherwise keep the old code/type separation; matching amounts alone are not proof.
  const key=JSON.stringify([ticker(row.ticker),currency(row),identify(row),sourceRef,sourceRef?'':row.source||'',line,publication(row),trade(row),sourceRef?side:classification.type,sourceRef?'':rawCode,number(row.shares),number(row.price),number(row.value),...(sourceRef?[]:metadata)]);
  const negative=row.purchaseSignalEligible===false||classification.status==='excluded'&&(classification.reason!=='not-purchase'||classification.type==='other');
  const priority=negative?3:classification.status==='unknown'&&rawCode?2:classification.eligiblePurchase||classification.type==='sell'?1:0;
  const notes=Array.isArray(row.transactionFootnotes)?row.transactionFootnotes.slice(0,32):[];
  const richness=metadata.filter(v=>v!==null).length+notes.reduce((sum,note)=>sum+(typeof note==='string'?note.length:typeof note?.text==='string'?note.text.length:0),0);
  const candidate={row,classification,metadata,priority,richness};if(!groups.has(key))groups.set(key,[]);groups.get(key).push(candidate);
 }
 const result=[],compatible=(a,b)=>a.every((value,index)=>value===null||b[index]===null||value===b[index]);
 const prefer=(a,b)=>a.priority-b.priority||a.richness-b.richness||Number(a.classification.planned)-Number(b.classification.planned)||a.classification.reason.localeCompare(b.classification.reason);
 for(const candidates of groups.values()){
  // Specific instrument/ownership metadata is resolved before sparse legacy copies.
  candidates.sort((a,b)=>b.metadata.filter(v=>v!==null).length-a.metadata.filter(v=>v!==null).length||prefer(b,a));
  const variants=[];
  for(const candidate of candidates){
   const matches=variants.filter(variant=>compatible(variant.metadata,candidate.metadata));
   if(!matches.length){variants.push(candidate);continue;}
   if(matches.length>1){
    // A sparse copy cannot add a purchase to several already identified variants.
    // Ambiguous negative evidence also cannot prove which variant qualifies.
    if(candidate.priority>=2)for(const variant of matches){if(variant.classification.eligiblePurchase){variant.row={...variant.row,purchaseSignalEligible:false,purchaseSignalReason:'unknown'};variant.classification=classify(variant.row);variant.priority=2;}}
    continue;
   }
   const existing=matches[0],metadata=existing.metadata.map((value,index)=>value??candidate.metadata[index]);
   if(prefer(candidate,existing)>0)Object.assign(existing,candidate);existing.metadata=metadata;
  }
  result.push(...variants.map(({row})=>({...row,type:classify(row).type})));
 }
 return result;
}
function sum(rows){let total=0;for(const row of rows){const value=number(row.value);if(value===null)return null;total+=value;}return total;}
const amountRank=value=>value===null?-Infinity:value;
function groupRows(rows){const groups=new Map();for(const row of rows){if(!validTicker(row.ticker))continue;const key=ticker(row.ticker)+'|'+currency(row);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}return groups.values();}
function summarize(rows,purchases,now,identify){const people=new Map();for(const row of purchases){const id=identify(row);if(id&&!people.has(id))people.set(id,{id,name:row.insider||cik(row.insiderCik),role:row.title||''});}const dates=purchases.map(trade).filter(Boolean),published=purchases.map(publication).filter(Boolean).sort();return {
 ticker:ticker(purchases[0].ticker),company:purchases[0].company||ticker(purchases[0].ticker),currency:currency(purchases[0]),buyers:people.size,people:[...people.values()].map(p=>p.name),buyerDetails:[...people.values()],amount:sum(purchases),sales:sum(rows.filter(r=>r.type==='sell')),purchaseCount:purchases.length,transactions:rows,purchases,lastPublication:published.at(-1)||null,lastTradeDate:dates.length?dates.slice().sort().at(-1):null,startDate:dates.length?dates.slice().sort()[0]:null,endDate:dates.length?dates.slice().sort().at(-1):null,
 lateCount:purchases.filter(r=>trade(r)&&publication(r)&&Date.parse(publication(r))-Date.parse(trade(r))>7*86400000).length,oldTradeCount:purchases.filter(r=>trade(r)&&trade(r)<before(now,30)).length,unknownTradeCount:purchases.filter(r=>!trade(r)).length,futureTradeCount:purchases.filter(r=>trade(r)>now).length
 };}
const quality=r=>Number(r.oldTradeCount+r.unknownTradeCount+r.futureTradeCount>0)+Number(r.lateCount>0);
const rank=(a,b)=>quality(a)-quality(b)||(b.lastPublication||'').localeCompare(a.lastPublication||'')||b.buyers-a.buyers||a.ticker.localeCompare(b.ticker)||a.currency.localeCompare(b.currency);
function purchases(transactions,{days=7,now}={}){now=today(now);const rows=deduplicate(transactions),identify=identities(rows),result=[];for(const group of groupRows(rows)){const window=group.filter(r=>within(publication(r),days,now)),buys=window.filter(purchase);if(buys.length)result.push(summarize(window,buys,now,identify));}return result.sort(rank);}
function convergences(transactions,{buyers=2,windowDays=30,days,now}={}){
 now=today(now);const rows=deduplicate(transactions),identify=identities(rows),result=[];
 for(const group of groupRows(rows)){const eligible=group.filter(r=>trade(r)&&trade(r)<=now&&(days===undefined?(!publication(r)||publication(r)<=now):publication(r)&&publication(r)<=now&&trade(r)<=publication(r)));let best=null;
  // Preserve historical helper consumers when they do not request a publication period.
  const ends=days===undefined?[...new Set(eligible.filter(purchase).map(trade))]:[now];
  for(const endDate of ends){const startDate=before(endDate,windowDays),window=eligible.filter(r=>trade(r)>=startDate&&trade(r)<=endDate),buys=window.filter(purchase);if(!buys.length||days!==undefined&&!buys.some(r=>identify(r)&&within(publication(r),days,now)))continue;
   const candidate={...summarize(window,buys,now,identify),startDate,endDate};if(candidate.buyers<buyers)continue;
   if(!best||candidate.buyers>best.buyers||candidate.buyers===best.buyers&&amountRank(candidate.amount)>amountRank(best.amount)||candidate.buyers===best.buyers&&candidate.amount===best.amount&&candidate.endDate>best.endDate)best=candidate;
  }if(best)result.push(best);
 }return result.sort(rank);
}
function crossovers(groups,source,{days=7,now}={}){if(source?.available!==true)return {available:false,rows:null};now=today(now);const filings=source.filings||[],bySymbol=new Map();for(const filing of filings){const symbol=ticker(filing.yahooSymbol||filing.ticker||filing.ticker_kairos),form=String(filing.form||'').trim();if(!validTicker(symbol)||filing.isActivist!==true||!/(?:^|\s)13D(?:\/A)?$/i.test(form)||!within(publication(filing),days,now))continue;
  const eventKind=filing.isFirstFiling===true&&!/\/A$/i.test(form)?'initial':number(filing.sharesDelta)>0?'increase':'amendment';if(!bySymbol.has(symbol))bySymbol.set(symbol,[]);bySymbol.get(symbol).push({...filing,eventKind});
 }const independent=(filing,group)=>{const id=cik(filing.filerCik),label=name(filing.filerName),buyers=group.buyerDetails||[];if((!id&&!label)||!buyers.length)return false;return !buyers.some(buyer=>id&&buyer.id.startsWith('cik:')?'cik:'+id===buyer.id:!!label&&name(buyer.name)===label);};
 return {available:true,rows:groups.filter(group=>bySymbol.has(group.ticker)).map(group=>({...group,activistFilings:bySymbol.get(group.ticker).filter(f=>independent(f,group))})).filter(group=>group.activistFilings.length).sort(rank)};}
return {convergences,purchases,crossovers,deduplicate,validTicker,day,classify};
});
