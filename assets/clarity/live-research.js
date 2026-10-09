(async()=>{'use strict';
const U=window.KairosUI,{t,esc:e,lang,format:n}=U,C=window.KairosSignalContext,$=id=>document.getElementById(id);
document.body.dataset.screen='research';document.title=t('Votre recherche — Kairos Insider','Your research — Kairos Insider');
const main=document.createElement('main');main.id='researchMain';main.tabIndex=-1;
main.innerHTML=`<section class="research-hero" aria-labelledby="researchTitle"><div><h1 id="researchTitle">${t('Quelle société voulez-vous explorer ?','Which company would you like to explore?')}</h1><p>${t('Vos valeurs suivies et leurs dernières déclarations, au même endroit.','Your followed stocks and their latest filings, together.')}</p></div><div id="researchSearch"></div></section>
<section class="research-section research-activity" id="researchActivity" aria-labelledby="researchActivityTitle"><div class="research-section-head"><div><h2 id="researchActivityTitle">${t('Dernières déclarations sur vos valeurs','Latest filings on your stocks')}</h2><p>${t('Publications des 30 derniers jours · La date d’opération est indiquée séparément.','Filings from the last 30 days · Transaction dates are shown separately.')}</p></div><a class="text-button" href="watchlist.html?lang=${lang}#watchActivityTitle">${t('Tout le journal','Full activity log')} →</a></div><div id="researchActivityContent" role="status">${t('Chargement des déclarations…','Loading filings…')}</div><button class="text-button" id="moreResearchActivity" hidden>${t('Voir les suivantes','Show more')}</button><p class="research-note" id="researchActivityNote" hidden></p></section>
<section class="research-section" aria-labelledby="researchWatchTitle"><div class="research-section-head"><div><h2 id="researchWatchTitle">${t('Votre watchlist, en un coup d’œil','Your watchlist at a glance')}</h2></div><a class="text-button" href="watchlist.html?lang=${lang}">${t('Gérer ma watchlist','Manage my watchlist')} →</a></div><div id="researchWatchContent" role="status">${t('Chargement de votre watchlist…','Loading your watchlist…')}</div><button class="secondary" id="moreResearchWatch" hidden>${t('Voir plus de valeurs','Show more stocks')}</button><p class="research-note" id="researchFreshness" hidden></p></section>
<section class="research-section research-history" aria-labelledby="recentTitle"><div class="research-section-head"><h2 id="recentTitle">${t('Reprendre une recherche','Pick up your research')}</h2><button class="text-button" id="clearResearchHistory">${t('Effacer l’historique','Clear history')}</button></div><div id="recentResearch"></div><p class="research-note">${t('Historique enregistré uniquement dans ce navigateur, pour ce compte.','History is saved only in this browser, for this account.')}</p></section>`;
$('companyMain').before(main);$('liveStatus').hidden=true;document.querySelector('.skip-link').href='#researchMain';
const search=$('searchWrap');$('researchSearch').append(search);search.hidden=false;search.querySelector('label').textContent=t('Rechercher une société ou un symbole','Search for a company or ticker');
const header=document.querySelector('.topbar');header.classList.add('research-topbar');const context=document.createElement('span');context.className='research-header-label';context.textContent=t('Votre recherche','Your research');header.prepend(context);
let history;const recent=$('recentResearch'),clear=$('clearResearchHistory');clear.hidden=true;
const logo=s=>`<span class="research-logo" aria-hidden="true"><span>${e(s.slice(0,2))}</span><img loading="lazy" src="https://assets.parqet.com/logos/symbol/${encodeURIComponent(s)}" alt="" width="30" height="30"></span>`;
function fixImages(host){host.querySelectorAll('img').forEach(img=>img.addEventListener('error',()=>img.remove(),{once:true}));}
function renderHistory(){const rows=history.load();clear.hidden=!rows.length;recent.innerHTML=rows.length?`<div class="research-recent-strip">${rows.map(row=>`<a href="${e(U.stockUrl(row.ticker))}" class="research-recent-item">${logo(row.ticker)}<span><strong>${e(row.ticker)}</strong><small>${e(row.name)}</small></span></a>`).join('')}</div>`:`<p class="research-empty">${t('Vos prochaines recherches apparaîtront ici.','Your next searches will appear here.')}</p>`;fixImages(recent);}
Promise.resolve().then(()=>U.researchHistory()).then(value=>{history=value;renderHistory();}).catch(()=>{clear.hidden=true;recent.innerHTML=`<p class="research-empty">${t('Historique momentanément indisponible.','History is temporarily unavailable.')}</p>`;});
clear.onclick=()=>{if(history){history.clear();renderHistory();}};
const watch=$('researchWatchContent'),more=$('moreResearchWatch'),activityHost=$('researchActivityContent'),activityMore=$('moreResearchActivity');
const account=await U.getAccount();
if(!account){$('researchActivity').hidden=true;watch.innerHTML=`<div class="research-empty"><p>${t('Connectez-vous pour retrouver vos sociétés suivies et leurs signaux.','Sign in to see your followed companies and their signals.')}</p><button class="secondary" id="researchLogin">${t('Se connecter','Sign in')}</button></div>`;$('researchLogin').onclick=U.login;return;}
const number=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
const date=v=>C.formatDate(v,{lang});
const safeUrl=value=>{try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)?url.href:null;}catch{return null;}};
let items=[],visible=8,activity=[],activityVisible=3,summaryAt;
const scoreStates=new Map();let scorePaintPending=false;
const scoreLoader=window.KairosWatchlistScores?.create({api:U.api,onChange:event=>{
 scoreStates.set(event.ticker,event.state);const row=items.find(item=>item.ticker===event.ticker);if(row&&event.item)Object.assign(row,event.item);
 if(!scorePaintPending){scorePaintPending=true;Promise.resolve().then(()=>{scorePaintPending=false;renderWatch();});}
}});
function scoreProgress(row){
 const state=scoreStates.get(row.ticker);
 if(state==='loading')return `<small role="status">${t('Calcul du score en cours…','Calculating score…')}</small>`;
 if(state==='queued')return `<small class="research-muted">${t('Calcul en attente','Score queued')}</small>`;
 if(state==='error')return `<small class="research-stale">${row.score==null?t('Score momentanément indisponible','Score temporarily unavailable'):t('Actualisation indisponible','Refresh unavailable')}</small><button type="button" class="text-button" data-score-retry="${e(row.ticker)}">${t('Réessayer','Retry')}</button>`;
 return '';
}
function eventDates(event){const d=C.dates(event,{lang,now:summaryAt});return `<span>${e(d.publication.ageLabel||d.publication.label)} · <b>${e(d.publication.text)}</b></span><span>${e(d.execution.label)} <b>${e(d.execution.text)}</b></span>${d.warnings.length?`<span class="research-date-warning">${e(d.warnings.join(' · '))}</span>`:''}`;}
function signal(event){
 if(!event)return `<span class="research-muted">${t('Aucune déclaration disponible','No available filing')}</span>`;
 const q=C.qualification(event,{lang});
 return `<span class="research-event ${q.tone}">${e(q.label)}</span><small>${e(event.insider||'—')}</small><div class="research-event-dates">${eventDates(event)}</div>`;
}
function renderActivity(){
 activityHost.innerHTML=activity.length?`<div class="research-activity-list">${activity.slice(0,activityVisible).map(row=>{const q=C.qualification(row,{lang}),source=safeUrl(row.sourceUrl),value=number(row.value);return `<article class="research-activity-row"><a class="research-activity-company" href="${e(U.stockUrl(row.ticker))}">${logo(row.ticker)}<span><strong>${e(row.ticker)}</strong><small>${e(row.insider||t('Déclarant non précisé','Reporting person unavailable'))}</small></span></a><div class="research-activity-signal"><span class="research-event ${q.tone}">${e(q.label)}</span><strong>${value==null?'—':e(n(value)+' '+(row.currency||t('devise inconnue','unknown currency')))}</strong></div><div class="research-event-dates">${eventDates(row)}</div><details class="research-event-context"><summary>${t('Contexte','Context')}</summary><p>${e(q.detail)}</p>${source?`<a href="${e(source)}" target="_blank" rel="noopener noreferrer">${t('Déclaration source','Source filing')} ↗</a>`:`<span>${t('Lien source indisponible','Source link unavailable')}</span>`}</details></article>`;}).join('')}</div>`:`<p class="research-empty">${t('Aucune déclaration disponible sur vos valeurs dans les 30 derniers jours.','No filings available for your stocks in the last 30 days.')}</p>`;
 activityMore.hidden=activityVisible>=activity.length;fixImages(activityHost);
}
function loadActivity(data,tickers){
 const note=$('researchActivityNote');activityMore.hidden=true;
 if(!data.activity?.available){activityHost.innerHTML=`<p class="research-empty">${t('Les déclarations sont momentanément indisponibles. Vos cours restent consultables ci-dessous.','Filings are temporarily unavailable. Your prices remain available below.')}</p>`;return;}
 const today=C.day(data.updatedAt)||new Date().toISOString().slice(0,10),cutoff=new Date(Date.parse(today+'T00:00:00Z')-29*86400000).toISOString().slice(0,10),wanted=new Set(tickers),seen=new Set();
 activity=(data.activity.events||[]).filter(row=>{const day=C.day(row.fileDate);if(!wanted.has(row.ticker)||!day||day<cutoff||day>today)return false;const key=row.id||JSON.stringify([row.ticker,row.insider,row.fileDate,row.tradeDate,row.type,row.value,row.currency]);if(seen.has(key))return false;seen.add(key);return true;}).sort((a,b)=>b.fileDate.localeCompare(a.fileDate));
 renderActivity();note.hidden=false;note.textContent=(data.activity.truncated?t('Les 200 publications les plus récentes sont disponibles. ','The latest 200 filings are available. '):'')+t('Ce journal reflète les déclarations disponibles, pas le statut d’envoi des alertes.','This log shows available filings, not alert delivery status.')+(data.activity.sourceUpdatedAt?' '+t('Collecte : ','Data collected: ')+date(data.activity.sourceUpdatedAt):'');
}
activityMore.onclick=()=>{activityVisible+=3;renderActivity();};
function renderWatch(){
 watch.removeAttribute?.('role');
 watch.innerHTML=`<div class="table-wrap"><table class="research-watch-table"><thead><tr><th>${t('Société','Company')}</th><th class="number">${t('Cours','Price')}</th><th class="number">${t('Variation séance','Session change')}</th><th class="number">${t('Score Kairos','Kairos score')}</th><th>${t('Dernière déclaration d’initié','Latest insider filing')}</th></tr></thead><tbody>${items.slice(0,visible).map(row=>{
  const score=number(row.score),price=number(row.price),change=price==null?null:number(row.changePercent);
  const priceMarkup=price==null?`<span class="research-muted">${t('Cours indisponible','Price unavailable')}</span>`:`${e(n(price)+' '+(row.currency||''))}${row.quoteStatus==='stale'?`<small class="research-stale">${t('Dernier cours connu','Last known price')}</small>`:''}<small>${e(date(row.quoteAt))}</small>`;
  const historical=row.scoreStatus==='historical';
  const scoreMarkup=(score==null?'':`<span class="research-score ${historical?'':score>=75?'positive':score>=55?'favorable':score>=35?'cautious':'negative'}">${e(n(score,0))}<small>/100</small></span>${historical?`<small class="research-stale">${t('Score historique','Historical score')}</small>`:row.scoreStatus==='previous'?`<small class="research-stale">${t('Score antérieur','Previous score')}</small>`:''}<small>${e(date(row.scoreAt))}</small>`)+scoreProgress(row)||(score==null?`<span class="research-muted">${t('Chargement du score…','Loading score…')}</span>`:'');
  return `<tr><td><a class="research-stock-link" href="${e(U.stockUrl(row.ticker))}">${logo(row.ticker)}<span><strong>${e(row.ticker)}</strong><small>${e(row.name||row.ticker)}</small></span></a></td><td class="number">${priceMarkup}</td><td class="number ${change==null?'':change>=0?'positive':'negative'}">${change==null?'—':(change>0?'+':'')+e(n(change))+' %'}</td><td class="number">${scoreMarkup}</td><td>${signal(row.latestInsider)}</td></tr>`;
 }).join('')}</tbody></table></div>`;
 more.hidden=visible>=items.length;fixImages(watch);
 watch.querySelectorAll('[data-score-retry]').forEach(button=>button.onclick=()=>scoreLoader?.retry(button.dataset.scoreRetry));
 $('researchFreshness').textContent=t('Cours de la séance indiquée, potentiellement différés. La variation compare cette séance à la précédente. Les scores se calculent automatiquement, valeur par valeur, et conservent leur date de calcul.','Prices refer to the dated session and may be delayed. Change compares that session with the previous one. Scores calculate automatically, one stock at a time, and keep their calculation date.')+(items.some(row=>row.scoreStatus==='historical')?t(' Un score historique provient d’un calcul archivé de moins de 7 jours ; sa méthode peut différer de l’analyse actuelle.',' A historical score comes from an archived calculation within the last 7 days; its method may differ from the current analysis.'): '');
}
more.onclick=()=>{visible+=8;renderWatch();};
async function loadWatch(){try{
 scoreLoader?.stop();scoreStates.clear();
 const client=await U.watchlist(),saved=await client.load();
 if(!saved.tickers.length){$('researchActivity').hidden=true;watch.innerHTML=`<p class="research-empty">${t('Votre watchlist est vide. Ouvrez une fiche et cliquez sur « Suivre » pour retrouver la société ici.','Your watchlist is empty. Open a stock page and choose “Follow” to see it here.')}</p>`;return;}
 const data=await U.api('/api/watchlist/summary?'+new URLSearchParams({symbols:saved.tickers.join(',')}));summaryAt=data.updatedAt;
 const bySymbol=new Map((data.items||[]).map(row=>[row.ticker,row]));items=saved.tickers.map(ticker=>bySymbol.get(ticker)||{ticker});
 loadActivity(data,saved.tickers);renderWatch();$('researchFreshness').hidden=false;scoreLoader?.load(items);
}catch{activityHost.innerHTML=`<p class="research-empty">${t('Déclarations momentanément indisponibles.','Filings temporarily unavailable.')}</p>`;watch.innerHTML=`<div class="research-empty"><p>${t('Votre watchlist est momentanément indisponible.','Your watchlist is temporarily unavailable.')}</p><button class="secondary" id="retryResearchWatch">${t('Réessayer','Retry')}</button></div>`;$('retryResearchWatch').onclick=loadWatch;}}
await loadWatch();
})();
