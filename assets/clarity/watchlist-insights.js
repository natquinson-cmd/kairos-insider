(()=>{'use strict';
const U=window.KairosUI,{t,esc:e,lang,format:n}=U,C=window.KairosSignalContext,$=id=>document.getElementById(id);
const safeUrl=value=>{try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)?u.href:null;}catch{return null;}};
const date=value=>{if(!value)return '—';const d=new Date(/^\d{4}-\d{2}-\d{2}$/.test(value)?value+'T12:00:00':value);return Number.isFinite(d.getTime())?d.toLocaleDateString(lang==='en'?'en-US':'fr-FR',{day:'numeric',month:'short',year:'numeric'}):'—';};
const number=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
const signed=value=>(value>0?'+':'')+n(value)+' %';
const direction=value=>value>0?'is-up':value<0?'is-down':'is-flat';
function companyLogo(ticker){return `<span class="watch-company-logo" aria-hidden="true"><span>${e(ticker.slice(0,2))}</span><img src="https://assets.parqet.com/logos/symbol/${encodeURIComponent(ticker)}" loading="lazy" alt="" width="32" height="32"></span>`;}
function selectEvents(events,days,type,today){
 const end=C.day(today)||new Date().toISOString().slice(0,10),start=new Date(Date.parse(end)-(days-1)*86400000).toISOString().slice(0,10);
 return events.filter(row=>{const filed=C.day(row?.fileDate),q=C.qualification(row,{lang});return ['buy','sell','other'].includes(row?.type)&&filed&&filed>=start&&filed<=end&&(type==='all'||type==='buy'&&q.eligiblePurchase||type==='sell'&&q.tone==='negative'||type==='review'&&!q.eligiblePurchase&&q.tone!=='negative');});
}
function create(onChange){
 let symbols=[],key=null,request=0,items=new Map(),data=null,state='loading',days=7,type='all',visible=8;
 const scoreStates=new Map();let scorePaintPending=false;
 function notifyScores(){onChange();$('watchlistRows')?.querySelectorAll('[data-score-retry]').forEach(button=>button.onclick=()=>scoreLoader?.retry(button.dataset.scoreRetry));}
 const scoreLoader=window.KairosWatchlistScores?.create({api:U.api,onChange:event=>{
  scoreStates.set(event.ticker,event.state);const row=items.get(event.ticker);if(row&&event.item)Object.assign(row,event.item);
  if(!scorePaintPending){scorePaintPending=true;Promise.resolve().then(()=>{scorePaintPending=false;notifyScores();});}
 }});
 function scoreProgress(ticker){
  const phase=scoreStates.get(ticker);
  if(phase==='loading')return `<small role="status">${t('Calcul du score en cours…','Calculating score…')}</small>`;
  if(phase==='queued')return `<small>${t('Calcul en attente','Score queued')}</small>`;
  if(phase==='error')return `<small>${t('Actualisation du score indisponible','Score refresh unavailable')}</small><button type="button" class="text-button" data-score-retry="${e(ticker)}">${t('Réessayer','Retry')}</button>`;
  return '';
 }
 $('watchActivityTitle').textContent=t('Ce qui bouge sur vos valeurs','Activity on your stocks');
 $('watchActivityIntro').textContent=t('Les opérations publiées sur vos sociétés suivies, avec leur qualification et leur date d’exécution.','Filings on your followed companies, with their qualification and execution dates.');
 $('watchActivityControls').innerHTML=`<label>${t('Publications sur','Filings over')}<select id="watchActivityDays"><option value="7">${t('7 jours','7 days')}</option><option value="30">${t('30 jours','30 days')}</option></select></label><label>${t('Opérations','Transactions')}<select id="watchActivityType"><option value="all">${t('Toutes','All')}</option><option value="buy">${t('Achats retenus','Qualifying purchases')}</option><option value="sell">${t('Ventes','Sales')}</option><option value="review">${t('Autres opérations','Other transactions')}</option></select></label><button type="button" class="text-button" id="watchActivityRefresh">${t('Actualiser','Refresh')}</button>`;
 $('watchActivityDays').value='7';$('watchActivityType').value='all';
 $('watchActivityDays').onchange=event=>{days=Number(event.target.value)===30?30:7;visible=8;render();};
 $('watchActivityType').onchange=event=>{type=['buy','sell','review'].includes(event.target.value)?event.target.value:'all';visible=8;render();};
 $('watchActivityRefresh').onclick=()=>update(symbols,true);
 $('watchActivityMore').textContent=t('Voir les suivantes','Show more');
 $('watchActivityMore').onclick=()=>{visible+=8;render();};
 function render(){
  const host=$('watchActivityRows');$('watchActivityMore').hidden=true;$('watchActivitySummary').textContent='';$('watchActivityNote').textContent='';$('watchActivityRefresh').disabled=state==='loading';
  if(!symbols.length){host.innerHTML=`<p>${t('Suivez une action ci-dessous pour retrouver ses déclarations ici.','Follow a stock below to see its filings here.')}</p>`;return;}
  if(state==='loading'){host.innerHTML=`<p>${t('Chargement des déclarations…','Loading filings…')}</p>`;return;}
  if(state==='error'||!data?.activity?.available){host.innerHTML=`<p>${t('Déclarations momentanément indisponibles. Réessayez avec « Actualiser ».','Filings temporarily unavailable. Try “Refresh” again.')}</p>`;return;}
  const today=data.updatedAt||new Date().toISOString(),rows=selectEvents(data.activity.events||[],days,type,today);
  const qualifications=rows.map(row=>C.qualification(row,{lang})),buys=qualifications.filter(q=>q.eligiblePurchase).length,sells=qualifications.filter(q=>q.tone==='negative').length,excluded=qualifications.filter(q=>q.status==='excluded'&&q.tone!=='negative').length,uncertain=qualifications.filter(q=>q.status==='unknown').length,companies=new Set(rows.map(row=>row.ticker)).size;
  $('watchActivitySummary').textContent=[t(`${buys} achat${buys===1?'':'s'} retenu${buys===1?'':'s'}`,`${buys} qualifying purchase${buys===1?'':'s'}`),t(`${sells} vente${sells===1?'':'s'}`,`${sells} sale${sells===1?'':'s'}`),excluded?t(`${excluded} hors signal`,`${excluded} excluded`):'',uncertain?t(`${uncertain} à vérifier`,`${uncertain} to verify`):'',t(`${companies} société${companies===1?'':'s'}`,`${companies} compan${companies===1?'y':'ies'}`)].filter(Boolean).join(' · ');
  host.innerHTML=rows.length?rows.slice(0,visible).map(row=>{
   const url=safeUrl(row.sourceUrl),value=number(row.value),q=C.qualification(row,{lang}),dates=C.dates(row,{lang});
   return `<article class="watch-activity-row"><div class="watch-activity-stock"><a href="${e(U.stockUrl(row.ticker))}">${e(row.ticker)} ↗</a><span class="watch-activity-type ${q.tone==='positive'?'is-buy':q.tone==='negative'?'is-sell':'is-neutral'}">${e(q.label)}</span><strong>${value==null?'—':e(n(value)+' '+(row.currency||''))}</strong></div><div class="watch-activity-person">${e(row.insider||t('Déclarant non précisé','Reporting person unavailable'))}</div><div class="watch-activity-meta"><span>${e(dates.publication.label)} : ${e(dates.publication.text)}${dates.publication.ageLabel?` · ${e(dates.publication.ageLabel)}`:''}<br>${t('Opération :','Executed:')} ${e(dates.execution.text)}</span>${url?`<a href="${e(url)}" target="_blank" rel="noopener noreferrer">${t('Déclaration source','Source filing')} ↗</a>`:`<span>${t('Lien source indisponible','Source link unavailable')}</span>`}</div>${dates.warnings.length?`<p class="watch-date-warning">${e(dates.warnings.join(' · '))}</p>`:''}<details class="watch-qualification"><summary>${t('Comprendre ce statut','Understand this status')}</summary><p>${e(q.detail)}</p></details></article>`;
  }).join(''):`<p>${t('Aucune déclaration disponible pour ces filtres. Essayez 30 jours ou toutes les opérations.','No filings available for these filters. Try 30 days or all transaction types.')}</p>`;
  $('watchActivityMore').hidden=visible>=rows.length;
  $('watchActivityNote').textContent=(data.activity.truncated?t('Les 200 déclarations les plus récentes sont affichables. ','The latest 200 filings are available. '):'')+t('La période filtre les publications, pas les dates d’exécution. Les acquisitions exclues ou incertaines ne comptent pas comme achats retenus. Ce journal ne confirme pas l’envoi d’une alerte.','The period filters publication dates, not execution dates. Excluded or uncertain acquisitions do not count as qualifying purchases. This journal does not confirm alert delivery.');
 }
 function stockDetails(ticker){
  const row=items.get(ticker);if(!row)return `<span class="watch-quote">—</span><small>${t('Données non chargées','Data not loaded')}</small>`;
  const price=number(row.price),event=row.latestInsider,change=price==null?null:number(row.changePercent);
  return `<span class="watch-quote">${price==null?'—':e(n(price)+' '+(row.currency||''))}</span>${change==null?'':`<span class="watch-day-change ${direction(change)}">${e(signed(change))}</span>`}<small>${price==null?t('Cours indisponible','Price unavailable'):t('Séance du ','Session: ')+e(date(row.quoteAt))}</small>${event?`<small class="watch-latest">${e(C.qualification(event,{lang}).label)} · ${t('publié le ','published ')}${e(date(event.fileDate))}</small>`:''}`;
 }
 function stockTrend(ticker){
  const row=items.get(ticker),curve=row?.sparkline3m,points=(curve?.points||[]).filter(p=>number(p.close)>0&&Number.isFinite(Date.parse(p.date)));
  const score=number(row?.score),historical=row?.scoreStatus==='historical',scoreMarkup=(score==null?'':`<small class="watch-score ${historical?'':score>=75?'is-up':score>=55?'is-favorable':score>=35?'is-cautious':'is-down'}" title="${e(t('Score au ','Score as of ')+date(row.scoreAt))}">Kairos <b>${e(n(score,0))}</b>/100</small>${historical?`<small>${t('Score historique','Historical score')} · ${e(date(row.scoreAt))}</small><small>${t('La méthode peut différer de l’analyse actuelle.','The method may differ from the current analysis.')}</small>`:''}`)+scoreProgress(ticker);
  if(points.length<2)return `<small>${t('Courbe indisponible','Chart unavailable')}</small>${scoreMarkup}`;
  const min=Math.min(...points.map(p=>p.close)),max=Math.max(...points.map(p=>p.close)),first=Date.parse(points[0].date),span=Date.parse(points.at(-1).date)-first;
  if(span<=0)return `<small>${t('Courbe indisponible','Chart unavailable')}</small>${scoreMarkup}`;
  const path=points.map(p=>((Date.parse(p.date)-first)/span*136+2).toFixed(1)+','+(max===min?22:40-(p.close-min)/(max-min)*36).toFixed(1)).join(' ');
  const change=number(curve.changePercent),title=date(curve.from)+' – '+date(curve.to)+(change==null?'':' · '+signed(change));
  return `<div class="watch-trend ${direction(change)}"><svg viewBox="0 0 140 44" role="img" aria-label="${e(t('Cours sur trois mois : ','Three-month prices: ')+title)}"><title>${e(title)}</title><polygon points="2,44 ${path} 138,44" fill="currentColor" opacity=".12"/><polyline points="${path}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg><small title="${e(title)}">${curve.partial?t('Période partielle','Partial period'):t('3 mois','3 months')} ${change==null?'':e(signed(change))}</small></div>${scoreMarkup}`;
 }
 async function update(next,force=false){
  const nextKey=next.join(',');if(nextKey===key&&!force)return;
  scoreLoader?.stop();scoreStates.clear();key=nextKey;symbols=[...next];const current=++request;items=new Map();data=null;state=symbols.length?'loading':'empty';render();onChange();
  if(!symbols.length)return;
  try{const result=await U.api('/api/watchlist/summary?'+new URLSearchParams({symbols:nextKey}));if(current!==request)return;const wanted=new Set(symbols);data={...result,activity:result.activity?{...result.activity,events:(result.activity.events||[]).filter(row=>wanted.has(row.ticker))}:null};const received=new Map((result.items||[]).filter(row=>wanted.has(row.ticker)).map(row=>[row.ticker,row]));items=new Map(symbols.map(ticker=>[ticker,received.get(ticker)||{ticker}]));state='ready';scoreLoader?.load([...items.values()]);}
  catch{if(current!==request)return;state='error';}
  render();onChange();
 }
 return {update,stockDetails,stockTrend,stockName:ticker=>items.get(ticker)?.name||''};
}
window.KairosWatchInsights={create,selectEvents,companyLogo};
})();
