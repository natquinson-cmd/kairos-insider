/* One compact, always-visible search field; suggestions float over content. */
(()=>{'use strict';
function mount({header,wrap,input}){
 if(!header||!wrap||!input||wrap.dataset.compactSearch)return;
 wrap.dataset.compactSearch='true';header.classList.add('has-compact-search');wrap.classList.add('persistent-search');wrap.hidden=false;
 const close=()=>{const popup=wrap.querySelector('.search-popup');if(popup)popup.hidden=true;input.setAttribute('aria-expanded','false');};
 const focus=()=>{input.focus();input.select();};
 document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();event.stopImmediatePropagation();focus();}},true);
 input.addEventListener('keydown',event=>{if(event.key==='Escape')close();});
 document.addEventListener('pointerdown',event=>{if(!wrap.contains(event.target))close();});
 return {focus,close};
}
function stockMarkup(lang='fr'){
 const t=(fr,en)=>lang==='en'?en:fr;
 return `<div class="search-wrap" id="searchWrap"><label for="companySearch">${t('Rechercher une société','Search for a company')}</label><div class="search-field"><span aria-hidden="true">⌕</span><input id="companySearch" type="search" autocomplete="off" placeholder="${t('Société ou symbole…','Company or ticker…')}" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="searchResults"></div><div class="search-popup" id="searchPopup" hidden><ul id="searchResults" role="listbox" aria-label="${t('Sociétés','Companies')}"></ul><p id="searchEmpty" hidden>${t('Aucun résultat.','No results.')}</p></div></div>`;
}
window.KairosCompactSearch={mount,stockMarkup};
})();
