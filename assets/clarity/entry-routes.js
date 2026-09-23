/* Preserve existing account, checkout and research links before any data requests. */
(()=>{
  const query=new URLSearchParams(location.search),section=location.hash.slice(1).split(/[?&]/)[0];
  const lang=query.get('lang')==='en'?'en':'fr';let target='';
  if(section==='admin')target='admin.html'+location.search;
  else if(['plan','billing','checkout','action'].some(key=>query.has(key)))target='admin-workspace.html'+location.search+location.hash;
  else if(section==='profile')target='account.html'+location.search;
  else if(['watchlist','alerts'].includes(section))target='watchlist.html'+location.search+(section==='alerts'?'#alerts':'');
  else if(['insider','activists','13f','clustering','consensus13f'].includes(section))target='insiders.html?'+new URLSearchParams({lang,screen:['13f','consensus13f'].includes(section)?'funds':section==='activists'?'activists':'insiders',view:section==='clustering'?'convergences':section==='consensus13f'?'consensus':'transactions'});
  else if(['home','hotStocks','insiderProfile','13f-explorer','etf','etf-explorer','feargreed','vix','shorts','portfolio','watchlist','profile','signals-score','signals-etf','signals-clusters','alerts'].includes(section))target='admin-workspace.html'+location.search+location.hash;
  globalThis.KairosEntryRedirect=!!target;
  if(target)location.replace(target);
})();
