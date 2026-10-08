import {classifyInsiderTransaction,insiderTransactionEvidence} from './insider-transaction.js';
const DAY=86400000;
const canonicalName=value=>String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().split(/\s+/).sort().join(' ');
const canonicalCik=value=>/^\d+$/.test(String(value||'').trim())?String(value).trim().replace(/^0+/,'')||null:null;
const unknownNames=new Set(['','unknown','unknown insider','unknown buyer','unavailable','na','n/a','none','non renseigne','non renseignee','inconnu','not available','anonymous'].map(canonicalName));
const validDay=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const recent=(value,cutoff,today)=>validDay(value)&&value>=cutoff&&value<=today;
const identityName=row=>canonicalName(row.insider||row.filerName);
const identityCik=row=>canonicalCik(row.insiderCik||row.filerCik);

// A CIK identifies a reporting actor across spelling variants. Name-only records
// join a CIK only when the name points to exactly one known actor in this set.
function identityResolver(rows){
  const aliases=new Map();
  for(const row of rows){const name=identityName(row),cik=identityCik(row);if(unknownNames.has(name)||!cik)continue;if(!aliases.has(name))aliases.set(name,new Set());aliases.get(name).add(cik);}
  return row=>{const cik=identityCik(row),name=identityName(row);if(cik)return 'cik:'+cik;if(unknownNames.has(name))return null;const ciks=aliases.get(name);return ciks?.size===1?'cik:'+[...ciks][0]:ciks?.size>1?null:'name:'+name;};
}

export function currentActivistFilings(payload,now){
  if(!Array.isArray(payload?.filings))return null;
  const today=new Date(now).toISOString().slice(0,10),cutoff=new Date(now-30*DAY).toISOString().slice(0,10),groups=new Map();
  for(const row of payload.filings){
    if(!row||typeof row!=='object')continue;
    const form=String(row.form||'').trim().toUpperCase(),ticker=String(row.ticker||'').trim().toUpperCase(),fileDate=typeof row.fileDate==='string'?row.fileDate.slice(0,10):null;
    if(!/^(?:SCHEDULE |SC )?13D(?:\s*\/\s*A|[- ]A)?$/.test(form)||row.isActivist!==true||!row.accession||!recent(fileDate,cutoff,today)||!/^[A-Z0-9.\-]{1,12}$/.test(ticker))continue;
    const filing={id:JSON.stringify(['activist-purchase',row.accession,ticker]),accession:String(row.accession),ticker,fileDate,form,filerName:String(row.filerName||''),filerCik:canonicalCik(row.filerCik),company:String(row.targetName||ticker)};
    if(!identityResolver([filing])(filing))continue;
    try{const url=new URL(row.sourceUrl||row.url);if(['http:','https:'].includes(url.protocol))filing.sourceUrl=url.href;}catch{}
    // An accession identifies the original filing even when the feed lacks a URL.
    if(!filing.sourceUrl&&filing.filerCik&&/^\d{10}-\d{2}-\d{6}$/.test(filing.accession))filing.sourceUrl=`https://www.sec.gov/Archives/edgar/data/${filing.filerCik}/${filing.accession.replace(/-/g,'')}/${filing.accession}-index.html`;
    if(!groups.has(ticker))groups.set(ticker,new Map());groups.get(ticker).set(filing.id,filing);
  }
  return groups;
}

const compactPurchase=event=>({...insiderTransactionEvidence(event),type:'buy',transactionCode:event.transactionCode||event.transCode||event.trans_code||null,id:event.id,insider:event.insider,insiderCik:event.insiderCik,tradeDate:event.tradeDate,fileDate:event.fileDate});
const tradeRange=purchases=>{const days=purchases.map(p=>p.tradeDate).sort();return {firstTradeDate:days[0],lastTradeDate:days.at(-1)};};

// State is per subscribed ticker/channel. Empty or unavailable source data never
// removes observations; they expire only when their dated 30-day window ends.
export function advanceWatchlistConvergence({events,previous,seen,bootstrap,filings,now}){
  const today=new Date(now).toISOString().slice(0,10),cutoff=new Date(now-30*DAY).toISOString().slice(0,10);
  const freshFilingCutoff=new Date(now-7*DAY).toISOString().slice(0,10);
  const datedPurchase=event=>recent(event.tradeDate,cutoff,today)&&recent(event.fileDate,cutoff,today)&&event.tradeDate<=event.fileDate;
  const eligible=event=>classifyInsiderTransaction(event).eligiblePurchase&&datedPurchase(event);
  const ordered=[...events].sort((a,b)=>a.fileDate.localeCompare(b.fileDate)||(a.tradeDate||'').localeCompare(b.tradeDate||'')||a.id.localeCompare(b.id));
  const purchases=new Map((previous?.purchases||[]).filter(eligible).map(p=>[p.id,p]));
  for(const event of ordered)if(eligible(event)&&(bootstrap||seen.has(event.id)))purchases.set(event.id,compactPurchase(event));
  const identity=identityResolver([...purchases.values(),...ordered.filter(eligible)]),discovered=[];
  for(const event of ordered){
    if(bootstrap||seen.has(event.id))continue;
    let discoveredEvent=event;
    if(eligible(event)){
      const before=new Set([...purchases.values()].map(identity).filter(Boolean)),actor=identity(event);
      purchases.set(event.id,compactPurchase(event));
      if(event.fileDate>=freshFilingCutoff&&actor&&before.size===1&&!before.has(actor))discoveredEvent={...event,convergence:{kind:'buyers',buyerCount:2,windowDays:30,...tradeRange([...purchases.values()].filter(p=>identity(p)))}};
    }
    discovered.push(discoveredEvent);
  }
  const oldActivists=previous?.activists;
  if(filings===null)return {purchases:[...purchases.values()],activists:oldActivists||null,discovered};
  const observed=new Map((oldActivists?.filings||[]).filter(f=>recent(f.fileDate,cutoff,today)).map(f=>[f.id,f]));
  const current=[...(filings||[])].sort((a,b)=>a.fileDate.localeCompare(b.fileDate)||a.id.localeCompare(b.id));
  const allActors=identityResolver([...purchases.values(),...observed.values(),...current]);
  const actors=new Set([...observed.values()].map(allActors).filter(Boolean));
  for(const filing of current){
    const actor=allActors(filing),supportingPurchases=[...purchases.values()].filter(p=>p.tradeDate<=filing.fileDate&&allActors(p)),buyers=new Set(supportingPurchases.map(allActors));
    if(!bootstrap&&oldActivists&&filing.fileDate>=freshFilingCutoff&&!observed.has(filing.id)&&actor&&!actors.has(actor)&&!buyers.has(actor)&&buyers.size){
      discovered.push({id:filing.id,ticker:filing.ticker,type:'activist-purchase',fileDate:filing.fileDate,tradeDate:null,insider:filing.filerName,company:filing.company,source:'SEC',sourceUrl:filing.sourceUrl||null,value:null,currency:'',convergence:{kind:'activist-purchase',buyerCount:buyers.size,windowDays:30,...tradeRange(supportingPurchases)}});
    }
    observed.set(filing.id,filing);if(actor)actors.add(actor);
  }
  return {purchases:[...purchases.values()],activists:{filings:[...observed.values()]},discovered};
}

export function allowsConvergenceEvent(sub,channel,event){
  return event.type!=='activist-purchase'||sub.types?.activist!==false&&(channel!=='telegram'||sub.prefs?.new13d!==false);
}
