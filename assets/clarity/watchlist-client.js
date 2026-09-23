(function(root){'use strict';
  const defaults={insider:true,cluster:true,etf:true,score:true};
  function normalize(data){
    const d=data||{};
    return {...d,tickers:[...new Set((Array.isArray(d.tickers)?d.tickers:[]).filter(x=>typeof x==='string'&&/^[A-Z0-9.\-]{1,12}$/i.test(x)).map(x=>x.toUpperCase()))],emailAlerts:d.emailAlerts===true,emailInsiderAlerts:d.emailInsiderAlerts===true,optIn:d.optIn===true,types:{...defaults,...d.types}};
  }
  function create({api,readLegacy,mirror}){
    let queue=Promise.resolve();
    async function load(){
      const data=await api('/api/watchlist/get');
      if(!data||data.ok!==true)throw new Error('Watchlist unavailable');
      if(data.exists===false&&readLegacy){const old=await readLegacy();if(old)return normalize({...data,...old,optIn:false});}
      return normalize(data);
    }
    function change(edit,{sendConfirmation=false}={}){
      const run=async()=>{
        const current=await load(),next=normalize(edit(current));
        const payload={tickers:next.tickers,emailAlerts:next.emailAlerts,emailInsiderAlerts:next.emailInsiderAlerts,types:next.types,lang:next.lang||'fr',sendConfirmation};
        const result=await api('/api/watchlist/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
        if(result?.ok!==true)throw new Error('Watchlist was not saved');
        const saved=normalize({...next,...result});let mirrorFailed=false;
        if(mirror)try{await mirror(payload);}catch{mirrorFailed=true;}
        return {...saved,mirrorFailed};
      };
      const next=queue.then(run);queue=next.catch(()=>{});return next;
    }
    function add(symbol){if(typeof symbol!=='string'||!/^[A-Z0-9.\-]{1,12}$/i.test(symbol))return Promise.reject(new Error('Invalid ticker'));return change(s=>({...s,tickers:[...s.tickers,symbol.toUpperCase()]}));}
    return {load,add,remove:symbol=>change(s=>({...s,tickers:s.tickers.filter(x=>x!==symbol)})),preferences:(prefs,options)=>change(s=>({...s,...prefs,types:{...s.types,...prefs.types}}),options)};
  }
  if(typeof module==='object'&&module.exports)module.exports={normalize,create};else root.KairosWatchlistClient={normalize,create};
})(typeof window==='object'?window:globalThis);
