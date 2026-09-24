import {finiteNumber} from './financial-normalization.js';
import {normalizeInsiderMovement} from './insider-alerts.js';

// Matches handleStockAnalysis's current standard-range cache. Do not fetch or
// recalculate a missing analysis here: watchlist browsing never spends quota.
const CACHE_PREFIX = 'stock-analysis:v23:';
const MAX_SYMBOLS = 100;

function symbols(values) {
  const result = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string') continue;
    const ticker = value.trim().toUpperCase();
    if (/^[A-Z0-9][A-Z0-9.\-]{0,11}$/.test(ticker)) result.add(ticker);
    if (result.size === MAX_SYMBOLS) break;
  }
  return [...result];
}

function timestamp(value, seconds = false) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const number = typeof value === 'number' ? value : null;
  const ms = number == null ? Date.parse(value) : number * (seconds ? 1000 : 1);
  return Number.isFinite(ms) && ms > 0 && ms <= 8640000000000000 ? new Date(ms).toISOString() : null;
}
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const number = value => typeof value === 'number' || typeof value === 'string' ? finiteNumber(value) : null;

function threeMonthCurve(raw,now){
  if(!Array.isArray(raw))return null;
  const end=new Date(now),today=end.toISOString().slice(0,10);
  const lastDay=new Date(Date.UTC(end.getUTCFullYear(),end.getUTCMonth()-2,0)).getUTCDate();
  const start=new Date(Date.UTC(end.getUTCFullYear(),end.getUTCMonth()-3,Math.min(end.getUTCDate(),lastDay))),cutoff=start.toISOString().slice(0,10);
  const values=new Map();
  for(const row of raw){const day=typeof row?.date==='string'?row.date.slice(0,10):'',close=number(row?.close);if(/^\d{4}-\d{2}-\d{2}$/.test(day)&&day>=cutoff&&day<=today&&close>0)values.set(day,close);}
  const points=[...values].sort(([a],[b])=>a.localeCompare(b)).slice(-96).map(([date,close])=>({date,close}));
  if(points.length<2)return null;
  const first=points[0],last=points.at(-1);
  return {points,from:first.date,to:last.date,changePercent:(last.close/first.close-1)*100,partial:Date.parse(first.date)-start.getTime()>7*86400000};
}

async function stockCache(env, ticker) {
  for (const view of ['full', 'pub']) {
    const cached = await env.CACHE.get(`${CACHE_PREFIX}${ticker}:${view}:1y`, 'json').catch(() => null);
    if (cached && typeof cached === 'object' && !cached.error && cached.ticker === ticker) return cached;
  }
  return null;
}

/** Cache-only projection for an already authenticated uid. No writes, outbound
 * requests, alerts, subscription actions, or calls to handleStockAnalysis. */
export async function readWatchlistSummary(env, uid, legacySymbols = '', now = Date.now()) {
  if (typeof uid !== 'string' || !uid) throw new Error('Authenticated identity required');
  const record = await env.CACHE.get(`wl:${uid}`, 'json');
  const exists = record != null;
  const tickers = symbols(exists ? record.tickers : String(legacySymbols).slice(0, 1600).split(','));
  const result = {ok: true, exists, cacheOnly: true, items: [], updatedAt: new Date(now).toISOString(),activity:{available:false,events:[],total:0,truncated:false,days:30}};
  if (!tickers.length) return result;

  const feed = await env.CACHE.get('insider-transactions', 'json').catch(() => null);
  const wanted = new Set(tickers), latest = new Map(), today = result.updatedAt.slice(0, 10);
  const cutoff = new Date(Date.parse(today)-29*86400000).toISOString().slice(0,10), events=new Map();
  result.activity.available=Array.isArray(feed?.transactions);
  result.activity.sourceUpdatedAt=timestamp(feed?.updatedAt||feed?.generatedAt);
  for (const row of Array.isArray(feed?.transactions) ? feed.transactions : []) {
    const event = normalizeInsiderMovement(row);
    if (!event || !wanted.has(event.ticker) || event.fileDate > today) continue;
    if(event.fileDate>=cutoff)events.set(event.id,event);
    const previous = latest.get(event.ticker);
    if (!previous || event.fileDate > previous.fileDate ||
        event.fileDate === previous.fileDate && (event.tradeDate || '') > (previous.tradeDate || '')) latest.set(event.ticker, event);
  }
  const recent=[...events.values()].sort((a,b)=>b.fileDate.localeCompare(a.fileDate)||(b.tradeDate||'').localeCompare(a.tradeDate||'')||a.id.localeCompare(b.id));
  result.activity.total=recent.length;
  result.activity.truncated=recent.length>200;
  result.activity.events=recent.slice(0,200);

  // Bound concurrency instead of issuing 100 large cached analyses at once.
  for (let offset = 0; offset < tickers.length; offset += 8) {
    const batch = await Promise.all(tickers.slice(offset, offset + 8).map(async ticker => {
      const cached = await stockCache(env, ticker), event = latest.get(ticker);
      const cachedAt = timestamp(cached?._cachedAt) || timestamp(cached?.updatedAt);
      const rawPrice = number(cached?.price?.current), rawScore = number(cached?.score?.total);
      const price = rawPrice != null && rawPrice > 0 ? rawPrice : null;
      const score = rawScore != null && rawScore >= 0 && rawScore <= 100 ? rawScore : null;
      return {
        ticker,
        name: text(cached?.company?.name) || (event?.company !== ticker ? text(event?.company) : null),
        price, currency: text(cached?.price?.currency), changePercent: number(cached?.price?.changePct),
        // Never present the response assembly time as the quote's market time.
        quoteAt: price == null ? null : timestamp(cached?.price?.regularMarketTime, true),
        cachedAt, score, scoreAt: score == null ? null : cachedAt,
        sparkline3m:threeMonthCurve(cached?.chart?.points,now),
        latestInsider: event ? {
          type: event.type, insider: text(event.insider), value: event.value,
          currency: text(event.currency), fileDate: event.fileDate, tradeDate: event.tradeDate, sourceUrl: event.sourceUrl,
        } : null,
      };
    }));
    result.items.push(...batch);
  }
  return result;
}
