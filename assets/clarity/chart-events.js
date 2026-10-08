(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.KairosChartEvents=factory();
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const numeric=value=>typeof value==='number'&&Number.isFinite(value);
  const key=event=>JSON.stringify([event.publicationDate||null,event.type]);

  // Chart sessions can differ from filing dates. Keep every original operation ID.
  function group(events){
    const groups=new Map();
    for(const event of events){
      if(!['buy','sell'].includes(event.type))continue;
      const id=key(event);
      if(!groups.has(id))groups.set(id,{key:id,publicationDate:event.publicationDate||null,type:event.type,events:[],totals:[],missingAmounts:0});
      const item=groups.get(id);item.events.push(event);
      if(!numeric(event.amount)){item.missingAmounts++;continue;}
      const currency=event.currency||null;
      let total=item.totals.find(value=>value.currency===currency);
      if(!total){total={currency,amount:0};item.totals.push(total);}
      total.amount+=event.amount;
    }
    return [...groups.values()].sort((a,b)=>(b.publicationDate||'').localeCompare(a.publicationDate||'')||a.type.localeCompare(b.type));
  }
  function selected(groups,eventId){return groups.find(item=>item.events.some(event=>event.id===eventId))||null;}
  function wording(lang){
    const en=lang==='en',locale=en?'en-US':'fr-FR',t=(fr,enText)=>en?enText:fr;
    const number=(value,compact=false)=>numeric(value)?value.toLocaleString(locale,{maximumFractionDigits:compact?1:2,...(compact?{notation:'compact'}:{})}):'—';
    const date=(value,year=false)=>value?new Date(value+'T12:00:00Z').toLocaleDateString(locale,{day:'numeric',month:'short',...(year?{year:'numeric'}:{})}):t('Date indisponible','Date unavailable');
    const count=item=>`${item.events.length} ${item.type==='buy'?t(item.events.length===1?'achat':'achats',item.events.length===1?'purchase':'purchases'):t(item.events.length===1?'vente':'ventes',item.events.length===1?'sale':'sales')}`;
    const totals=item=>item.totals.map(total=>`${number(total.amount,true)} ${total.currency||t('devise non précisée','currency unspecified')}`).join(' + ')||t('Montant indisponible','Amount unavailable');
    return {t,number,date,count,totals};
  }
  function choices(groups,eventId,lang='fr'){
    const {t,date,count,totals}=wording(lang),active=selected(groups,eventId);
    if(!groups.length)return `<p class="empty-state">${t('Aucun achat retenu ni vente sur cette période.','No qualifying purchases or sales in this period.')}</p>`;
    return `<p class="event-groups-caption">${t('Opérations par date de publication','Transactions by filing date')} <span>· ${t('Cliquer pour le détail','Click for details')}</span></p>`+groups.map(item=>{
      const pressed=item===active,partial=item.missingAmounts>0&&item.totals.length>0;
      return `<button type="button" class="event-group-button ${item.type}" data-event-id="${esc(item.events[0].id)}" aria-pressed="${pressed}" aria-expanded="${pressed}" aria-controls="selectedEvent"><span class="event-group-label"><i aria-hidden="true" class="${item.type==='buy'?'buy-dot':'sell-dot'}"></i><time>${esc(date(item.publicationDate))}</time> · ${count(item)}</span><strong>${esc(totals(item))}${partial?` <small>${t('(partiel)','(partial)')}</small>`:''}</strong></button>`;
    }).join('');
  }
  function safeSource(value){try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)?url.href:null;}catch{return null;}}
  function details(item,eventId,lang='fr'){
    if(!item)return '';
    const {t,number,date,count,totals}=wording(lang);
    const people=new Set(item.events.filter(event=>event.insiderName).map(event=>event.insiderId||event.insiderName.trim().toLowerCase()));
    const peopleLabel=people.size?` · ${people.size} ${t(people.size===1?'déclarant identifié':'déclarants identifiés',people.size===1?'identified reporting person':'identified reporting people')}`:'';
    const missing=item.missingAmounts?`<p class="event-group-note">${t(`${item.missingAmounts} montant(s) non renseigné(s) : ${item.totals.length?'le total est partiel.':'aucun total disponible.'}`,`${item.missingAmounts} amount(s) unavailable: ${item.totals.length?'the total is partial.':'no total available.'}`)}</p>`:'';
    return `<header class="event-group-header"><div><h3 id="eventGroupTitle" tabindex="-1">${count(item)}</h3><p>${t('Publication du','Filed on')} ${esc(date(item.publicationDate,true))}${peopleLabel}</p></div><div class="event-group-total"><span>${t('Montant cumulé','Total amount')}</span><strong class="${item.type==='buy'?'positive':'negative'}">${esc(totals(item))}</strong></div><button type="button" class="text-button event-group-close" data-close-events>${t('Fermer','Close')} ×</button></header>${missing}<p class="event-group-note">${item.type==='buy'?t('Une même publication peut réunir plusieurs opérations. Consultez les dates de transaction et les sources pour en comprendre le contexte.','One filing date can cover several transactions. Check execution dates and sources to understand the context.'):t('Une vente peut répondre à plusieurs motifs ; elle ne suffit pas à anticiper une baisse du cours.','A sale can have several motives; it does not by itself predict a price decline.')}</p><div class="table-wrap event-group-table" tabindex="0" role="region" aria-label="${t('Détail de toutes les opérations du groupe','All transactions in this group')}"><table><thead><tr><th scope="col">${t('Déclarant','Reporting person')}</th><th scope="col" class="number">${t('Montant','Amount')}</th><th scope="col" class="number">${t('Titres','Shares')}</th><th scope="col">${t('Transaction','Executed')}</th><th scope="col">Source</th></tr></thead><tbody>${item.events.map(event=>{
      const name=event.insiderName||event.role||'—',source=safeSource(event.sourceUrl),amount=numeric(event.amount)?`${number(event.amount)} ${event.currency||'—'}`:'—';
      return `<tr data-operation-id="${esc(event.id)}"${event.id===eventId?' class="is-selected"':''}><td><strong>${esc(name)}</strong>${event.role&&event.role!==name?`<small>${esc(event.role)}</small>`:''}${event.planned?`<small>${t('Programmée · 10b5-1','Planned · 10b5-1')}</small>`:''}</td><td class="number"><span title="${esc(numeric(event.amount)?number(event.amount)+' '+(event.currency||''):t('Montant indisponible','Amount unavailable'))}">${esc(amount)}</span></td><td class="number">${number(event.shares)}</td><td>${esc(date(event.tradeDate,true))}</td><td>${source?`<a class="table-link" href="${esc(source)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(t('Source de l’opération de ','Source for ')+name)}">${t('Déclaration','Filing')} ↗</a>`:`<span class="muted">${t('Indisponible','Unavailable')}</span>`}</td></tr>`;
    }).join('')}</tbody></table></div>`;
  }
  return {group,selected,choices,details,wording};
});
