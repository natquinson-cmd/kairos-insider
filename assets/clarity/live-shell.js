import {initializeApp} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {getAuth,onAuthStateChanged,signInWithEmailAndPassword,signInWithPopup,GoogleAuthProvider,signOut,updateProfile} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
const app=initializeApp({apiKey:'AIzaSyCp_29t_QiFGRugmsGdBEochPVTM-2Xyyw',authDomain:'kairos-insider.firebaseapp.com',projectId:'kairos-insider',databaseURL:'https://kairos-insider-default-rtdb.europe-west1.firebasedatabase.app'});
const auth=getAuth(app),base='https://kairos-insider-api.natquinson.workers.dev',params=new URLSearchParams(location.search);
const lang=params.get('lang')==='en'?'en':'fr',t=(fr,en)=>lang==='en'?en:fr;
const requestedSymbol=params.get('symbol')||new URLSearchParams(location.hash.slice(1).split('?')[1]||'').get('t');
const researchHome=!document.body.dataset.screen&&!requestedSymbol;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let user=null,readyResolve;const ready=new Promise(resolve=>readyResolve=resolve);
const stockUrl=(symbol,extra={})=>'dashboard.html?'+new URLSearchParams({lang,symbol,...extra});
const openStock=(symbol,extra)=>{if(/^[A-Z0-9.^=-]{1,20}$/i.test(symbol))location.href=stockUrl(symbol.toUpperCase(),extra);};
async function api(path,options={}){
  await ready;const headers={};if(user)headers.Authorization='Bearer '+await user.getIdToken();
  const response=await fetch(base+path,{...options,headers:{...(options.headers||{}),...headers}});const data=await response.json();
  if(!response.ok){const quota=String(data.code||'').includes('QUOTA');const error=new Error(quota?t('Votre quota gratuit du jour est atteint. Connectez-vous ou consultez votre abonnement.','Your daily free quota has been reached. Sign in or review your subscription.'):response.status===401?t('Connectez-vous pour accéder à cet écran.','Sign in to access this screen.'):response.status===403?t('Cette rubrique nécessite un abonnement Pro.','This section requires a Pro subscription.'):response.status===429?t('Votre quota de consultations est atteint.','Your analysis quota has been reached.'):t('Les données sont momentanément indisponibles. Réessayez.','Data is temporarily unavailable. Please retry.'));error.status=quota&&!user?401:response.status;throw error;}
  if(data.error)throw new Error(t('Données indisponibles pour cette valeur.','Data unavailable for this security.'));return data;
}
const loadScript=src=>new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=src;s.onload=resolve;s.onerror=reject;document.head.append(s);});
function showError(host,error){host.hidden=false;host.innerHTML=`<div class="live-empty"><h2>${esc(error.message)}</h2><p>${t('Les données absentes ne sont pas remplacées par des exemples.','Missing data is never replaced with examples.')}</p><button class="secondary" data-retry>${t('Réessayer','Retry')}</button> ${error.status===401?`<button class="secondary" data-login>${t('Se connecter','Sign in')}</button>`:error.status===403?`<a class="secondary" href="index.html?lang=${lang}#pricing">${t('Voir Pro','View Pro')}</a>`:''}</div>`;host.querySelector('[data-retry]').onclick=()=>location.reload();host.querySelector('[data-login]')?.addEventListener('click',login);}
function login(){
  document.getElementById('accountDialog')?.remove();const dialog=document.createElement('dialog');dialog.id='accountDialog';dialog.className='live-dialog';
  dialog.innerHTML=`<button class="dialog-close" aria-label="${t('Fermer','Close')}">×</button><h2>${t('Votre espace Kairos','Your Kairos workspace')}</h2><form><label>Email<input name="email" type="email" autocomplete="email" required></label><label>${t('Mot de passe','Password')}<input name="password" type="password" autocomplete="current-password" required></label><p role="alert"></p><button class="primary">${t('Se connecter','Sign in')}</button></form><button class="secondary" data-google>Google</button><p><a href="admin-workspace.html?action=login&lang=${lang}">${t('Créer un compte ou réinitialiser le mot de passe','Create an account or reset your password')}</a></p>`;
  document.body.append(dialog);dialog.querySelector('.dialog-close').onclick=()=>dialog.close();dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});
  const fail=()=>dialog.querySelector('[role=alert]').textContent=t('Connexion impossible. Vérifiez vos identifiants ou réessayez.','Sign-in failed. Check your credentials or try again.');
  dialog.querySelector('form').onsubmit=async e=>{e.preventDefault();try{await signInWithEmailAndPassword(auth,e.target.email.value,e.target.password.value);location.reload();}catch{fail();}};
  dialog.querySelector('[data-google]').onclick=async()=>{try{await signInWithPopup(auth,new GoogleAuthProvider());location.reload();}catch{fail();}};dialog.showModal();
}
function share(symbol){
  const links=window.KairosSharing.stockLinks(symbol,lang);document.getElementById('shareDialog')?.remove();const dialog=document.createElement('dialog');dialog.id='shareDialog';dialog.className='live-dialog share-dialog';
  dialog.innerHTML=`<button class="dialog-close" aria-label="${t('Fermer','Close')}">×</button><h2>${t('Partager la fiche','Share stock analysis')} ${esc(symbol)}</h2><img src="${esc(links.image)}" alt="${esc(symbol)} — Kairos" width="1200" height="630"><input aria-label="${t('Lien public','Public link')}" readonly value="${esc(links.publicUrl||links.url)}"><div class="share-actions"><button class="primary">${t('Copier le lien','Copy link')}</button><a class="secondary" target="_blank" rel="noopener noreferrer" href="${esc(links.x)}">${t('Partager sur X','Share on X')}</a></div><p role="status"></p>`;
  document.body.append(dialog);dialog.querySelector('.dialog-close').onclick=()=>dialog.close();dialog.querySelector('.primary').onclick=async()=>{try{await navigator.clipboard.writeText(links.publicUrl||links.url);dialog.querySelector('[role=status]').textContent=t('Lien copié.','Link copied.');}catch{dialog.querySelector('input').select();}};dialog.showModal();
}
async function search(query){if(query.length<1)return [];try{return ((await api('/api/search-ticker?q='+encodeURIComponent(query))).results||[]).map(r=>({...r,ticker:r.symbol}));}catch{return [];}}
function sparkline(points){
  const values=(points||[]).filter(v=>typeof v==='number'&&Number.isFinite(v));if(values.length<2)return '';
  const min=Math.min(...values),max=Math.max(...values),span=Math.max(max-min,.01),path=values.map((v,i)=>(i?'L':'M')+(i/(values.length-1)*90).toFixed(1)+' '+(28-(v-min)/span*24).toFixed(1)).join(' ');
  return '<svg viewBox="0 0 92 32" aria-label="'+t('Cours sur un mois','One-month price chart')+'"><path d="'+path+'" fill="none" stroke="'+(values.at(-1)>=values[0]?'#57ddba':'#fc96a6')+'" stroke-width="1.8"/></svg><small>'+t('1 mois','1 month')+'</small>';
}
function renderSearch(rows,onChoose){
  const popup=document.getElementById('searchPopup'),list=document.getElementById('searchResults');popup.hidden=false;document.getElementById('companySearch').setAttribute('aria-expanded','true');
  list.innerHTML=rows.map(r=>{r.ticker=r.symbol;const q=r.quote||{};return `<li id="result-${esc(r.symbol)}" role="option" aria-selected="false" data-symbol="${esc(r.symbol)}"><img class="result-logo" src="https://assets.parqet.com/logos/symbol/${encodeURIComponent(r.symbol)}" alt=""><span class="result-name"><strong>${esc(r.name||r.symbol)}</strong><small>${esc(r.symbol)} · ${esc(r.exchangeFull||r.exchange||'')}</small></span><span class="result-trend">${sparkline(q.sparkline)}</span><span class="result-quote"><strong>${format(q.price)} ${esc(q.currency||'')}</strong><small class="${q.changePercent>=0?'positive':'negative'}">${q.changePercent==null?'':format(q.changePercent)+' %'}</small></span></li>`;}).join('');
  list.querySelectorAll('[data-symbol]').forEach(el=>{el.onmousedown=e=>e.preventDefault();el.onclick=()=>onChoose(el.dataset.symbol);el.querySelector('img').onerror=e=>e.target.style.visibility='hidden';});document.getElementById('searchEmpty').hidden=rows.length>0;
}
function initializeStockSearch(){
  const input=document.getElementById('companySearch');if(!input)return;
  const popup=document.getElementById('searchPopup'),list=document.getElementById('searchResults'),wrap=document.getElementById('searchWrap');
  let matches=[],index=0,timer,request=0;
  function close(){request++;popup.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');}
  function select(){list.querySelectorAll('[role=option]').forEach((option,i)=>option.setAttribute('aria-selected',String(i===index)));if(matches.length)input.setAttribute('aria-activedescendant','result-'+matches[index].ticker);else input.removeAttribute('aria-activedescendant');}
  async function run(){const query=input.value.trim(),current=++request;const rows=await search(query);if(current!==request||input.value.trim()!==query)return;matches=rows;index=0;renderSearch(matches,openStock);select();}
  const queue=()=>{clearTimeout(timer);timer=setTimeout(run,250);};input.addEventListener('focus',queue);input.addEventListener('input',queue);
  input.addEventListener('keydown',event=>{
    if(event.key==='Escape'){clearTimeout(timer);close();return;}
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();if(popup.hidden)run();else if(matches.length){index=(index+(event.key==='ArrowDown'?1:-1)+matches.length)%matches.length;select();}}
    if(event.key==='Enter'&&!popup.hidden&&matches.length){event.preventDefault();openStock(matches[index].ticker);}
  });
  document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();input.focus();input.select();}});
  document.addEventListener('pointerdown',event=>{if(!wrap.contains(event.target)){clearTimeout(timer);close();}});
  wrap.addEventListener('focusout',()=>setTimeout(()=>{if(!wrap.contains(document.activeElement)){clearTimeout(timer);close();}},0));
  if(params.get('search')){input.value=params.get('search');input.focus();queue();}
}
const format=(value,digits=2)=>window.KairosAdapter.number(value)==null?'—':Number(value).toLocaleString(lang==='en'?'en-US':'fr-FR',{maximumFractionDigits:digits});
const quoteDate=p=>p?.regularMarketTime?t('Cours du ','Price as of ')+new Date(p.regularMarketTime*1000).toLocaleString(lang==='en'?'en-US':'fr-FR'):t('Dernier cours disponible','Latest available price');
async function getAccount(){await ready;return user?{email:user.email,displayName:user.displayName,emailVerified:user.emailVerified,createdAt:user.metadata?.creationTime,lastSignInAt:user.metadata?.lastSignInTime}:null;}
async function updateDisplayName(name){await ready;const value=String(name||'').trim();if(!user||!value||value.length>100)throw new Error(t('Nom invalide.','Invalid name.'));await updateProfile(user,{displayName:value});}
let watchClientPromise;
let researchHistoryPromise;
async function researchHistory(){
 await ready;
 if(!researchHistoryPromise)researchHistoryPromise=(async()=>{await loadScript('assets/clarity/research-history.js?v=research1');let storage;try{storage=window.localStorage;}catch{storage={getItem(){return null;},setItem(){},removeItem(){}};}return window.KairosResearchHistory.create(storage,user?.uid||'guest');})();
 return researchHistoryPromise;
}
async function watchlist(){
  await ready;if(!user)throw new Error(t('Connectez-vous pour retrouver votre watchlist.','Sign in to access your watchlist.'));
  if(!watchClientPromise)watchClientPromise=(async()=>{
    await loadScript('assets/clarity/watchlist-client.js?v=live7');
    async function database(){const sdk=await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js');return {sdk,ref:sdk.ref(sdk.getDatabase(app),`users/${user.uid}/watchlist`)};}
    return window.KairosWatchlistClient.create({api,readLegacy:async()=>{const d=await database();const snapshot=await d.sdk.get(d.ref);return snapshot.exists()?snapshot.val():null;},mirror:async payload=>{const {sendConfirmation,...record}=payload;const d=await database();await d.sdk.update(d.ref,{...record,updatedAt:Date.now()});}});
  })().catch(error=>{watchClientPromise=null;throw error;});
  return watchClientPromise;
}
async function mountWatchButton(symbol){
  const shareButton=document.getElementById('followButton');if(!shareButton)return;
  const button=document.createElement('button');button.className='secondary watch-stock-button';button.id='watchStockButton';button.type='button';button.textContent=t('☆ Suivre','☆ Follow');button.disabled=true;button.setAttribute('aria-pressed','false');shareButton.before(button);
  const status=document.createElement('p');status.className='watch-stock-status';status.setAttribute('role','status');status.hidden=true;shareButton.closest('.company-header').after(status);
  const message=text=>{status.hidden=false;status.textContent=text;};
  if(!user){button.disabled=false;button.onclick=login;return;}
  let client,saved,access;
  const refresh=()=>{const followed=saved?.tickers.includes(symbol);button.textContent=followed?t('★ Suivie','★ Following'):t('☆ Suivre','☆ Follow');button.setAttribute('aria-pressed',String(!!followed));button.setAttribute('aria-label',followed?t('Retirer '+symbol+' de ma watchlist','Remove '+symbol+' from my watchlist'):t('Suivre '+symbol,'Follow '+symbol));};
  async function initialize(){try{button.disabled=true;access=await api('/stripe/status');if(typeof access.entitled!=='boolean')throw Error(t('Accès indisponible. Réessayez.','Access unavailable. Please retry.'));client=await watchlist();saved=await client.load();refresh();button.disabled=false;}catch(error){message(error.message);button.disabled=false;button.textContent=t('Réessayer la watchlist','Retry watchlist');client=null;}}
  button.onclick=async()=>{if(!client){await initialize();return;}if(!access.entitled){location.href='watchlist.html?lang='+lang;return;}button.disabled=true;try{const wasFollowed=saved.tickers.includes(symbol);saved=await(wasFollowed?client.remove(symbol):client.add(symbol));refresh();message(wasFollowed?t(symbol+' retirée de votre watchlist.',symbol+' removed from your watchlist.'):t(symbol+' ajoutée. Réglez vos canaux dans Ma watchlist pour recevoir les alertes.',symbol+' added. Set up your channels in My watchlist to receive alerts.'));const a=document.createElement('a');a.href='watchlist.html?lang='+lang;a.textContent=t(' Ouvrir ma watchlist →',' Open my watchlist →');status.append(a);}catch(error){message(error.message);}finally{button.disabled=false;}};
  await initialize();
}
window.KairosUI={api,lang,t,esc,format,openStock,stockUrl,share,search,renderSearch,showError,quoteDate,getAccount,updateDisplayName,login,watchlist,researchHistory,translate(){window.KairosLiveTranslate?.();}};
document.documentElement.lang=lang;
document.querySelectorAll('a[href^="insiders.html"],a[href="dashboard.html"],a[href="account.html"],a[href="watchlist.html"]').forEach(a=>{const u=new URL(a.href);u.searchParams.set('lang',lang);a.href=u.pathname.split('/').at(-1)+u.search;});
for(const nav of document.querySelectorAll('.sidebar nav,.live-mobile-nav')){if(!nav.querySelector('a[href^="watchlist.html"]')){const link=document.createElement('a');link.href='watchlist.html?lang='+lang;link.textContent=t('☆ Ma watchlist','☆ My watchlist');link.className=nav.classList.contains('live-mobile-nav')?'':'nav-item';if(nav.classList.contains('live-mobile-nav'))nav.append(link);else nav.insertBefore(link,nav.querySelector('.nav-item')?.nextSibling||null);}}
const header=document.querySelector('.topbar'),controls=document.createElement('div');controls.className='live-account';controls.innerHTML=`<button class="text-button" data-lang>${lang==='fr'?'EN':'FR'}</button><button class="secondary" data-account>${t('Se connecter','Sign in')}</button>`;header.append(controls);
controls.querySelector('[data-lang]').onclick=()=>{const u=new URL(location.href);u.searchParams.set('lang',lang==='fr'?'en':'fr');location.href=u.href;};controls.querySelector('[data-account]').onclick=login;
document.querySelector('.sidebar-foot').innerHTML=`<span class="avatar">K</span><div>Kairos Insider<small>${t('Votre espace de recherche','Your research workspace')}</small></div>`;
onAuthStateChanged(auth,async next=>{const previous=user;user=next;readyResolve();if(previous&&previous.uid!==next?.uid){location.reload();return;}controls.querySelector('[data-account]').textContent=next?t('Mon compte','My account'):t('Se connecter','Sign in');
  if(next){controls.querySelector('[data-account]').onclick=()=>{document.getElementById('accountDialog')?.remove();const d=document.createElement('dialog');d.id='accountDialog';d.className='live-dialog live-account-dialog';d.innerHTML=`<h2>${t('Mon compte','My account')}</h2><p class="account-dialog-email">${esc(next.email)}</p><div class="account-dialog-actions"><a class="secondary" href="account.html?lang=${lang}">${t('Gérer mon compte et mon abonnement','Manage my account and subscription')}</a><button class="secondary" data-signout>${t('Se déconnecter','Sign out')}</button><button class="text-button" data-close>${t('Fermer','Close')}</button></div>`;document.body.append(d);d.querySelector('[data-signout]').onclick=()=>signOut(auth);d.querySelector('[data-close]').onclick=()=>d.close();d.showModal();};
    try{const who=await api('/api/admin/whoami');if(who.isAdmin===true&&who.emailVerified===true&&who.email?.toLowerCase()==='natquinson@gmail.com'&&auth.currentUser?.uid===next.uid){const a=document.createElement('a');a.className='nav-item';a.href='admin.html?lang='+lang;a.textContent=t('⚙ Administration','⚙ Administration');document.querySelector('.sidebar nav').append(a);}}catch{/* Server denial is expected for non-admin accounts. */}}
});
await loadScript('assets/clarity/feedback.js?v=feedback1').catch(()=>{});
await loadScript('assets/clarity/compact-search.js?v=visible1');
if(!document.getElementById('searchWrap')){header.querySelector('.account-topbar-label,.watchlist-topbar-label')?.remove();header.insertAdjacentHTML('afterbegin',window.KairosCompactSearch.stockMarkup(lang));}
const searchInput=document.getElementById('companySearch')||document.getElementById('marketSearch');
if(searchInput?.id==='marketSearch')searchInput.value=params.get('q')||'';
initializeStockSearch();
if(!researchHome)window.KairosCompactSearch.mount({header,wrap:document.getElementById('searchWrap'),input:searchInput,lang,filter:searchInput?.id==='marketSearch'});
await loadScript('assets/clarity/live-i18n.js?v=live7');
async function ticker(){try{const d=await api('/api/ticker-tape'),items=(d.items||d.signals||[]).map(x=>({ticker:x.ticker,company:x.company||x.ticker,label:x.label||'',detail:x.value||'',tone:x.color==='red'?'sell':'buy'}));window.KairosTicker.mount(document.getElementById('signalTicker'),{items,labels:{region:t('Signaux Kairos','Kairos signals'),title:t('Le fil Kairos','Kairos signals'),demo:t('Déclarations','Filings'),empty:t('Aucun signal récent.','No recent signals.')},onSelect:item=>openStock(item.ticker)});}catch{document.getElementById('signalTicker').textContent=t('Le fil des déclarations est temporairement indisponible.','The filing feed is temporarily unavailable.');}}
if(!window.KairosEntryRedirect){
ticker();
const legacy=location.hash.slice(1);
if(document.body.dataset.screen==='market'){await loadScript('assets/clarity/fund-brands.js?v=live10');await loadScript('assets/clarity/live-market.js?v=live11');}
else if(document.body.dataset.screen==='account'){await loadScript('assets/clarity/live-account.js?v=live7');}
else if(document.body.dataset.screen==='watchlist'){await loadScript('assets/clarity/live-watchlist.js?v=live7');}
else if(researchHome){await loadScript('assets/clarity/live-research.js?v=research1');}
else{
  const symbol=(params.get('symbol')||new URLSearchParams(legacy.split('?')[1]||'').get('t')||'AAPL').toUpperCase();
  const status=document.getElementById('liveStatus');
  if(params.get('from')==='market'){const filter=new URLSearchParams(params.get('filters')||'');filter.set('lang',lang);document.getElementById('screenerReturn').hidden=false;const a=document.getElementById('screenerReturnLink');a.href='insiders.html?'+filter;a.textContent=t('← Retour à l’exploration','← Back to exploration');}
  try{const d=await api('/api/stock/'+encodeURIComponent(symbol));window.KairosLive={companies:[window.KairosAdapter.stock(d)]};await loadScript('assets/clarity/analysis-english.js?v=live7');await loadScript('assets/clarity/live-stock-views.js?v=live11');status.hidden=true;document.getElementById('companyMain').hidden=false;await loadScript('assets/clarity/app.js?v=live7');window.KairosUI.translate();
    researchHistory().then(history=>history.record({ticker:d.ticker,name:d.company?.name||d.ticker})).catch(()=>{});
    mountWatchButton(d.ticker).catch(()=>{});
    api('/api/13dg/ticker?ticker='+encodeURIComponent(d.ticker)).then(rows=>{const company=window.KairosLive.companies[0];company.activism.filings=window.KairosStockViews.mapActivists(rows.filings||rows.data||[]);window.KairosStockRefresh();}).catch(error=>{document.getElementById('activistsContent').innerHTML=`<p class="data-note">${esc(error.message)}</p>`;});
  }catch(error){showError(status,error);}
}
}
