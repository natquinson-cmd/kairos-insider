import {finiteNumber} from './financial-normalization.js';
import {lookupEuYahooSymbol} from './eu_yahoo_symbols.js';
import {currentActivistFilings,advanceWatchlistConvergence,allowsConvergenceEvent} from './watchlist-convergences.js';
import {classifyInsiderTransaction,withInsiderTransactionEvidence,insiderTransactionEvidence,preferInsiderTransactionEvidence,aggregateInsiderSignalRows} from './insider-transaction.js';

const DAY=86400000;
const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)&&Number.isFinite(Date.parse(value.slice(0,10)))?value.slice(0,10):null;
const safeUrl=value=>{try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)?u.href:null;}catch{return null;}};
export function telegramAlertPreferences(existing={},patch={}){
  const result={new13d:true,insiderCluster:true,euThreshold:true,insiderTransactions:false,quietHoursStart:22,quietHoursEnd:7,lang:'fr',...existing};
  for(const key of ['new13d','insiderCluster','euThreshold','insiderTransactions'])if(Object.hasOwn(patch,key)){if(typeof patch[key]!=='boolean')throw new Error('Invalid preference: '+key);result[key]=patch[key];}
  for(const key of ['quietHoursStart','quietHoursEnd'])if(Object.hasOwn(patch,key)){if(!Number.isInteger(patch[key])||patch[key]<0||patch[key]>23)throw new Error('Invalid hour: '+key);result[key]=patch[key];}
  if(Object.hasOwn(patch,'lang')){if(!['fr','en'].includes(patch.lang))throw new Error('Invalid language');result.lang=patch.lang;}
  return result;
}
export function normalizeInsiderMovement(row,{forAlert=false,includeExcluded=false}={}){
  if(!row||typeof row!=='object')return null;
  const classification=classifyInsiderTransaction(row),type=classification.type;
  const fileDate=date(row.fileDate||row.filingDate);if(type==='other'&&!includeExcluded||!fileDate||forAlert&&type==='buy'&&!classification.eligiblePurchase)return null;
  const source=String(row.source||'').toLowerCase(),country=String(row.market||row.country||({amf:'FR',bafin:'DE',fca:'GB',afm:'NL',six:'CH'})[source]||'').toUpperCase();
  const explicitYahoo=typeof row.yahooSymbol==='string'&&/^[A-Z0-9.\-]{1,12}$/i.test(row.yahooSymbol.trim());
  let ticker=String(row.yahooSymbol||row.ticker||'').trim().toUpperCase();
  const isEu=['amf','bafin','fca','afm','six'].includes(source)||row.region==='Europe';
  if(isEu&&!explicitYahoo&&!ticker.includes('.')){
    const suffix={FR:'PA',DE:'DE',GB:'L',UK:'L',CH:'SW',NL:'AS',IT:'MI',ES:'MC',BE:'BR',SE:'ST',NO:'OL',DK:'CO',FI:'HE'}[country];
    ticker=ticker&&suffix?ticker+'.'+suffix:lookupEuYahooSymbol(row.company,country)||'';
  }
  if(!/^[A-Z0-9.\-]{1,12}$/.test(ticker)||isEu&&!explicitYahoo&&!ticker.includes('.'))return null;
  const sourceUrl=safeUrl(row.sourceUrl||row.url)||(source==='amf'&&row.bdif_pdf_path?safeUrl('https://bdif.amf-france.org/back/api/v1/documents/'+row.bdif_pdf_path):null);
  const event=withInsiderTransactionEvidence({...insiderTransactionEvidence(row),transactionCode:row.transactionCode||row.transCode||row.trans_code||null,ticker,type,fileDate,tradeDate:date(row.date||row.transDate||row.tradeDate),insider:String(row.insider||row.insiderName||''),insiderCik:row.insiderCik||row.insider_cik||row.reportingOwnerCik||null,company:String(row.company||ticker),currency:String(row.currency||''),value:finiteNumber(row.value),shares:finiteNumber(row.shares),source:source?source.toUpperCase():'—',sourceUrl});
  event.id=JSON.stringify([source,row.accession||row.adsh||row.bdif_numero||sourceUrl||'',ticker,event.insider,event.tradeDate,fileDate,type,event.shares,finiteNumber(row.price),event.value,event.currency]);
  return event;
}
export function movementMessage(event,lang='fr'){
  const t=(fr,en)=>lang==='en'?en:fr;
  const action=event.type==='activist-purchase'?t('13D et achats récents','13D and recent purchases'):event.type==='buy'?t('Achat','Purchase'):t('Vente','Sale');
  const amount=event.value==null?'—':event.value.toLocaleString(lang==='en'?'en-US':'fr-FR',{maximumFractionDigits:2})+(event.currency?' '+event.currency:'');
  const title=(event.type==='activist-purchase'?t('Convergence de déclarations','Filing convergence'):t('Déclaration d’initié','Insider filing'))+' · '+event.ticker+' · '+action;
  const lines=[title,event.company,t('Déclarant : ','Reporting person: ')+(event.insider||'—'),t('Opération : ','Transaction type: ')+action];
  if(event.type!=='activist-purchase')lines.push(t('Montant déclaré : ','Reported value: ')+amount,t('Transaction : ','Trade date: ')+(event.tradeDate||t('non renseignée','unavailable')));
  lines.push(t('Publication : ','Filed: ')+event.fileDate,t('Source : ','Source: ')+event.source);
  if(event.convergence){
    const c=event.convergence;
    lines.push(c.kind==='buyers'?t(`Convergence : ${c.buyerCount} acheteurs distincts identifiés sur 30 jours.`,`Convergence: ${c.buyerCount} distinct buyers identified within 30 days.`):t(`Un nouveau déclarant 13D rejoint une société avec ${c.buyerCount} acheteur(s) distinct(s) identifié(s) sur 30 jours.`,`A new 13D reporting actor joins a company with ${c.buyerCount} distinct buyer(s) identified within 30 days.`));
    lines.push(t('Dates des achats : ','Trade dates of purchases: ')+c.firstTradeDate+' → '+c.lastTradeDate,t('Rapprochement factuel de déclarations, sans présumer d’une coordination ni constituer une recommandation.','Factual filing context; it does not establish coordination or constitute a recommendation.'));
  }
  lines.push(t('Détectée à la collecte des déclarations. La publication peut être postérieure à l’opération.','Detected when filings are collected. Publication may occur after the transaction.'));
  const text=lines.join('\n');
  return {title,text,analysisUrl:'https://kairosinsider.fr/dashboard.html?'+new URLSearchParams({symbol:event.ticker,lang}),sourceUrl:event.sourceUrl};
}
async function digestId(id){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(id));return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');}
export function isInsiderQuietHours(prefs={},now=new Date()){
  const start=Number.isInteger(prefs.quietHoursStart)?prefs.quietHoursStart:22,end=Number.isInteger(prefs.quietHoursEnd)?prefs.quietHoursEnd:7;
  const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Paris',hour:'numeric',hourCycle:'h23'}).format(now));
  return start===end?false:start<end?hour>=start&&hour<end:hour>=start||hour<end;
}
function currentMovements(payload,now){
  if(!Array.isArray(payload?.transactions))return null;
  const cutoff=new Date(now-30*DAY).toISOString().slice(0,10),today=new Date(now).toISOString().slice(0,10),groups=new Map(),rejections=new Set();
  for(const row of preferInsiderTransactionEvidence(payload.transactions)){
    const event=normalizeInsiderMovement(row,{includeExcluded:true});if(!event||event.fileDate<cutoff||event.fileDate>today)continue;
    if(event.purchaseSignalStatus==='excluded'&&event.purchaseSignalReason!=='not-purchase'){
      const key=movementObservationKey(event);if(key)rejections.add(key);continue;
    }
    if(event.type!=='sell'&&!event.purchaseSignalEligible)continue;
    if(!groups.has(event.ticker))groups.set(event.ticker,new Map());groups.get(event.ticker).set(event.id,event);
  }
  for(const events of groups.values())for(const [id,event] of events)if(rejectedObservation(event,rejections))events.delete(id);
  return {cutoff,groups,rejections};
}
// The persisted event identity retains the filing and economic fill even when
// compact convergence observations no longer contain those source fields.
// Ignore only its broad type so an explicit P -> grant correction can revoke
// the same observation. Missing/partial feeds and other fills revoke nothing.
function movementObservationKey(event){
  try{const parts=JSON.parse(event.id);if(!Array.isArray(parts)||parts.length!==11||!parts[1])return null;return JSON.stringify([...parts.slice(0,6),...parts.slice(7)]);}catch{return null;}
}
const rejectedObservation=(event,rejections)=>{const key=movementObservationKey(event);return key!==null&&rejections.has(key);};
const reconcileObservations=(previous,rejections)=>previous?{...previous,purchases:(previous.purchases||[]).filter(event=>!rejectedObservation(event,rejections))}:previous;
// Called only by authenticated configuration/confirmation handlers, never sends.
// This closes the activation-to-next-cron gap while retaining silent fallback.
export async function seedInsiderMovementBaseline(env,sub,channel,now=Date.now()){
  const current=currentMovements(await env.CACHE.get('insider-transactions','json'),now);if(!current)return false;
  const activists=currentActivistFilings(await env.CACHE.get('13dg-recent','json').catch(()=>null),now);
  const key=`insider-alert-state:${channel}:${sub.uid}`,old=await env.CACHE.get(key,'json'),activation=sub[channel+'Activation']||0;
  const fresh=!old?.enabled||old.activation!==activation;
  const next={enabled:true,activation,tickers:{},pending:fresh?[]:(old.pending||[]).filter(e=>!rejectedObservation(e,current.rejections)&&sub.watchlist.has(e.ticker)&&e.fileDate>=current.cutoff&&(e.type==='activist-purchase'||classifyInsiderTransaction(e).type==='sell'||classifyInsiderTransaction(e).eligiblePurchase))};
  for(const ticker of sub.watchlist){
    const token=sub.watchStartedAt?.[ticker]||0,previous=fresh?null:reconcileObservations(old.tickers?.[ticker],current.rejections);
    if(previous&&previous.token===token){next.tickers[ticker]=previous;continue;}
    const events=[...(current.groups.get(ticker)?.values()||[])],context=advanceWatchlistConvergence({events,previous:null,seen:new Map(),bootstrap:true,filings:activists===null?null:[...(activists.get(ticker)?.values()||[])],now});
    next.tickers[ticker]={token,seen:events.map(event=>[event.id,event.fileDate]),purchases:context.purchases,activists:context.activists};
    next.pending=next.pending.filter(e=>e.ticker!==ticker);
  }
  await env.CACHE.put(key,JSON.stringify(next));return true;
}

// Separate state per user and channel: quiet hours or a failed transport never
// consume the other channel's event. Source outages do not establish a baseline.
export async function runInsiderMovementAlerts(env,subscribers,{sendEmail,sendTelegram,isQuiet=isInsiderQuietHours,now=Date.now()}={}){
  const payload=await env.CACHE.get('insider-transactions','json');
  const summary={checked:0,email:0,telegram:0,pending:0,errors:0,bootstrapped:0};
  const current=currentMovements(payload,now);if(!current)return summary;
  const {cutoff,groups,rejections}=current;
  const activists=currentActivistFilings(await env.CACHE.get('13dg-recent','json').catch(()=>null),now);
  for(const sub of subscribers){
    for(const channel of ['email','telegram']){
      const stateKey=`insider-alert-state:${channel}:${sub.uid}`;
      try{
        const enabled=sub[channel+'Enabled']===true,activation=sub[channel+'Activation']||0;
        const previous=await env.CACHE.get(stateKey,'json');
        if(!enabled){if(previous?.enabled)await env.CACHE.put(stateKey,JSON.stringify({enabled:false,activation,tickers:{},pending:[]}));continue;}
        const fresh=!previous?.enabled||previous.activation!==activation;
        const next={enabled:true,activation,tickers:{},pending:fresh?[]:(previous.pending||[]).filter(e=>!rejectedObservation(e,rejections)&&sub.watchlist.has(e.ticker)&&e.fileDate>=cutoff&&allowsConvergenceEvent(sub,channel,e)&&(e.type==='activist-purchase'||classifyInsiderTransaction(e).type==='sell'||classifyInsiderTransaction(e).eligiblePurchase))};
        const pending=new Map(next.pending.map(e=>[e.id,e]));
        for(const ticker of sub.watchlist){
          const token=sub.watchStartedAt?.[ticker]||0,old=fresh?null:reconcileObservations(previous.tickers?.[ticker],rejections);
          const bootstrap=!old||old.token!==token,seen=new Map(bootstrap?[]:(old.seen||[]).filter(([,day])=>day>=cutoff));
          if(bootstrap){summary.bootstrapped++;for(const [id,e]of pending)if(e.ticker===ticker)pending.delete(id);}
          const events=[...(groups.get(ticker)?.values()||[])],context=advanceWatchlistConvergence({events,previous:bootstrap?null:old,seen,bootstrap,filings:activists===null?null:[...(activists.get(ticker)?.values()||[])],now});
          for(const event of context.discovered)if(allowsConvergenceEvent(sub,channel,event))pending.set(event.id,event);
          for(const event of events)seen.set(event.id,event.fileDate);
          next.tickers[ticker]={token,seen:[...seen],purchases:context.purchases,activists:context.activists};
        }
        next.pending=[...pending.values()];
        // Persist discoveries before delivery so transport failures are retryable.
        await env.CACHE.put(stateKey,JSON.stringify(next));
        const remaining=[];let attempts=0;
        for(let event of next.pending){
          // Previously queued crossovers may have relied on a legacy grant.
          // Rebuild their support from the evidence-qualified state, including
          // during source outages, before a retry can reach either channel.
          if(event.convergence){
            const support=(next.tickers[event.ticker]?.purchases||[]).filter(p=>classifyInsiderTransaction(p).eligiblePurchase&&p.tradeDate<=event.fileDate);
            const buyers=aggregateInsiderSignalRows(support.map(p=>({...p,ticker:event.ticker,date:p.tradeDate}))).reduce((sum,g)=>sum+g.buyInsiders,0);
            if(event.type==='activist-purchase'&&!buyers)continue;
            if(event.convergence.kind==='buyers'&&buyers<2){const {convergence,...filing}=event;event=filing;}
          }
          // Transport delays must not turn an expired trade window into a fresh
          // convergence. The original individual filing remains deliverable.
          if(event.convergence&&(event.convergence.firstTradeDate<cutoff||event.fileDate<new Date(now-7*DAY).toISOString().slice(0,10))){
            if(event.type==='activist-purchase')continue;
            const {convergence,...filing}=event;event=filing;
          }
          const sentKey=`insider-alert-sent:${channel}:${sub.uid}:${await digestId(event.id)}`;
          if(await env.CACHE.get(sentKey))continue;
          if(attempts>=25||channel==='telegram'&&isQuiet(sub.prefs,new Date(now))){remaining.push(event);continue;}
          attempts++;summary.checked++;
          try{const send=channel==='email'?sendEmail:sendTelegram;const ok=await send(sub,event);if(!ok){remaining.push(event);continue;}await env.CACHE.put(sentKey,JSON.stringify(true),{expirationTtl:35*86400});summary[channel]++;}
          catch{summary.errors++;remaining.push(event);}
        }
        next.pending=remaining;summary.pending+=remaining.length;await env.CACHE.put(stateKey,JSON.stringify(next));
      }catch{summary.errors++;}
    }
  }
  return summary;
}
