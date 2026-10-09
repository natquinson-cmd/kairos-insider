(function(root){'use strict';
const validSymbol=value=>typeof value==='string'&&/^[A-Z0-9][A-Z0-9.\-]{0,11}$/.test(value);
const validScore=row=>typeof row?.score==='number'&&Number.isFinite(row.score)&&row.score>=0&&row.score<=100&&row.scoreAt&&Number.isFinite(Date.parse(row.scoreAt));
function create({api,onChange}){
 let generation=0,running=false,queue=[],entries=new Map(),activeController=null,stopped=false;
 function notify(entry,state,item){entry.state=state;onChange({ticker:entry.ticker,state,...(item?{item}:{}),reason:entry.reason||null});}
 async function pump(){
  if(running)return;running=true;
  try{while(queue.length&&!stopped){
   const entry=queue.shift(),version=generation;if(entries.get(entry.ticker)!==entry)continue;
   notify(entry,'loading');const controller=new AbortController();activeController=controller;
   let timer;
   try{
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Score timeout'));},90000);});
    const response=await Promise.race([api('/api/watchlist/score',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol:entry.ticker}),signal:controller.signal}),timeout]);
    if(version!==generation||stopped)continue;
    if(response?.ok===true&&response.item?.ticker===entry.ticker&&validScore(response.item)&&response.item.scoreStatus==='available')notify(entry,'ready',response.item);
    else if(response?.state==='busy'&&(entry.busyRetries||0)<2){
     entry.busyRetries=(entry.busyRetries||0)+1;notify(entry,'queued');
     const delay=Math.max(1,Math.min(5,Number(response.retryAfterSeconds)||5))*1000;
     await new Promise(resolve=>{let wait;const finish=()=>{clearTimeout(wait);controller.signal.removeEventListener('abort',finish);resolve();};wait=setTimeout(finish,delay);controller.signal.addEventListener('abort',finish,{once:true});if(controller.signal.aborted)finish();});
     if(version===generation&&!stopped)queue.unshift(entry);
    }else{entry.reason=response?.state||'unavailable';notify(entry,'error');}
   }catch{if(version===generation&&!stopped){entry.reason='unavailable';notify(entry,'error');}}
   finally{clearTimeout(timer);activeController=null;}
  }}finally{running=false;}
 }
 function load(rows){
  generation++;stopped=false;activeController?.abort();queue=[];entries=new Map();
  for(const row of Array.isArray(rows)?rows:[]){
   if(entries.size>=100)break;
   if(!validSymbol(row?.ticker)||entries.has(row.ticker))continue;
   const entry={ticker:row.ticker,state:'ready'};entries.set(row.ticker,entry);
   if(typeof row.score!=='number'||!Number.isFinite(row.score)||['historical','previous','unavailable'].includes(row.scoreStatus)){
    queue.push(entry);notify(entry,'queued');
   }
  }
  void pump();
 }
 function retry(ticker){const entry=entries.get(ticker);if(!entry||entry.state!=='error')return;entry.reason=null;entry.busyRetries=0;queue.push(entry);notify(entry,'queued');void pump();}
 function stop(){stopped=true;generation++;queue=[];entries.clear();activeController?.abort();}
 return {load,retry,stop};
}
const exports={create};if(typeof module==='object'&&module.exports)module.exports=exports;else root.KairosWatchlistScores=exports;
})(typeof window==='object'?window:globalThis);
