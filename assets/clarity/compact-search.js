/* A stable header: the search opens over content, never pushes it down. */
(()=>{'use strict';
function mount({header,wrap,input,lang='fr',filter=false}){
 if(!header||!wrap||!input||wrap.dataset.compactSearch)return;
 wrap.dataset.compactSearch='true';header.classList.add('has-compact-search');
 const t=(fr,en)=>lang==='en'?en:fr;
 const trigger=document.createElement('button');trigger.type='button';trigger.className='compact-search-trigger';trigger.setAttribute('aria-expanded','false');trigger.setAttribute('aria-controls',wrap.id);
 const label=document.createElement('span');trigger.append(label);const shortcut=document.createElement('kbd');shortcut.textContent='Ctrl K';trigger.append(shortcut);
 const clear=document.createElement('button');clear.type='button';clear.className='compact-search-clear';clear.textContent='×';clear.setAttribute('aria-label',t('Effacer le filtre de recherche','Clear the search filter'));clear.hidden=true;
 const slot=document.createElement('div');slot.className='compact-search-slot';slot.append(trigger,clear);wrap.before(slot);
 const closeButton=document.createElement('button');closeButton.type='button';closeButton.className='compact-search-close';closeButton.textContent='×';closeButton.setAttribute('aria-label',t('Fermer la recherche','Close search'));wrap.append(closeButton);
 wrap.classList.add('compact-search-panel');wrap.hidden=true;
 const update=()=>{const query=filter?input.value.trim():'';label.textContent=query?t('Filtre : ','Filter: ')+query:t('Rechercher…','Search…');trigger.setAttribute('aria-label',query?t('Modifier le filtre : ','Edit filter: ')+query:t('Ouvrir la recherche','Open search'));clear.hidden=!query;};
 function close(restore=true){wrap.hidden=true;trigger.setAttribute('aria-expanded','false');const popup=wrap.querySelector('.search-popup');if(popup)popup.hidden=true;input.setAttribute('aria-expanded','false');if(restore)trigger.focus();update();}
 function open(){wrap.hidden=false;trigger.setAttribute('aria-expanded','true');input.focus();input.select();}
 trigger.onclick=()=>wrap.hidden?open():close();closeButton.onclick=()=>close();
 clear.onclick=()=>{input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));update();trigger.focus();};
 input.addEventListener('input',update);
 document.addEventListener('keydown',event=>{
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();event.stopImmediatePropagation();open();}
  else if(event.key==='Escape'&&!wrap.hidden){event.preventDefault();event.stopImmediatePropagation();close();}
 },true);
 document.addEventListener('pointerdown',event=>{if(!wrap.hidden&&!wrap.contains(event.target)&&!slot.contains(event.target))close(false);});
 wrap.addEventListener('focusout',()=>setTimeout(()=>{if(!wrap.hidden&&!wrap.contains(document.activeElement)&&!slot.contains(document.activeElement))close(false);},0));
 update();if(input.value&&!filter)open();
 return {open,close,update};
}
function stockMarkup(lang='fr'){
 const t=(fr,en)=>lang==='en'?en:fr;
 return `<div class="search-wrap" id="searchWrap"><label for="companySearch">${t('Rechercher une société','Search for a company')}</label><div class="search-field"><span aria-hidden="true">⌕</span><input id="companySearch" type="search" autocomplete="off" placeholder="${t('Société ou symbole…','Company or ticker…')}" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="searchResults"></div><div class="search-popup" id="searchPopup" hidden><ul id="searchResults" role="listbox" aria-label="${t('Sociétés','Companies')}"></ul><p id="searchEmpty" hidden>${t('Aucun résultat.','No results.')}</p></div></div>`;
}
window.KairosCompactSearch={mount,stockMarkup};
})();
