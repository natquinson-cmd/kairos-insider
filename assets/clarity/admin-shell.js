/* Presentation only: keep the existing authenticated admin controllers and DOM. */
(()=>{'use strict';
const root=document.documentElement;
const language=()=>window.KairosI18n?.getLang?.()==='en'?'en':'fr';
function refresh(){
 const active=location.hash.split(/[?&]/)[0]==='#admin';
 root.classList.toggle('clarity-admin',active);
 if(!active)return;
 const lang=language(),t=(fr,en)=>lang==='en'?en:fr;
 document.title=t('Administration — Kairos Insider','Administration — Kairos Insider');
 const sidebar=document.getElementById('sidebar');if(!sidebar)return;
 let shell=document.getElementById('clarityAdminNavigation');
 if(!shell){shell=document.createElement('div');shell.id='clarityAdminNavigation';sidebar.prepend(shell);}
 const link=(href,icon,label,current=false)=>`<a class="ca-nav-item${current?' is-active':''}" href="${href}${href.includes('?')?'&':'?'}lang=${lang}"${current?' aria-current="page"':''}><span aria-hidden="true">${icon}</span>${label}</a>`;
 shell.innerHTML=`<a class="ca-brand" href="dashboard.html?lang=${lang}" aria-label="Kairos"><img src="assets/kairos-inflexion.svg" alt="" width="44" height="44"><span>kairos<small>INSIDER</small></span></a><div class="ca-navigation" role="navigation" aria-label="${t('Navigation principale','Main navigation')}"><p>${t('Votre recherche','Your research')}</p>${link('dashboard.html','⌕',t('Fiche action','Stock analysis'))}${link('watchlist.html','☆',t('Ma watchlist','My watchlist'))}<p>${t('Explorer le marché','Explore the market')}</p>${link('insiders.html','◎',t('Initiés','Insiders'))}${link('insiders.html?screen=activists','★',t('Activistes','Activists'))}${link('insiders.html?screen=funds','▥','Hedge funds')}${link('account.html','○',t('Mon compte','My account'))}${link('admin.html','⚙',t('Administration','Administration'),true)}</div><div class="ca-sidebar-foot">Kairos Insider<small>${t('Votre espace de recherche','Your research workspace')}</small></div>`;
 const header=document.querySelector('body > nav .nav-container');
 if(header&&!document.getElementById('clarityAdminContext')){const label=document.createElement('span');label.id='clarityAdminContext';label.textContent='Kairos Insider';header.prepend(label);}
 if(header&&!header.querySelector('.persistent-search')&&window.KairosCompactSearch){
  header.insertAdjacentHTML('afterbegin',window.KairosCompactSearch.stockMarkup(lang));
  const input=header.querySelector('#companySearch'),wrap=header.querySelector('#searchWrap'),popup=wrap.querySelector('#searchPopup'),list=wrap.querySelector('#searchResults'),empty=wrap.querySelector('#searchEmpty');
  let request=0,timer;
  input.addEventListener('input',()=>{clearTimeout(timer);const current=++request,query=input.value.trim();popup.hidden=true;if(!query)return;timer=setTimeout(async()=>{
   try{const data=await apiFetch('/api/search-ticker?q='+encodeURIComponent(query));if(current!==request||wrap.hidden)return;list.replaceChildren();
    for(const row of (data.results||[]).slice(0,8)){const item=document.createElement('li'),link=document.createElement('a'),name=document.createElement('span'),quote=document.createElement('small');name.textContent=(row.name||row.symbol)+' · '+row.symbol;quote.textContent=row.quote?.price==null?'':new Intl.NumberFormat(lang,{maximumFractionDigits:2}).format(row.quote.price)+' '+(row.quote.currency||'');link.href='dashboard.html?'+new URLSearchParams({lang,symbol:row.symbol});link.append(name,quote);item.append(link);list.append(item);}
    empty.textContent=t('Aucun résultat.','No results.');empty.hidden=!!list.children.length;popup.hidden=false;input.setAttribute('aria-expanded','true');
   }catch{if(current!==request)return;list.replaceChildren();empty.hidden=false;empty.textContent=t('Recherche indisponible. Réessayez.','Search unavailable. Please retry.');popup.hidden=false;}
  },250);});
  input.addEventListener('keydown',event=>{if(event.key==='ArrowDown'){event.preventDefault();list.querySelector('a')?.focus();}if(event.key==='Enter'&&input.value.trim()){event.preventDefault();location.href='dashboard.html?'+new URLSearchParams({lang,search:input.value.trim()});}});
  window.KairosCompactSearch.mount({header,wrap,input,lang});
 }
 const admin=document.getElementById('section-admin');
 const heading=admin?.firstElementChild?.querySelector('h2');
 if(heading)heading.textContent=t('Administration.','Administration.');
 const intro=admin?.querySelector('.section-desc');
 if(intro){intro.removeAttribute('data-i18n');intro.textContent=t('Le suivi du site, des données et des accès.','Monitor your site, data and access.');}
 const kpis=document.getElementById('adKpiUsers')?.parentElement?.parentElement;
 kpis?.classList.add('ca-kpis');
 for(const panel of admin?.querySelectorAll('.core-panel')||[])for(const card of panel.children){if(card!==kpis&&card.tagName==='DIV'&&!card.classList.contains('core-admin-actions'))card.classList.add('ca-panel-card');}
 const profile=document.getElementById('navProfileBtn');
 if(profile){profile.classList.add('ca-profile-button');profile.setAttribute('aria-label',t('Mon compte','My account'));}
}
document.addEventListener('click',event=>{
 if(!root.classList.contains('clarity-admin'))return;
 if(event.target.closest('#navProfileBtn')){event.preventDefault();event.stopImmediatePropagation();location.href='account.html?lang='+language();}
},true);
window.addEventListener('hashchange',refresh);
window.addEventListener('kairos:langchange',()=>{if(root.classList.contains('clarity-admin')){const url=new URL(location.href);url.searchParams.set('lang',language());location.replace(url.href);}else refresh();});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',refresh);else refresh();
})();
