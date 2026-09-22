(function(root,factory){const api=factory();if(typeof module==='object')module.exports=api;else root.KairosMarketLive=api;})(typeof window==='object'?window:this,()=>{
function convergences(transactions,{buyers=2,windowDays=30}={}){
 const groups=new Map();
 for(const row of transactions){if(!row.ticker||!/^\d{4}-\d{2}-\d{2}$/.test(row.date||''))continue;const key=row.ticker+'|'+(row.currency||'USD');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
 const result=[];
 for(const rows of groups.values()){rows.sort((a,b)=>a.date.localeCompare(b.date));let best=null;
  for(let end=0;end<rows.length;end++){const endDate=rows[end].date,startDate=new Date(Date.parse(endDate+'T12:00:00Z')-(windowDays-1)*86400000).toISOString().slice(0,10);const window=rows.slice(0,end+1).filter(r=>r.date>=startDate),purchases=window.filter(r=>r.type==='buy'),people=new Map();
   for(const r of purchases){const identity=r.insiderCik?'cik:'+r.insiderCik:r.insider&&r.insider.trim()?'name:'+r.insider.trim().toLowerCase():null;if(identity)people.set(identity,r.insider||r.insiderCik);}
   if(people.size<buyers)continue;const sum=rs=>rs.reduce((s,r)=>s+(typeof r.value==='number'&&Number.isFinite(r.value)?r.value:0),0),candidate={ticker:rows[0].ticker,company:rows[0].company,currency:rows[0].currency||'USD',buyers:people.size,people:[...people.values()],amount:sum(purchases),sales:sum(window.filter(r=>r.type==='sell')),startDate,endDate,transactions:window};
   if(!best||candidate.buyers>best.buyers||candidate.buyers===best.buyers&&candidate.amount>best.amount||candidate.buyers===best.buyers&&candidate.amount===best.amount&&candidate.endDate>best.endDate)best=candidate;
  }if(best)result.push(best);
 }return result.sort((a,b)=>b.buyers-a.buyers||b.amount-a.amount||b.endDate.localeCompare(a.endDate));
}
return {convergences};
});
