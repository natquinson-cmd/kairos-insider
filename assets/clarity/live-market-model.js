(function(root,factory){const api=factory();if(typeof module==='object')module.exports=api;else root.KairosMarketLive=api;})(typeof window==='object'?window:this,()=>{
const ticker=value=>typeof value==='string'?value.trim().toUpperCase():'';
const placeholders=new Set(['NONE','N/A','NA','NULL','UNKNOWN','NAN','UNAVAILABLE']);
const validTicker=value=>/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(ticker(value))&&!placeholders.has(ticker(value));
const number=value=>value===null||value===undefined||typeof value==='boolean'||String(value).trim()===''?null:Number.isFinite(Number(value))?Number(value):null;
function sum(rows){let total=0;for(const row of rows){const value=number(row.value);if(value===null)return null;total+=value;}return total;}
const amountRank=value=>value===null?-Infinity:value;
function convergences(transactions,{buyers=2,windowDays=30}={}){
 const groups=new Map();
 for(const row of transactions){if(!validTicker(row.ticker)||!/^\d{4}-\d{2}-\d{2}$/.test(row.date||''))continue;const key=ticker(row.ticker)+'|'+(row.currency||'USD');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
 const result=[];
 for(const rows of groups.values()){rows.sort((a,b)=>a.date.localeCompare(b.date));let best=null;
  for(const endDate of new Set(rows.map(r=>r.date))){const startDate=new Date(Date.parse(endDate+'T12:00:00Z')-(windowDays-1)*86400000).toISOString().slice(0,10);const window=rows.filter(r=>r.date>=startDate&&r.date<=endDate),purchases=window.filter(r=>r.type==='buy'),people=new Map();
   for(const r of purchases){const identity=r.insiderCik?'cik:'+r.insiderCik:r.insider&&r.insider.trim()?'name:'+r.insider.trim().toLowerCase():null;if(identity)people.set(identity,r.insider||r.insiderCik);}
   if(people.size<buyers)continue;const candidate={ticker:ticker(rows[0].ticker),company:rows[0].company,currency:rows[0].currency||'USD',buyers:people.size,people:[...people.values()],amount:sum(purchases),sales:sum(window.filter(r=>r.type==='sell')),startDate,endDate,transactions:window};
   if(!best||candidate.buyers>best.buyers||candidate.buyers===best.buyers&&amountRank(candidate.amount)>amountRank(best.amount)||candidate.buyers===best.buyers&&candidate.amount===best.amount&&candidate.endDate>best.endDate)best=candidate;
  }if(best)result.push(best);
 }return result.sort((a,b)=>b.buyers-a.buyers||amountRank(b.amount)-amountRank(a.amount)||b.endDate.localeCompare(a.endDate));
}
return {convergences,validTicker};
});
