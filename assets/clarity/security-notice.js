/* A listing change is contextual information; the selected security stays intact. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else{
    root.KairosSecurityNotice=api;
    const company=root.KairosLive?.companies?.[0];
    if(root.document&&company)api.mount(root.document,company,root.KairosUI);
  }
})(typeof window==='object'?window:globalThis,()=>{
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safeUrl=value=>{try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)?url.href:null;}catch{return null;}};
  function markup(company,{lang='fr',stockUrl}={}){
    const data=company?.raw||company,notice=data?.securityNotice;
    if(notice?.type!=='successor'||typeof notice.symbol!=='string'||!/^[A-Z0-9][A-Z0-9.\-]{0,11}$/.test(notice.symbol))return '';
    const t=(fr,en)=>lang==='en'?en:fr;
    const destination=typeof stockUrl==='function'?stockUrl(notice.symbol):'dashboard.html?'+new URLSearchParams({lang,symbol:notice.symbol});
    const source=safeUrl(notice.sourceUrl);
    const day=notice.effectiveDate,parsed=typeof day==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(day)?new Date(day+'T12:00:00Z'):null;
    const effective=parsed&&Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===day?parsed.toLocaleDateString(lang==='en'?'en-US':'fr-FR',{day:'numeric',month:'long',year:'numeric'}):null;
    return `<aside id="companySecurityNotice" class="data-note" role="note" aria-label="${t('Information sur la cotation','Listing information')}"><strong>${t('Changement de symbole','Symbol change')}</strong> · <a href="${escape(destination)}">${escape(notice.symbol)}</a>${notice.name?' · '+escape(notice.name):''}${effective?' · '+t('À compter du ','Effective ')+escape(effective):''}. ${t('Les données de l’ancien symbole peuvent être incomplètes.','Data for the former symbol may be incomplete.')}${source?` <a href="${escape(source)}" target="_blank" rel="noopener noreferrer">${t('Déclaration source','Source filing')} ↗</a>`:''}</aside>`;
  }
  function mount(document,company,options){
    document.getElementById('companySecurityNotice')?.remove();
    const tabs=document.querySelector('#companyMain .company-tabs'),html=markup(company,options);
    if(!tabs||!html)return false;
    tabs.insertAdjacentHTML('beforebegin',html);
    return true;
  }
  return {markup,mount};
});
