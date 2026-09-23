(()=>{
const query=new URLSearchParams(location.search),lang=(query.get('lang')||window.KairosI18n?.getLang?.())==='en'?'en':'fr';
// The legacy auth callback consumes these flags before announcing auth-ready.
// Remember the billing flow now so its checkout/portal timers can finish.
let billingFlow=['plan','billing','checkout'].some(key=>query.has(key))||document.documentElement.classList.contains('pending-checkout');
try{billingFlow=billingFlow||!!localStorage.getItem('kairos_auto_checkout')||!!sessionStorage.getItem('kairos_reopen_paywall');}catch{}
const redirectProfile=()=>{if(!billingFlow&&location.hash.split('?')[0]==='#profile'){location.replace('account.html?lang='+lang);return true;}return false;};
window.addEventListener('hashchange',redirectProfile);redirectProfile();
window.addEventListener('kairos:auth-ready',()=>{
  if(redirectProfile())return;
  const [section,hashQuery='']=location.hash.slice(1).split('?');
  if(window.isAnonymous!==false||billingFlow||!['','home','stockAnalysis'].includes(section))return;
  const destination=new URLSearchParams({lang}),symbol=new URLSearchParams(hashQuery).get('t')||query.get('symbol');
  if(symbol)destination.set('symbol',symbol);
  location.replace('dashboard.html?'+destination);
});
document.addEventListener('click',event=>{const button=event.target.closest('[data-section]');if(!button||button.dataset.section==='admin')return;const key=button.dataset.section;const routes={stockAnalysis:'dashboard.html',insider:'insiders.html',activists:'insiders.html?screen=activists','13f':'insiders.html?screen=funds'};if(routes[key]){event.preventDefault();event.stopImmediatePropagation();location.href=routes[key]+(routes[key].includes('?')?'&':'?')+'lang='+lang;}},true);
})();
