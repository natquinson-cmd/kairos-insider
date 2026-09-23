(function(root){'use strict';
 const symbol=value=>typeof value==='string'&&/^[A-Z0-9.^=-]{1,20}$/i.test(value)?value.toUpperCase():null;
 function create(storage,account='guest'){
  const key='kairos-research-history:v1:'+account;
  function load(){try{const value=JSON.parse(storage.getItem(key)||'[]');return Array.isArray(value)?value.filter(x=>x&&symbol(x.ticker)&&typeof x.name==='string'&&Number.isFinite(x.visitedAt)).slice(0,8):[];}catch{return [];}}
  function record(value){const ticker=symbol(value?.ticker);if(!ticker)return;const rows=[{ticker,name:String(value.name||ticker).slice(0,150),visitedAt:Date.now()},...load().filter(x=>x.ticker!==ticker)].slice(0,8);try{storage.setItem(key,JSON.stringify(rows));}catch{/* Restricted browser storage must never block an analysis. */}}
  function clear(){try{storage.removeItem(key);}catch{}}
  return {load,record,clear};
 }
 if(typeof module==='object'&&module.exports)module.exports={create};else root.KairosResearchHistory={create};
})(typeof window==='object'?window:globalThis);
