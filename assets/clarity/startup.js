/* Runs before the document is painted. No data, auth or storage writes. */
(()=>{'use strict';
 const root=document.documentElement,query=new URLSearchParams(location.search);
 const lang=query.get('lang')==='en'?'en':'fr',t=(fr,en)=>lang==='en'?en:fr;
 const legacy=location.pathname.endsWith('/admin-workspace.html');
 let ready=false,destination='',failed=false;
 root.lang=lang;
 const stockEntry=/\/(?:dashboard|clarity-preview)\.html$/.test(location.pathname);
 if(stockEntry&&!query.get('symbol')&&!new URLSearchParams(location.hash.slice(1).split('?')[1]||'').get('t'))root.setAttribute('data-kairos-research','true');
 function render(){
  const title=document.getElementById('kairosBootTitle'),message=document.getElementById('kairosBootMessage'),retry=document.getElementById('kairosBootRetry'),home=document.getElementById('kairosBootHome');
  if(!title)return;
  title.textContent=failed?t('Kairos n’a pas pu démarrer.','Kairos could not load.'):destination?t('Ouverture de votre espace…','Opening your workspace…'):t('Chargement de Kairos…','Loading Kairos…');
  message.textContent=failed?t('Vérifiez votre connexion, puis réessayez.','Check your connection, then retry.'):t('Si cet écran persiste, vous pouvez recharger la page.','If this screen persists, you can reload the page.');
  retry.textContent=destination?t('Continuer','Continue'):t('Recharger','Reload');retry.href=destination||location.href;
  home.textContent=t('Retour à l’accueil','Back to home');home.href='index.html?lang='+lang;
 }
 function fail(){if(ready||destination)return;failed=true;root.setAttribute('data-kairos-startup','error');render();}
 window.KairosStartup={ready(){if(destination||failed)return;ready=true;root.removeAttribute('data-kairos-startup');},fail};
 // Explicit auth and checkout requests retain their original handlers.
 if(legacy){
  const section=location.hash.slice(1).split(/[?&]/)[0];
  if(section==='admin')root.classList.add('clarity-admin');
  let protectedFlow=['plan','billing','checkout','action','mode','oobCode'].some(key=>query.has(key));
  try{protectedFlow=protectedFlow||!!window.localStorage.getItem('kairos_auto_checkout')||!!window.sessionStorage.getItem('kairos_reopen_paywall');}catch{/* Restricted storage does not prevent navigation. */}
  if(!protectedFlow){
   const out=new URLSearchParams(query);out.set('lang',lang);
   if(['profile','watchlist','alerts'].includes(section))destination=(section==='profile'?'account.html':'watchlist.html')+'?'+out+(section==='alerts'?'#alerts':'');
   else if(['','home','stockAnalysis'].includes(section)){
    const symbol=new URLSearchParams(location.hash.slice(1).split('?')[1]||'').get('t');if(symbol)out.set('symbol',symbol);
    destination='dashboard.html?'+out;
   }else if(['insider','activists','13f','clustering','consensus13f'].includes(section)){
    out.set('screen',['13f','consensus13f'].includes(section)?'funds':section==='activists'?'activists':'insiders');
    out.set('view',section==='clustering'?'convergences':section==='consensus13f'?'consensus':'transactions');
    destination='insiders.html?'+out;
   }
  }
  if(destination){window.KairosEarlyRedirect=true;root.setAttribute('data-kairos-startup','redirect');location.replace(destination);}
 }else if(window.KairosEntryRedirect){root.setAttribute('data-kairos-startup','redirect');destination=window.KairosEntryTarget||'';}
 // Resource failures are caught before module evaluation; image/analytics failures
 // do not replace a working page. There is no timer that reveals the old layout.
 window.addEventListener('error',event=>{
  const resource=event.target?.tagName==='SCRIPT'?event.target.src:event.target?.tagName==='LINK'?event.target.href:event.filename||'';
  if(/\/(?:assets\/clarity\/(?:live-shell|live-adapter|app|admin-shell|compact-search|live-i18n)|assets\/core-release)\.(?:js|css)(?:[?#]|$)/.test(resource))fail();
 },true);
 document.addEventListener('DOMContentLoaded',render,{once:true});
 if(document.readyState!=='loading')render();
})();
