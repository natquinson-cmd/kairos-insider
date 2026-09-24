(()=>{'use strict';
const U=window.KairosUI,{t,esc:e,lang,format:n}=U,$=id=>document.getElementById(id);
const safeUrl=value=>{try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)?u.href:null;}catch{return null;}};
const date=value=>{if(!value)return '—';const d=new Date(/^\d{4}-\d{2}-\d{2}$/.test(value)?value+'T12:00:00':value);return Number.isFinite(d.getTime())?d.toLocaleDateString(lang==='en'?'en-US':'fr-FR',{day:'numeric',month:'short',year:'numeric'}):'—';};
const number=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
function selectEvents(events,days,type,today){
 const end=today.slice(0,10),start=new Date(Date.parse(end)-(days-1)*86400000).toISOString().slice(0,10);
 return events.filter(row=>['buy','sell'].includes(row.type)&&row.fileDate>=start&&row.fileDate<=end&&(type==='all'||row.type===type));
}
function create(onChange){
 let symbols=[],key=null,request=0,items=new Map(),data=null,state='loading',days=7,type='all',visible=8;
 $('watchActivityTitle').textContent=t('Ce qui bouge sur vos valeurs','Activity on your stocks');
 $('watchActivityIntro').textContent=t('Les achats et ventes d’initiés publiés sur vos sociétés suivies.','Insider purchases and sales disclosed for your followed companies.');
 $('watchActivityControls').innerHTML=`<label>${t('Publications sur','Filings over')}<select id="watchActivityDays"><option value="7">${t('7 jours','7 days')}</option><option value="30">${t('30 jours','30 days')}</option></select></label><label>${t('Opérations','Transactions')}<select id="watchActivityType"><option value="all">${t('Achats et ventes','Purchases and sales')}</option><option value="buy">${t('Achats','Purchases')}</option><option value="sell">${t('Ventes','Sales')}</option></select></label><button type="button" class="text-button" id="watchActivityRefresh">${t('Actualiser','Refresh')}</button>`;
 $('watchActivityDays').value='7';$('watchActivityType').value='all';
 $('watchActivityDays').onchange=event=>{days=Number(event.target.value)===30?30:7;visible=8;render();};
 $('watchActivityType').onchange=event=>{type=['buy','sell'].includes(event.target.value)?event.target.value:'all';visible=8;render();};
 $('watchActivityRefresh').onclick=()=>update(symbols,true);
 $('watchActivityMore').textContent=t('Voir les suivantes','Show more');
 $('watchActivityMore').onclick=()=>{visible+=8;render();};
 function render(){
  const host=$('watchActivityRows');$('watchActivityMore').hidden=true;$('watchActivitySummary').textContent='';$('watchActivityNote').textContent='';$('watchActivityRefresh').disabled=state==='loading';
  if(!symbols.length){host.innerHTML=`<p>${t('Suivez une action ci-dessous pour retrouver ses déclarations ici.','Follow a stock below to see its filings here.')}</p>`;return;}
  if(state==='loading'){host.innerHTML=`<p>${t('Chargement des déclarations…','Loading filings…')}</p>`;return;}
  if(state==='error'||!data?.activity?.available){host.innerHTML=`<p>${t('Déclarations momentanément indisponibles. Réessayez avec « Actualiser ».','Filings temporarily unavailable. Try “Refresh” again.')}</p>`;return;}
  const today=data.updatedAt||new Date().toISOString(),rows=selectEvents(data.activity.events||[],days,type,today);
  const buys=rows.filter(row=>row.type==='buy').length,sells=rows.length-buys,companies=new Set(rows.map(row=>row.ticker)).size;
  $('watchActivitySummary').textContent=t(`${buys} achat${buys===1?'':'s'} · ${sells} vente${sells===1?'':'s'} · ${companies} société${companies===1?'':'s'}`,`${buys} purchases · ${sells} sales · ${companies} companies`);
  host.innerHTML=rows.length?rows.slice(0,visible).map(row=>{
   const url=safeUrl(row.sourceUrl),value=number(row.value),buy=row.type==='buy';
   return `<article class="watch-activity-row"><div class="watch-activity-stock"><a href="${e(U.stockUrl(row.ticker))}">${e(row.ticker)} ↗</a><span class="watch-activity-type ${buy?'is-buy':'is-sell'}">${buy?t('Achat','Purchase'):t('Vente','Sale')}</span><strong>${value==null?'—':e(n(value)+' '+(row.currency||''))}</strong></div><div class="watch-activity-person">${e(row.insider||t('Déclarant non précisé','Reporting person unavailable'))}</div><div class="watch-activity-meta"><span>${t('Publié :','Filed:')} ${e(date(row.fileDate))} · ${t('Transaction :','Trade:')} ${e(date(row.tradeDate))}</span>${url?`<a href="${e(url)}" target="_blank" rel="noopener noreferrer">${t('Déclaration source','Source filing')} ↗</a>`:`<span>${t('Lien source indisponible','Source link unavailable')}</span>`}</div></article>`;
  }).join(''):`<p>${t('Aucune déclaration disponible pour ces filtres. Essayez 30 jours ou les deux types d’opérations.','No filings available for these filters. Try 30 days or both transaction types.')}</p>`;
  $('watchActivityMore').hidden=visible>=rows.length;
  $('watchActivityNote').textContent=(data.activity.truncated?t('Les 200 déclarations les plus récentes sont affichables. ','The latest 200 filings are available. '):'')+t('Couverture des données disponibles, selon la date de publication. Ce journal ne confirme pas l’envoi d’une alerte.','Available data coverage, filtered by filing date. This journal does not confirm alert delivery.');
 }
 function stockDetails(ticker){
  const row=items.get(ticker);if(!row)return `<span class="watch-quote">—</span><small>${t('Données non chargées','Data not loaded')}</small>`;
  const price=number(row.price),event=row.latestInsider;
  return `<span class="watch-quote">${price==null?'—':e(n(price)+' '+(row.currency||''))}</span><small>${price==null?t('Cours indisponible','Price unavailable'):t('Cours du ','Price as of ')+e(date(row.quoteAt))}</small>${event?`<small class="watch-latest">${event.type==='buy'?t('Dernier achat déclaré','Latest disclosed purchase'):t('Dernière vente déclarée','Latest disclosed sale')} · ${e(date(event.fileDate))}</small>`:''}`;
 }
 async function update(next,force=false){
  const nextKey=next.join(',');if(nextKey===key&&!force)return;
  key=nextKey;symbols=[...next];const current=++request;items=new Map();data=null;state=symbols.length?'loading':'empty';render();onChange();
  if(!symbols.length)return;
  try{const result=await U.api('/api/watchlist/summary?'+new URLSearchParams({symbols:nextKey}));if(current!==request)return;const wanted=new Set(symbols);data={...result,activity:result.activity?{...result.activity,events:(result.activity.events||[]).filter(row=>wanted.has(row.ticker))}:null};items=new Map((result.items||[]).filter(row=>wanted.has(row.ticker)).map(row=>[row.ticker,row]));state='ready';}
  catch{if(current!==request)return;state='error';}
  render();onChange();
 }
 return {update,stockDetails,stockName:ticker=>items.get(ticker)?.name||''};
}
window.KairosWatchInsights={create,selectEvents};
})();
