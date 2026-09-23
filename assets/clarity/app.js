(() => {
  'use strict';
  const data = window.KairosLive;
  const $ = id => document.getElementById(id);
  const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labels = ['Dirigeants','Hedge funds','Politiciens et gourous','Momentum du cours','Valorisation','Consensus analystes','Santé financière','Momentum des résultats'];
  let weights = data.companies[0].weights;
  const state = {company:data.companies[0],range:'3M',view:null,tab:'overview',fundSection:'positions',event:null,activistId:null,hover:null,hoverPrice:null,pinned:false,followed:new Set(),searchIndex:0};
  const T=window.KairosUI.t;const locale=window.KairosUI.lang==='en'?'en-US':'fr-FR';
  const fmt = (value, digits=0) => value == null ? '—' : value.toLocaleString(locale,{minimumFractionDigits:digits,maximumFractionDigits:digits});
  const money = value => `${fmt(value,2)} ${state.company.currency}`;
  const compact = (value,currency=state.company.currency) => value==null?'—':value.toLocaleString(locale,{notation:'compact',maximumFractionDigits:1})+' '+currency;
  const signed = value => Math.abs(value)<.005?'0,00 %':`${value>=0?'+':'−'}${fmt(Math.abs(value),Math.abs(value)<.05?2:1)} %`;
  const dateLabel = (date,year=false) => !date?'—':new Date(`${date}T12:00:00Z`).toLocaleDateString(locale,{day:'numeric',month:'short',...(year?{year:'numeric'}:{})});
  const score = () => state.company.score;
  let plot = null;
  let fundView = null;
  let analysisView = null;
  let activistView = null;
  let companyActivistGroups = [];
  let toastTimer;
  let searchMatches = [];
  let wheelFrame=0,wheelDelta=0,wheelRatio=.5,drag=null;

  function presetWindow(range){
    const history=state.company.history;if(!history.length)return {start:0,end:0};const start=new Date(`${state.company.history.at(-1).date}T12:00:00Z`);
    start.setUTCMonth(start.getUTCMonth()-({'1M':1,'3M':3,'6M':6,'1Y':12}[range]));
    return {start:Math.max(0,history.findIndex(point=>point.date>=start.toISOString().slice(0,10))),end:history.length-1};
  }
  function currentWindow(){return state.view||presetWindow(state.range);}
  function chartBounds(){const full=presetWindow('1Y');return {min:full.start,max:full.end};}
  function cancelWheel(){if(wheelFrame)cancelAnimationFrame(wheelFrame);wheelFrame=0;wheelDelta=0;}
  function usePreset(range){cancelWheel();state.range=range;state.view=null;clearHover();if(!eventsInRange().some(event=>event.id===state.event))state.event=null;renderRange();}
  function applyWindow(view){
    state.view=view;state.range='custom';
    for(const range of ['1M','3M','6M','1Y']){const preset=presetWindow(range);if(view.start===preset.start&&view.end===preset.end){state.range=range;state.view=null;break;}}
    clearHover();if(!eventsInRange().some(event=>event.id===state.event))state.event=null;renderRange();
  }

  function historyInRange(){
    const view=currentWindow();return state.company.history.slice(view.start,view.end+1);
  }
  function eventsInRange(){if(!state.company.history.length)return [];const history=historyInRange();return state.company.events.filter(event=>event.date>=history[0].date&&event.date<=history.at(-1).date);}
  const activistColors={initial:'#efc16e',increase:'#57ddba',decrease:'#fc96a6',unchanged:'#b5a3dc',unknown:'#9faec5'};
  const activistDirection={initial:'Déclaration initiale',increase:'Participation en hausse',decrease:'Participation en baisse',unchanged:'Participation inchangée',unknown:'Évolution non renseignée'};
  const ownership=value=>typeof value==='number'&&Number.isFinite(value)?`${fmt(value,2)} %`:'Participation non renseignée';
  function activistChange(filing){
    if(filing.ownershipPercent==null||filing.previousPercent==null)return activistDirection[filing.direction]||activistDirection.unknown;
    const delta=filing.ownershipPercent-filing.previousPercent;
    return Math.abs(delta)<.0001?'Participation inchangée':`${delta>0?'+':'−'}${fmt(Math.abs(delta),2)} pt depuis le dépôt précédent`;
  }
  function activistGroupsInRange(includeHidden=false){
    const series=historyInRange();if(!series.length)return [];
    return companyActivistGroups.filter(group=>group.date>=series[0].date&&group.date<=series.at(-1).date).map(group=>({...group,filings:group.filings.filter(filing=>includeHidden||$(filing.classification==='passive'?'passiveActivistToggle':'activistToggle').checked)})).filter(group=>group.filings.length);
  }
  function notify(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,3300);}
  function setTab(name,focus=false){
    if(name!=='analysis')analysisView?.hideTooltip?.();
    if(state.tab!==name){cancelWheel();drag=null;clearHover();$('priceChart').classList.remove('is-dragging');}
    state.tab=name;const url=new URL(location.href);url.searchParams.set('tab',name);history.replaceState(null,'',url);
    document.querySelectorAll('[data-tab]').forEach(button=>{const active=button.dataset.tab===name;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;});
    document.querySelectorAll('#companyMain > [role=tabpanel]').forEach(panel=>panel.hidden=panel.id!==`panel-${name}`);
    if(focus)$(`tab-${name}`).focus();
    requestAnimationFrame(renderVisuals);
  }
  document.querySelectorAll('[data-tab]').forEach(button=>{
    button.addEventListener('click',()=>setTab(button.dataset.tab));
    button.addEventListener('keydown',event=>{const tabs=[...document.querySelectorAll('[data-tab]')];let index=tabs.indexOf(button);if(event.key==='ArrowRight')index=(index+1)%tabs.length;else if(event.key==='ArrowLeft')index=(index+tabs.length-1)%tabs.length;else if(event.key==='Home')index=0;else if(event.key==='End')index=tabs.length-1;else return;event.preventDefault();setTab(tabs[index].dataset.tab,true);});
  });
  function setFundSection(name,focus=false){
    state.fundSection=name;const url=new URL(location.href);url.searchParams.set('view',name);history.replaceState(null,'',url);
    document.querySelectorAll('[data-fund-view]').forEach(button=>{const selected=button.dataset.fundView===name;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;});
    $('fund-panel-positions').hidden=name!=='positions';$('fund-panel-activists').hidden=name!=='activists';
    if(focus)$(`fund-tab-${name}`).focus();
    if(name==='positions')requestAnimationFrame(()=>fundView?.redraw());
  }
  document.querySelectorAll('[data-fund-view]').forEach(button=>{
    button.addEventListener('click',()=>setFundSection(button.dataset.fundView));
    button.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?'positions':event.key==='End'?'activists':state.fundSection==='positions'?'activists':'positions';setFundSection(next,true);});
  });
  document.querySelectorAll('[data-open-tab]').forEach(button=>button.addEventListener('click',()=>{setTab(button.dataset.openTab,true);if(button.dataset.openTab==='funds')setFundSection('positions');}));
  document.querySelectorAll('[data-range]').forEach(button=>button.addEventListener('click',()=>usePreset(button.dataset.range)));
  $('resetZoom').addEventListener('click',()=>usePreset('3M'));
  $('benchmarkToggle').addEventListener('change',drawChart);
  ['activistToggle','passiveActivistToggle'].forEach(id=>$(id).addEventListener('change',()=>{clearHover();drawChart();}));
  $('scoreButton').addEventListener('click',()=>{const expanded=$('scoreDetails').hidden;$('scoreDetails').hidden=!expanded;$('scoreButton').setAttribute('aria-expanded',String(expanded));$('scoreButton').innerHTML=`${expanded?'Masquer le détail':'Comprendre les huit axes'} <span>${expanded?'−':'＋'}</span>`;});
  function renderFollow(){$('followButton').textContent=window.KairosUI.t('Partager','Share');}
  function renderCompany(){
    const company=state.company,last={close:company.raw.price?.current??company.history.at(-1)?.close},previous=company.history.at(-2),change=company.raw.price?.changePct; weights=company.weights;
    companyActivistGroups=window.KairosAdapter?.groups(company.activism?.filings||[],company.history,{includePassive:true})||[];
    $('activistTabCount').textContent=(company.activism?.filings||[]).filter(filing=>filing.classification!=='passive').length;
    $('companyName').textContent=company.name;$('companyTicker').textContent=company.ticker;
    $('companyMark').innerHTML=`<img src="https://assets.parqet.com/logos/symbol/${encodeURIComponent(company.ticker)}" alt="" width="49" height="49">`;
    $('companyMark').style.background='transparent';$('companyMark').querySelector('img').addEventListener('error',()=>{$('companyMark').textContent=company.mark;$('companyMark').style.background=company.color;});
    $('companyMeta').textContent=`${company.exchange}${company.sector?" · "+company.sector:""}`;
    $('companyPrice').textContent=money(last.close);$('dailyChange').textContent=change==null?'—':`${signed(change)} aujourd’hui`; $('companyPrice').closest('.quote').querySelector('small').textContent=window.KairosUI.quoteDate(company.raw.price);$('dailyChange').className=change>=0?'positive':'negative';
    $('insiderCount').textContent=company.events.length;$('insiderIntro').textContent=`Les opérations de ${company.name}, avec leurs dates de transaction et de publication. `;
    const observed=company.dimensions.filter(v=>v!==null);$('radarReading').textContent=observed.length?`${labels[company.dimensions.indexOf(Math.max(...observed))]} : le point fort de ce profil`:window.KairosUI.t('Données insuffisantes pour qualifier ce profil','Insufficient data to assess this profile');
    $('scoreDetails').innerHTML=labels.map((label,index)=>`<div><span>${esc(label)}</span><span>${company.dimensions[index]==null?'Indisponible':fmt(company.dimensions[index])+'/100'} · poids ${weights[index]??'—'} %</span><div class="axis-bar"><i style="width:${company.dimensions[index]??0}%"></i></div>${index===6&&company.raw.score?.breakdown?.health?.estimated?`<small class="data-note">${window.KairosUI.t('Estimation sur les critères financiers disponibles','Estimated from available financial criteria')}</small>`:''}</div>`).join('');
    $('insiderRows').innerHTML=[...company.events].sort((a,b)=>b.publicationDate.localeCompare(a.publicationDate)).map(event=>`<tr><td>${dateLabel(event.publicationDate,true)}</td><td>${dateLabel(event.tradeDate,true)}</td><td>${esc(event.insiderName||event.role)}<small class="table-person">${esc(event.role)}</small></td><td><span class="trade-tag ${event.type}">${event.type==='buy'?'Achat':'Vente'}</span></td><td class="number">${fmt(event.amount)} ${esc(event.currency)}</td><td><button class="table-link" data-event-id="${event.id}">Voir sur le cours</button></td></tr>`).join('');
    $('insiderRows').querySelectorAll('[data-event-id]').forEach(button=>button.addEventListener('click',()=>{
      const event=company.events.find(item=>item.id===button.dataset.eventId);
      cancelWheel();if(!eventsInRange().includes(event)){state.range='1Y';state.view=null;}state.event=event.id;state.activistId=null;setTab('overview',true);renderRange();requestAnimationFrame(()=>$('selectedEvent').scrollIntoView({behavior:'auto',block:'nearest'}));
    }));
    renderFunds();renderAbout();renderResearch();renderFollow();renderRange();
    activistView=window.KairosStockViews.activists(company,showActivistOnChart);
    document.title=`${company.name} (${company.ticker}) — Kairos Insider`; window.KairosUI.translate();
  }
  function renderAbout(){window.KairosStockViews.about(state.company);}
  function renderResearch(){if(window.KairosAnalysis)analysisView=window.KairosAnalysis.render($('analysisContent'),state.company);window.KairosStockViews.news(state.company);window.KairosStockViews.calendar(state.company);}
  const fundNames={new:'Nouvelle position',increased:'Renforcement',reduced:'Allègement',exited:'Sortie'};
  const fundClass=fund=>['new','increased'].includes(fund.change)?'positive':'negative';
  const fundChange=fund=>fund.previousShares===0?'Nouvelle position':signed((fund.shares/fund.previousShares-1)*100);
  function renderFunds(){window.KairosStockViews.funds(state.company);}
  function renderRange(){
    if(!state.company.history.length){$('priceChart').textContent=window.KairosUI.t('Historique de cours indisponible.','Price history unavailable.');$('periodChange').textContent='—';return;}
    const history=historyInRange(),events=eventsInRange(),change=(history.at(-1).close/history[0].close-1)*100;
    $('activistChartCount').textContent=activistGroupsInRange(true).flatMap(group=>group.filings).filter(filing=>filing.classification!=='passive').length;
    document.querySelectorAll('[data-range]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.range===state.range)));
    const spansYears=history[0].date.slice(0,4)!==history.at(-1).date.slice(0,4);
    $('periodChange').textContent=signed(change);$('periodChange').className=change>=0?'positive':'negative';$('periodDates').textContent=`${dateLabel(history[0].date,spansYears)} – ${dateLabel(history.at(-1).date,spansYears)}`;
    $('chartPointCount').textContent=`${state.range==='custom'?'Zoom libre · ':''}${history.length} séances`;$('resetZoom').hidden=state.range!=='custom';
    $('eventChoices').innerHTML=events.length?events.map(event=>`<button data-event-id="${event.id}" aria-pressed="${state.event===event.id}"><i class="${event.type==='buy'?'buy-dot':'sell-dot'}"></i>${dateLabel(event.date)} · ${compact(event.amount,event.currency)}</button>`).join(''):'<p class="empty-state">Aucune déclaration dans cette période.</p>';
    $('eventChoices').querySelectorAll('[data-event-id]').forEach(button=>button.addEventListener('click',()=>selectEvent(button.dataset.eventId)));
    const buys=events.filter(event=>event.type==='buy'),sells=events.filter(event=>event.type==='sell'),sum=items=>items.reduce((total,event)=>total+event.amount,0);
    const totals=items=>{const sums=new Map();for(const x of items){if(x.amount===null)continue;sums.set(x.currency,(sums.get(x.currency)||0)+x.amount);}return [...sums].map(([currency,value])=>compact(value,currency)).join(' · ')||(items.length?'—':compact(0));};
    $('insiderSummary').innerHTML=`<div class="summary-numbers"><div><span>Achats déclarés</span><strong class="positive">${totals(buys)}</strong></div><div><span>Ventes déclarées</span><strong class="negative">${totals(sells)}</strong></div></div><p class="summary-line">${T(buys.length+' achat(s) et '+sells.length+' vente(s) publiés sur la période. Sélectionnez une déclaration pour en examiner le contexte.',buys.length+' purchase(s) and '+sells.length+' sale(s) filed in this period. Select a filing to inspect its context.')}</p>`;
    renderSelectedEvent();renderVisuals();
  }
  function selectEvent(id){clearHover();state.event=id;state.activistId=null;renderSelectedEvent();$('eventChoices').querySelectorAll('button').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.eventId===id)));drawChart();}
  function renderSelectedEvent(){
    const event=state.company.events.find(item=>item.id===state.event),host=$('selectedEvent');host.hidden=!event;if(!event)return;
    host.classList.toggle('selling',event.type==='sell');
    const closing=state.company.history.find(point=>point.date===event.date)?.close;
    const observed=closing?(state.company.history.at(-1).close/closing-1)*100:null;
    host.innerHTML=`<div><span class="event-label ${event.type==='buy'?'positive':'negative'}">${event.type==='buy'?'Achat':'Vente'} déclaré${event.type==='buy'?'':'e'} <span>${dateLabel(event.date)}</span></span><strong class="event-money">${compact(event.amount,event.currency)}</strong><h3>${esc(event.role)}</h3></div><p class="event-explanation">${event.type==='buy'?T('Un achat de titres sur le marché, à examiner avec son montant et le rôle du déclarant.','An open-market purchase: consider its size and the reporting person’s role.'):T('Une vente peut répondre à plusieurs motifs. Elle ne suffit pas à conclure que le dirigeant anticipe une baisse.','A sale can have several motives. It does not by itself establish that an insider expects a price decline.')}${observed===null?'':`<br><br>${T('Cours depuis publication :','Price since filing:')} <span class="${observed>=0?'positive':'negative'}">${signed(observed)}</span>. ${T("Évolution observée, sans causalité démontrée.","Observed change, without demonstrated causation.")}`}</p><div class="event-dates"><div><span>Transaction</span><strong>${dateLabel(event.tradeDate,true)}</strong></div><div><span>Publication</span><strong>${dateLabel(event.publicationDate||event.date,true)}</strong></div></div>`;
    if(event.insiderName){const person=document.createElement('small');person.textContent=event.insiderName+'';host.querySelector('h3').after(person);}
  }
  function renderVisuals(){drawChart();if(state.tab==='overview')window.KairosRadar.render($('productRadar'),{values:state.company.dimensions,labels,score:score(),weights});if(state.tab==='funds'&&state.fundSection==='positions')fundView?.redraw();}

  function openActivistDetails(group){
    state.activistId=group.filings[0].id;
    setTab('funds',true);setFundSection('activists');
    requestAnimationFrame(()=>activistView?.select(group.filings.map(filing=>filing.id)));
  }
  function showActivistOnChart(id){
    const group=companyActivistGroups.find(item=>item.filings.some(filing=>filing.id===id));
    if(!group){notify('Cette publication est hors de l’historique du cours disponible.');return;}
    const filing=group.filings.find(item=>item.id===id);
    cancelWheel();clearHover();state.event=null;state.activistId=id;
    $(filing.classification==='passive'?'passiveActivistToggle':'activistToggle').checked=true;
    if(!activistGroupsInRange(true).some(item=>item.key===group.key)){state.range='1Y';state.view=null;}
    setTab('overview',true);renderRange();
    requestAnimationFrame(()=>{const mark=$('priceChart').querySelector(`[data-chart-activist="${group.key}"]`);mark?.focus({preventScroll:true});mark?.scrollIntoView({block:'nearest',behavior:'auto'});if(mark)showActivistTooltip(group.key,mark);});
  }

  function drawChart(){
    if(historyInRange().length<2){$('priceChart').textContent=window.KairosUI.t('Historique de cours insuffisant.','Insufficient price history.');plot=null;return;}
    const host=$('priceChart');if(state.tab!=='overview'||host.clientWidth<100)return;
    const series=historyInRange(),width=host.clientWidth,height=host.clientHeight,pad={left:7,right:70,top:27,bottom:36},innerWidth=width-pad.left-pad.right;
    const withBenchmark=false;
    const benchmark=[];
    const values=[...series.map(point=>point.close),...(withBenchmark?benchmark.map(point=>point.close):[])];
    const minimum=Math.min(...values),maximum=Math.max(...values),spread=Math.max(maximum-minimum,minimum*.002);
    const min=minimum-spread*.17,max=maximum+spread*.2,bottom=height-pad.bottom;
    const x=index=>pad.left+index/(series.length-1)*innerWidth;
    const y=value=>pad.top+(max-value)/(max-min)*(bottom-pad.top);
    const path=rows=>rows.map((point,index)=>`${index?'L':'M'}${x(index).toFixed(1)} ${y(point.close).toFixed(1)}`).join(' ');
    const pricePath=path(series),count=width<420?3:4;
    const ticks=Array.from({length:4},(_,index)=>min+(max-min)*index/3);
    const dateIndexes=Array.from({length:count},(_,index)=>Math.round((series.length-1)*index/(count-1)));
    const visibleEvents=eventsInRange().map(event=>({...event,index:series.findIndex(point=>point.date===event.date)})).filter(event=>event.index>=0);
    host.innerHTML=`<svg class="chart-svg" viewBox="0 0 ${width} ${height}" aria-hidden="true"><defs><linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#598aff" stop-opacity=".27"/><stop offset="1" stop-color="#528dff" stop-opacity="0"/></linearGradient></defs>${ticks.map(value=>`<line class="grid-line" x1="${pad.left}" x2="${width-pad.right}" y1="${y(value)}" y2="${y(value)}"/><text x="${width-pad.right+9}" y="${y(value)+4}">${fmt(value,max-min<8?1:0)}</text>`).join('')}<text x="${width-pad.right+9}" y="13">${esc(state.company.currency)}</text><path d="${pricePath} L${x(series.length-1)} ${bottom} L${pad.left} ${bottom}Z" fill="url(#priceFill)"/>${withBenchmark?`<path d="${path(benchmark)}" fill="none" stroke="#b6accf" stroke-width="1.5" stroke-dasharray="4 4"/>`:''}<path class="price-line" d="${pricePath}"/>${visibleEvents.map(event=>{const cx=x(event.index),cy=y(series[event.index].close),color=event.type==='buy'?'#57ddba':'#fc96a6';return `<g class="event-mark" data-chart-event="${event.id}"><circle cx="${cx}" cy="${cy}" r="18" fill="transparent"/>${event.id===state.event?`<line x1="${cx}" x2="${cx}" y1="${pad.top}" y2="${bottom}" stroke="${color}" stroke-dasharray="3 5" opacity=".5"/><circle cx="${cx}" cy="${cy}" r="13" fill="${color}" opacity=".14"/>`:''}${event.type==='buy'?`<circle class="event-shape" cx="${cx}" cy="${cy}" r="5.5" fill="#122536" stroke="${color}" stroke-width="2"/>`:`<rect class="event-shape" x="${cx-4.5}" y="${cy-4.5}" width="9" height="9" fill="#122536" stroke="${color}" stroke-width="2" transform="rotate(45 ${cx} ${cy})"/>`}</g>`;}).join('')}<circle cx="${x(series.length-1)}" cy="${y(series.at(-1).close)}" r="3" fill="#c4d8ff"/>${dateIndexes.map((index,n)=>`<text x="${x(index)}" y="${height-7}" text-anchor="${n===0?'start':n===count-1?'end':'middle'}">${dateLabel(series[index].date)}</text>`).join('')}<g class="chart-crosshair" pointer-events="none" hidden><line id="hoverLine" y1="${pad.top}" y2="${bottom}" stroke="#8ca5c5" stroke-width="1" stroke-dasharray="3 4"/><line id="hoverPriceLine" x1="${pad.left}" x2="${width-pad.right}" stroke="#8ca5c5" stroke-width="1" stroke-dasharray="3 4"/><circle id="hoverPoint" r="4" fill="#c3d9ff" stroke="#172b45" stroke-width="2"/><g id="hoverPriceBadge" class="chart-axis-badge chart-price-badge"><rect x="0" y="-11" width="${pad.right-6}" height="22" rx="3" fill="#2b4164"/><text id="hoverPriceText" x="${(pad.right-6)/2}" y="3.5" text-anchor="middle" style="fill:#fff;font:10px Inter,sans-serif"></text></g><g id="hoverDateBadge" class="chart-axis-badge chart-date-badge"><rect id="hoverDateBackground" x="0" y="0" width="100" height="24" rx="3" fill="#2b4164"/><text id="hoverDateText" y="15" text-anchor="middle" style="fill:#fff;font:10px Inter,sans-serif"></text></g></g></svg>`;
    host.setAttribute('aria-label',`${state.company.name}, cours du ${dateLabel(series[0].date,true)} au ${dateLabel(series.at(-1).date,true)}, variation ${signed((series.at(-1).close/series[0].close-1)*100)}. Molette pour zoomer, glisser pour déplacer. Touches plus et moins pour zoomer, flèches pour parcourir les dates. Échap ferme le détail.`);
    plot={series,width,height,pad,x,y,min,max,bottom,benchmark,withBenchmark,activistGroups:activistGroupsInRange().map(group=>({...group,index:series.findIndex(point=>point.date===group.date)})).filter(group=>group.index>=0)};
    host.insertAdjacentHTML('beforeend','<div id="operationTooltip" class="operation-tooltip" role="tooltip" hidden></div>');
    drawActivistMarkers();
    host.querySelector('svg').removeAttribute('aria-hidden');
    host.querySelector('svg').setAttribute('role','group');
    host.querySelector('svg').setAttribute('aria-label','Courbe, opérations d’initiés et déclarations de participation');
    host.querySelector('.chart-crosshair').setAttribute('aria-hidden','true');
    host.querySelectorAll('[data-chart-event]').forEach(mark=>{
      const operation=state.company.events.find(item=>item.id===mark.dataset.chartEvent);
      mark.setAttribute('tabindex','0');mark.setAttribute('role','button');
      mark.setAttribute('aria-label',`${operation.type==='buy'?'Achat':'Vente'} de ${compact(operation.amount,operation.currency)}, ${operation.role}, publié le ${dateLabel(operation.publicationDate||operation.date,true)}. Afficher cette opération.`);
      const activate=focus=>{const id=mark.dataset.chartEvent;selectEvent(id);const next=host.querySelector(`[data-chart-event="${id}"]`);if(focus)next?.focus({preventScroll:true});if(next)showOperationTooltip(id,next);};
      mark.addEventListener('pointerenter',()=>showOperationTooltip(mark.dataset.chartEvent,mark));
      mark.addEventListener('pointerleave',hideOperationTooltip);
      mark.addEventListener('focus',()=>showOperationTooltip(mark.dataset.chartEvent,mark));
      mark.addEventListener('blur',hideOperationTooltip);
      mark.addEventListener('click',event=>{event.stopPropagation();activate(false);});
      mark.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();activate(true);}});
    });
    if(state.hover!==null)showHover(Math.min(state.hover,series.length-1),state.hoverPrice);else renderChartReadout(series.length-1,false);
  }
  function starPoints(cx,cy,radius=10){
    return Array.from({length:10},(_,index)=>{const angle=-Math.PI/2+index*Math.PI/5,r=index%2?radius*.44:radius;return `${(cx+Math.cos(angle)*r).toFixed(2)},${(cy+Math.sin(angle)*r).toFixed(2)}`;}).join(' ');
  }
  function drawActivistMarkers(){
    const host=$('priceChart');
    const markup=plot.activistGroups.map(group=>{
      const exactX=plot.x(group.index),cx=Math.max(13,Math.min(plot.width-plot.pad.right-13,exactX)),priceY=plot.y(plot.series[group.index].close),cy=Math.max(plot.pad.top+17,priceY-27);
      const passive=group.filings.every(filing=>filing.classification==='passive'),selected=group.filings.some(filing=>filing.id===state.activistId);
      const color=passive?'#9baccc':group.filings.length>1?'#c9b4f6':activistColors[group.filings[0].direction]||activistColors.unknown;
      return `<g class="activist-mark${selected?' is-selected':''}" data-chart-activist="${esc(group.key)}" tabindex="0" role="button" aria-label="${esc(`${group.filings.length} déclaration${group.filings.length>1?'s':''} de participation sur la séance du ${dateLabel(group.date,true)} : ${group.filings.map(filing=>filing.investor).join(', ')}. Ouvrir les détails.`)}"><circle cx="${cx}" cy="${cy}" r="18" fill="transparent"/><line x1="${exactX}" x2="${cx}" y1="${priceY}" y2="${cy+10}" stroke="${color}" opacity=".55" stroke-dasharray="2 3"/><circle cx="${exactX}" cy="${priceY}" r="2.5" fill="${color}"/><circle class="activist-halo" cx="${cx}" cy="${cy}" r="15" fill="${color}" opacity="${selected?'.2':'.08'}"/><polygon class="activist-star" points="${starPoints(cx,cy)}" fill="${passive?'#14233b':color}" stroke="${passive?color:'#17243b'}" stroke-width="1.5"/>${group.filings.length>1?`<circle cx="${cx+12}" cy="${cy-9}" r="8" fill="#29394f" stroke="${color}"/><text x="${cx+12}" y="${cy-6}" text-anchor="middle" style="font:600 9px Inter,sans-serif;fill:#fff">${group.filings.length}</text>`:''}</g>`;
    }).join('');
    host.querySelector('.chart-crosshair').insertAdjacentHTML('beforebegin',markup);
    host.querySelectorAll('[data-chart-activist]').forEach(mark=>{
      const group=plot.activistGroups.find(item=>item.key===mark.dataset.chartActivist);
      mark.addEventListener('pointerenter',()=>showActivistTooltip(group.key,mark));
      mark.addEventListener('pointerleave',hideOperationTooltip);
      mark.addEventListener('focus',()=>showActivistTooltip(group.key,mark));
      mark.addEventListener('blur',hideOperationTooltip);
      mark.addEventListener('click',event=>{event.stopPropagation();openActivistDetails(group);});
      mark.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();openActivistDetails(group);}});
    });
  }
  function renderChartReadout(index,active){
    if(!plot)return;
    const point=plot.series[index],events=state.company.events.filter(event=>event.date===point.date),change=(point.close/plot.series[0].close-1)*100,host=$('chartReadout');
    host.classList.toggle('is-inspecting',active);
    const cursorNote=active&&state.hoverPrice!==null?` Prix au curseur : ${money(state.hoverPrice)}.`:'';
    host.setAttribute('aria-label',`${active?'Séance du':'Dernière séance de la période :'} ${dateLabel(point.date,true)}. Clôture : ${money(point.close)}.${cursorNote}`);
    host.innerHTML=`<div class="chart-readout-main"><span>Clôture <b>${money(point.close)}</b></span><span>Depuis le début <b class="${change>=0?'positive':'negative'}">${signed(change)}</b></span><span>Volume <b>${point.volume==null?'—':fmt(point.volume/1e6,1)+' M'}</b></span>${plot.withBenchmark?`<span>Indice rebasé <b>${fmt(plot.benchmark[index].close,2)}</b></span>`:''}</div><div class="chart-readout-event ${events.length?'has-event':''}">${events.length?events.map(event=>`<span class="${event.type==='buy'?'positive':'negative'}">${event.type==='buy'?'Achat':'Vente'} publié${event.type==='buy'?'':'e'} · ${compact(event.amount,event.currency)} · ${esc(event.role)}</span>`).join(' / '):'<span aria-hidden="true">&nbsp;</span>'}</div>`;
  }
  function hideOperationTooltip(){
    const tooltip=$('operationTooltip');if(tooltip)tooltip.hidden=true;
    $('priceChart').querySelectorAll('[data-chart-event][aria-describedby],[data-chart-activist][aria-describedby]').forEach(mark=>mark.removeAttribute('aria-describedby'));
  }
  function showOperationTooltip(id,mark){
    if(!plot)return;
    const operation=state.company.events.find(event=>event.id===id),tooltip=$('operationTooltip');
    if(!operation||!tooltip)return;
    const index=plot.series.findIndex(point=>point.date===operation.date);if(index<0)return;
    hideOperationTooltip();
    showHover(index,plot.series[index].close);
    tooltip.innerHTML=`<strong class="operation-tooltip-title ${operation.type==='buy'?'positive':'negative'}">${operation.type==='buy'?'Achat':'Vente'} · ${compact(operation.amount,operation.currency)}</strong><span>${esc(operation.role)}</span><div class="operation-tooltip-dates"><span>Transaction : ${operation.tradeDate?dateLabel(operation.tradeDate,true):"—"}</span><span>Publication : ${dateLabel(operation.publicationDate||operation.date,true)}</span></div>`;
    const width=Math.min(220,plot.width);
    tooltip.style.width=`${width}px`;
    tooltip.style.left=`${Math.max(0,Math.min(plot.width-width,plot.x(index)-width/2))}px`;
    tooltip.hidden=false;mark.setAttribute('aria-describedby','operationTooltip');
  }
  function showActivistTooltip(key,mark){
    const group=plot?.activistGroups.find(item=>item.key===key),tooltip=$('operationTooltip');if(!group||!tooltip)return;
    hideOperationTooltip();showHover(group.index,plot.series[group.index].close);
    tooltip.innerHTML=`<strong class="activist-tooltip-heading">★ ${group.filings.length>1?`${group.filings.length} déclarations de participation`:'Déclaration de participation'}</strong>${group.filings.slice(0,3).map(filing=>`<div class="activist-tooltip-row"><b>${esc(filing.investor)}</b><span>${ownership(filing.ownershipPercent)} · ${esc(activistChange(filing))}</span><small>Publié le ${dateLabel(filing.date,true)} · ${esc(filing.form)}${filing.classification==='passive'?' · Passif':filing.classification==='unclassified'?' · À confirmer':''}</small></div>`).join('')}${group.filings.length>3?`<small>Et ${group.filings.length-3} autre(s) déclaration(s).</small>`:''}<small class="activist-tooltip-hint">Cliquer ou Entrée : ouvrir ${group.filings.length>1?'les déclarations':'le détail'}.</small>`;
    const width=Math.min(276,plot.width-10);tooltip.style.width=`${width}px`;
    tooltip.style.left=`${Math.max(0,Math.min(plot.width-width,plot.x(group.index)-width/2))}px`;
    tooltip.hidden=false;mark.setAttribute('aria-describedby','operationTooltip');
  }
  function showHover(index,cursorPrice=null){
    if(!plot)return;index=Math.max(0,Math.min(plot.series.length-1,index));state.hover=index;
    const point=plot.series[index],cx=plot.x(index),curveY=plot.y(point.close);
    state.hoverPrice=typeof cursorPrice==='number'&&Number.isFinite(cursorPrice)?Math.max(plot.min,Math.min(plot.max,cursorPrice)):point.close;
    const cursorY=plot.y(state.hoverPrice);
    renderChartReadout(index,true);
    const crosshair=$('priceChart').querySelector('.chart-crosshair');crosshair.removeAttribute('hidden');
    $('hoverLine').setAttribute('x1',cx);$('hoverLine').setAttribute('x2',cx);
    $('hoverPriceLine').setAttribute('y1',cursorY);$('hoverPriceLine').setAttribute('y2',cursorY);
    $('hoverPoint').setAttribute('cx',cx);$('hoverPoint').setAttribute('cy',curveY);
    $('hoverPriceBadge').setAttribute('transform',`translate(${plot.width-plot.pad.right+4} ${cursorY})`);
    $('hoverPriceText').textContent=fmt(state.hoverPrice,2);
    const dateText=plot.width<280?new Date(`${point.date}T12:00:00Z`).toLocaleDateString(locale,{day:'2-digit',month:'2-digit',year:'2-digit'}):dateLabel(point.date,true);
    const dateWidth=Math.min(plot.width-plot.pad.left-plot.pad.right,Math.max(84,dateText.length*5.6+16));
    const dateLeft=Math.max(plot.pad.left,Math.min(plot.width-plot.pad.right-dateWidth,cx-dateWidth/2));
    $('hoverDateBadge').setAttribute('transform',`translate(${dateLeft} ${plot.bottom+6})`);
    $('hoverDateBackground').setAttribute('width',dateWidth);
    $('hoverDateText').setAttribute('x',dateWidth/2);$('hoverDateText').textContent=dateText;
  }
  function clearHover(){state.hover=null;state.hoverPrice=null;state.pinned=false;if(plot)renderChartReadout(plot.series.length-1,false);$('priceChart').querySelector('.chart-crosshair')?.setAttribute('hidden','');hideOperationTooltip();}
  const hoverIndex=event=>{const rect=$('priceChart').getBoundingClientRect();return Math.max(0,Math.min(plot.series.length-1,Math.round((event.clientX-rect.left-plot.pad.left)/(plot.width-plot.pad.left-plot.pad.right)*(plot.series.length-1))));};
  const hoverPrice=event=>{const rect=$('priceChart').getBoundingClientRect(),y=Math.max(plot.pad.top,Math.min(plot.bottom,event.clientY-rect.top));return plot.max-(y-plot.pad.top)/(plot.bottom-plot.pad.top)*(plot.max-plot.min);};
  $('priceChart').addEventListener('wheel',event=>{
    if(!plot||state.tab!=='overview'||event.ctrlKey||event.metaKey||!event.deltaY)return;
    event.preventDefault();
    const rect=$('priceChart').getBoundingClientRect();
    wheelRatio=Math.max(0,Math.min(1,(event.clientX-rect.left-plot.pad.left)/(plot.width-plot.pad.left-plot.pad.right)));
    wheelDelta+=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?plot.height:1);
    if(!wheelFrame)wheelFrame=requestAnimationFrame(()=>{const delta=wheelDelta;wheelFrame=0;wheelDelta=0;applyWindow(window.KairosChartRange.zoomWindow(currentWindow(),chartBounds(),delta,wheelRatio));});
  },{passive:false});
  $('priceChart').addEventListener('pointermove',event=>{
    if(!plot)return;
    const marker=event.target.closest('[data-chart-event],[data-chart-activist]');
    if(!marker)hideOperationTooltip();
    if(drag&&event.pointerId===drag.id){
      const distance=event.clientX-drag.x;
      if(Math.abs(distance)>4)drag.moved=true;
      if(drag.moved){$('priceChart').classList.add('is-dragging');const shift=-Math.round(distance*(drag.view.end-drag.view.start)/(plot.width-plot.pad.left-plot.pad.right));applyWindow(window.KairosChartRange.panWindow(drag.view,chartBounds(),shift));return;}
    }
    if(marker){if(marker.dataset.chartActivist)showActivistTooltip(marker.dataset.chartActivist,marker);else showOperationTooltip(marker.dataset.chartEvent,marker);return;}
    if(!state.pinned&&event.pointerType!=='touch')showHover(hoverIndex(event),hoverPrice(event));
  });
  $('priceChart').addEventListener('pointerleave',()=>{hideOperationTooltip();if(!state.pinned&&!drag)clearHover();});
  $('priceChart').addEventListener('pointerdown',event=>{
    if(!plot||event.button!==0||event.target.closest('[data-chart-event],[data-chart-activist]'))return;
    hideOperationTooltip();
    if(event.pointerType==='touch'){state.pinned=true;showHover(hoverIndex(event),hoverPrice(event));return;}
    drag={id:event.pointerId,x:event.clientX,view:currentWindow(),moved:false};$('priceChart').setPointerCapture(event.pointerId);
  });
  $('priceChart').addEventListener('pointerup',event=>{if(!drag||event.pointerId!==drag.id)return;const moved=drag.moved;drag=null;$('priceChart').classList.remove('is-dragging');if($('priceChart').hasPointerCapture(event.pointerId))$('priceChart').releasePointerCapture(event.pointerId);if(!moved){state.pinned=!state.pinned;showHover(hoverIndex(event),hoverPrice(event));}});
  $('priceChart').addEventListener('pointercancel',()=>{drag=null;$('priceChart').classList.remove('is-dragging');clearHover();});
  $('priceChart').addEventListener('keydown',event=>{if(!plot)return;
    if(['+','=','-','_'].includes(event.key)){event.preventDefault();cancelWheel();applyWindow(window.KairosChartRange.zoomWindow(currentWindow(),chartBounds(),['+','='].includes(event.key)?-100:100,.5));return;}
    let index=state.hover??plot.series.length-1;if(event.key==='ArrowLeft')index=Math.max(0,index-1);else if(event.key==='ArrowRight')index=Math.min(plot.series.length-1,index+1);else if(event.key==='Home')index=0;else if(event.key==='End')index=plot.series.length-1;else if(event.key==='Escape'){clearHover();return;}else return;event.preventDefault();state.pinned=true;showHover(index);
  });
  new ResizeObserver(()=>requestAnimationFrame(renderVisuals)).observe($('priceChart'));
  new ResizeObserver(()=>{if(state.tab==='overview')window.KairosRadar.render($('productRadar'),{values:state.company.dimensions,labels,score:score(),weights});}).observe($('productRadar'));

  renderCompany();
  const initialView=new URLSearchParams(location.search);
  if(['overview','insiders','funds','analysis','news','calendar','company'].includes(initialView.get('tab')))setTab(initialView.get('tab'));
  if(initialView.get('view')==='activists'){setTab('funds');setFundSection('activists');}
  if(initialView.get('activist')&&state.company.activism?.filings.some(filing=>filing.id===initialView.get('activist'))){
    setTab('funds');setFundSection('activists');requestAnimationFrame(()=>activistView?.select(initialView.get('activist')));
  }
  const linkedEvent=state.company.events.find(event=>event.id===initialView.get('event'));
  if(linkedEvent){
    if(!eventsInRange().some(event=>event.id===linkedEvent.id)){state.range='1Y';state.view=null;}
    setTab('overview');state.event=linkedEvent.id;renderRange();
  }
  $('followButton').addEventListener('click',()=>window.KairosUI.share(state.company.ticker));
  window.KairosStockRefresh=()=>{companyActivistGroups=window.KairosAdapter.groups(state.company.activism.filings,state.company.history,{includePassive:true});$('activistTabCount').textContent=state.company.activism.filings.length;activistView=window.KairosStockViews.activists(state.company,showActivistOnChart);renderRange();};
})();
