export function searchQuote(result) {
  if (!result?.meta) return null;
  const closes=(result.indicators?.quote?.[0]?.close||[]).filter(v=>typeof v==='number'&&Number.isFinite(v)&&v>0);
  const meta=result.meta,price=meta.regularMarketPrice;
  // chartPreviousClose describes the beginning of a multi-day range, not yesterday.
  const prev=typeof meta.previousClose==='number'?meta.previousClose:closes.length>=2?closes.at(-2):null;
  const change=typeof price==='number'&&prev>0?price-prev:null;
  return {price,change,changePercent:change===null?null:change/prev*100,currency:meta.currency||null,marketCap:null,sparkline:closes,sparklinePeriod:'1mo'};
}
