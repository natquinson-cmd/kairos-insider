(()=>{
const lang=new URLSearchParams(location.search).get('lang')==='en'?'en':'fr';
document.addEventListener('click',event=>{const button=event.target.closest('[data-section]');if(!button||button.dataset.section==='admin')return;const key=button.dataset.section;const routes={stockAnalysis:'dashboard.html',insider:'insiders.html',activists:'insiders.html?screen=activists','13f':'insiders.html?screen=funds'};if(routes[key]){event.preventDefault();event.stopImmediatePropagation();location.href=routes[key]+(routes[key].includes('?')?'&':'?')+'lang='+lang;}},true);
})();
