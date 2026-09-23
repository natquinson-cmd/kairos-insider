const cik=v=>/^\d{1,10}$/.test(String(v||''))?String(v).padStart(10,'0'):null;
// CUSIP modulus-10 double-add-double check: https://www.cusip.com/identifiers.html
export function validCusip(value){
 if(!/^[A-Z0-9*@#]{8}\d$/.test(value||''))return false;
 let sum=0;for(let i=0;i<8;i++){const digit='*@#'.includes(value[i])?36+'*@#'.indexOf(value[i]):parseInt(value[i],36);const weighted=digit*(i%2?2:1);sum+=Math.floor(weighted/10)+weighted%10;}
 return (10-sum%10)%10===Number(value[8]);
}
export function comparableHistory(rows,trackedCount){
 const clean=rows.filter(r=>cik(r.cik)&&/^\d{4}-(03-31|06-30|09-30|12-31)$/.test(r.report_date)&&typeof r.shares==='number'&&Number.isFinite(r.shares)&&r.shares>=0);
 const dates=[...new Set(clean.map(r=>r.report_date))].sort().slice(-8);
 if(dates.length<2)return {series:[],fundCount:0,trackedCount,reason:'insufficient-history'};
 const byFund=new Map();for(const row of clean){if(!dates.includes(row.report_date))continue;const id=cik(row.cik);if(!byFund.has(id))byFund.set(id,new Map());const byDate=byFund.get(id);if(byDate.has(row.report_date))byDate.set(row.report_date,null);else byDate.set(row.report_date,row.shares);}
 // Only observed positions: missing top-50 holdings cannot be interpreted as exits.
 const cohort=[...byFund.values()].filter(values=>dates.every(date=>values.has(date)&&values.get(date)!==null));
 if(!cohort.length)return {series:[],fundCount:0,trackedCount,reason:'no-comparable-cohort'};
 return {series:dates.map(date=>({date,shares:cohort.reduce((sum,values)=>sum+values.get(date),0)})),fundCount:cohort.length,trackedCount,reason:null};
}
export async function readFundOwnershipHistory(env,ticker,normalizeName){
 const empty=reason=>({ticker,series:[],fundCount:0,trackedCount:0,reason});
 if(!/^[A-Z0-9][A-Z0-9.\-]{0,19}$/.test(ticker))return empty('invalid-symbol');
 if(!env.HISTORY)return empty('unavailable');
 const stock=await env.CACHE.get(`stock-analysis:v23:${ticker}:full:1y`,'json')||await env.CACHE.get(`stock-analysis:v23:${ticker}:pub:1y`,'json');
 if(!stock||stock.ticker!==ticker)return empty('analysis-unavailable');
 const ids=[...new Set((stock.smartMoney?.topFunds||[]).map(f=>cik(f.cik)).filter(Boolean))].slice(0,50);
 if(!ids.length)return empty('no-tracked-funds');
 const name=normalizeName(stock.company?.name||'');if(!name)return empty('unknown-security');
 // Old imports have no ticker; resolve a single security identifier before aggregating.
 const prefix=name.split(' ')[0].replace(/[%_]/g,'');if(prefix.length<3)return empty('unknown-security');
 const candidates=await env.HISTORY.prepare('SELECT DISTINCT cusip, name, ticker FROM fund_holdings_history WHERE ticker = ? OR UPPER(name) LIKE ? LIMIT 200').bind(ticker,prefix+'%').all();
 const matching=(candidates.results||[]).filter(r=>r.ticker===ticker||!r.ticker&&normalizeName(r.name)===name);
 const securities=[...new Set(matching.map(r=>r.cusip).filter(validCusip))];
 if(securities.length!==1)return empty(securities.length?'ambiguous-security':'unknown-security');
 const result=await env.HISTORY.prepare(`SELECT report_date, cik, shares FROM fund_holdings_history WHERE cusip = ? AND cik IN (${ids.map(()=>'?').join(',')}) AND report_date >= date('now', '-2 years') AND report_date <= date('now') ORDER BY report_date ASC`).bind(securities[0],...ids).all();
 return {ticker,...comparableHistory(result.results||[],ids.length),basis:'reported-shares',coverage:'observed-positions-same-funds',splitAdjusted:false};
}
