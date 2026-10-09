import {finiteNumber} from './financial-normalization.js';
import {normalizeInsiderMovement} from './insider-alerts.js';
import {preferInsiderTransactionEvidence} from './insider-transaction.js';
import {STOCK_ANALYSIS_VERSION, STOCK_SUMMARY_PREFIX, readWatchlistQuote, storeStockSummarySnapshot} from './watchlist-market-data.js';

// Never recalculate a missing analysis here: watchlist browsing spends no quota.
const CACHE_PREFIX = `stock-analysis:${STOCK_ANALYSIS_VERSION}:`;
const MAX_SYMBOLS = 100;
const scoreCalculations = new Map(), accountCalculations = new Map();
const SCORE_FRESH_MS = 86400000, SCORE_RETRY_SECONDS = 300;

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
  const saved = await env.CACHE.get(STOCK_SUMMARY_PREFIX + ticker, 'json').catch(() => null);
  return saved && typeof saved === 'object' && !saved.error && saved.ticker === ticker ? saved : null;
}

function currentScore(row, ticker, now) {
  const value = number(row?.score?.total), at = timestamp(row?._cachedAt) || timestamp(row?.updatedAt);
  const axes = row?.score?.breakdown;
  if (row?.ticker !== ticker || row.error || value == null || value < 0 || value > 100 || !at ||
      Date.parse(at) > now + 30000 || now - Date.parse(at) >= SCORE_FRESH_MS ||
      axes && Object.values(axes).length && !Object.values(axes).some(axis => axis?.dataOk !== false)) return null;
  return {ticker, score: value, scoreAt: at, scoreStatus: 'available', scoreSource: 'analysis', scoreVersion: STOCK_ANALYSIS_VERSION};
}

/** Compute one saved watchlist score using the same engine as its stock page.
 * The caller authenticates first and injects the production analysis function.
 * Only public calculation caches are written; no user quota or alert side effects. */
export async function refreshWatchlistScore(env, uid, rawTicker, calculate) {
  const reply = (status, body) => ({status, body});
  if (typeof uid !== 'string' || !uid) return reply(401, {ok:false, code:'AUTH_REQUIRED'});
  const ticker = typeof rawTicker === 'string' ? rawTicker.trim().toUpperCase() : '';
  if (symbols([ticker])[0] !== ticker) return reply(400, {ok:false, code:'INVALID_SYMBOL'});
  const saved = await env.CACHE.get(`wl:${uid}`, 'json');
  if (!symbols(saved?.tickers).includes(ticker)) return reply(403, {ok:false, code:'NOT_IN_WATCHLIST'});
  const cached = currentScore(await stockCache(env, ticker), ticker, Date.now());
  if (cached) return reply(200, {ok:true, item:cached});

  const key = `${STOCK_ANALYSIS_VERSION}:${ticker}`;
  if (scoreCalculations.has(key)) return scoreCalculations.get(key);
  if (accountCalculations.has(uid) || scoreCalculations.size >= 4) {
    return reply(200, {ok:false, state:'busy', retryAfterSeconds:5});
  }
  const cooldownKey = `watchlist-score-refresh:${key}`;
  const job = (async () => {
    const now = Date.now();
    const previous = await env.CACHE.get(cooldownKey, 'json').catch(() => null);
    if (number(previous?.until) > now) {
      return reply(200, {ok:false, state:previous.state === 'loading' ? 'busy' : 'cooldown', retryAfterSeconds:Math.ceil((previous.until-now)/1000)});
    }
    try {
      // Best-effort cross-instance lease; in-flight maps also deduplicate tabs
      // within this instance. This is a short calculation lock, not a user quota.
      await env.CACHE.put(cooldownKey, JSON.stringify({state:'loading', until:now+120000}), {expirationTtl:120});
      const analysis = await calculate(ticker, env, {publicView:false, chartRange:'1y'});
      const item = currentScore(analysis, ticker, Date.now());
      if (!item || !Object.values(analysis.score?.breakdown || {}).some(axis => axis?.dataOk === true)) throw new Error('No supported score');
      await storeStockSummarySnapshot(env, analysis).catch(() => {});
      await env.CACHE.put(cooldownKey, JSON.stringify({state:'ready', until:0}), {expirationTtl:60}).catch(() => {});
      return reply(200, {ok:true, item});
    } catch {
      await env.CACHE.put(cooldownKey, JSON.stringify({state:'failed', until:Date.now()+SCORE_RETRY_SECONDS*1000}), {expirationTtl:SCORE_RETRY_SECONDS}).catch(() => {});
      return reply(200, {ok:false, state:'unavailable', retryAfterSeconds:SCORE_RETRY_SECONDS});
    }
  })();
  scoreCalculations.set(key, job); accountCalculations.set(uid, key);
  try { return await job; }
  finally { scoreCalculations.delete(key); accountCalculations.delete(uid); }
}

async function recentHistoricalScores(env, tickers, now) {
  const scores = new Map();
  if (!env.HISTORY?.prepare || !tickers.length) return scores;
  const maxAge = 7 * 86400000, oldest = new Date(now - maxAge).toISOString().slice(0, 10);
  const today = new Date(now).toISOString().slice(0, 10);
  // The archive has no method version. It is an explicitly historical fallback,
  // never a replacement for a current-method score, and never a new calculation.
  // Two reads at most for the 100-stock limit; leave room for date parameters.
  for (let offset = 0; offset < tickers.length; offset += 50) {
    const batch = tickers.slice(offset, offset + 50), wanted = new Set(batch);
    try {
      const response = await env.HISTORY.prepare(`
        SELECT s.ticker, s.total, s.date FROM score_history s
        INNER JOIN (
          SELECT ticker, MAX(date) AS latest FROM score_history
          WHERE ticker IN (${batch.map(() => '?').join(',')}) AND date >= ? AND date <= ?
          GROUP BY ticker
        ) recent ON s.ticker = recent.ticker AND s.date = recent.latest
      `).bind(...batch, oldest, today).all();
      for (const row of response?.results || []) {
        const total = number(row.total), day = row.date;
        if (!wanted.has(row.ticker) || total == null || total < 0 || total > 100 ||
            typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
        const at = timestamp(day + 'T00:00:00Z');
        if (!at || at.slice(0, 10) !== day || Date.parse(at) > now || now - Date.parse(at) > maxAge) continue;
        scores.set(row.ticker, {score: total, scoreAt: at, scoreStatus: 'historical', scoreSource: 'history'});
      }
    } catch { /* A missing/unavailable archive must not hide quotes or activity. */ }
  }
  return scores;
}

/** Authenticated personal summary. Only public quote caches may be refreshed;
 * scores reuse current-method cache or explicitly dated recent history;
 * no quota, user, alert or subscription writes, or full stock analyses. */
export async function readWatchlistSummary(env, uid, legacySymbols = '', now = Date.now()) {
  if (typeof uid !== 'string' || !uid) throw new Error('Authenticated identity required');
  const record = await env.CACHE.get(`wl:${uid}`, 'json');
  const exists = record != null;
  const tickers = symbols(exists ? record.tickers : String(legacySymbols).slice(0, 1600).split(','));
  const result = {ok: true, exists, cacheOnly: false, analysisCacheOnly: true, items: [], updatedAt: new Date(now).toISOString(),activity:{available:false,events:[],total:0,truncated:false,days:30}};
  if (!tickers.length) return result;

  const feed = await env.CACHE.get('insider-transactions', 'json').catch(() => null);
  const wanted = new Set(tickers), latest = new Map(), today = result.updatedAt.slice(0, 10);
  const cutoff = new Date(Date.parse(today)-29*86400000).toISOString().slice(0,10), events=new Map();
  result.activity.available=Array.isArray(feed?.transactions);
  result.activity.sourceUpdatedAt=timestamp(feed?.updatedAt||feed?.generatedAt);
  for (const row of preferInsiderTransactionEvidence(Array.isArray(feed?.transactions) ? feed.transactions : [])) {
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

  // Spend the budget only on a real provider request. Cache hits do not block
  // later positions in a large watchlist; the next visit can finish warming it.
  let refreshesRemaining = 48; // Leave room for authentication subrequests.
  const refreshDeadline = Date.now() + 8000;
  const takeRefresh = () => refreshesRemaining > 0 && Date.now() < refreshDeadline && --refreshesRemaining >= 0;
  // Bound concurrency instead of issuing 100 large cached analyses at once.
  for (let offset = 0; offset < tickers.length; offset += 8) {
    const batch = await Promise.all(tickers.slice(offset, offset + 8).map(async ticker => {
      const cached = await stockCache(env, ticker), event = latest.get(ticker);
      const quote = await readWatchlistQuote(env, ticker, cached, now, takeRefresh);
      const cachedAt = timestamp(cached?._cachedAt) || timestamp(cached?.updatedAt);
      const scoreAxes = cached?.score?.breakdown;
      const supportedScore = !scoreAxes || Object.values(scoreAxes).some(axis => axis?.dataOk !== false);
      const rawPrice = number(quote?.price?.current), rawScore = supportedScore ? number(cached?.score?.total) : null;
      const price = rawPrice != null && rawPrice > 0 ? rawPrice : null;
      const score = rawScore != null && rawScore >= 0 && rawScore <= 100 ? rawScore : null;
      const quoteAt = price == null ? null : timestamp(quote?.price?.regularMarketTime, true);
      return {
        ticker,
        name: text(quote?.company?.name) || text(cached?.company?.name) || (event?.company !== ticker ? text(event?.company) : null),
        price, currency: price == null ? null : text(quote?.price?.currency), changePercent: price == null ? null : number(quote?.price?.changePct),
        // Never present the response assembly time as the quote's market time.
        quoteAt, quoteFetchedAt: timestamp(quote?._quoteFetchedAt),
        quoteStatus: price == null ? 'unavailable' : quote.quoteRefreshFailed || !quoteAt || now - Date.parse(quoteAt) > 4 * 86400000 ? 'stale' : 'fresh',
        cachedAt, score, scoreAt: score == null ? null : cachedAt,
        scoreStatus: score == null ? 'unavailable' : !cachedAt || now - Date.parse(cachedAt) > 86400000 ? 'previous' : 'available',
        sparkline3m:threeMonthCurve(quote?.chart?.points,now) || threeMonthCurve(cached?.chart?.points,now),
        latestInsider: event ? {
          type: event.type, insider: text(event.insider), value: event.value,
          currency: text(event.currency), fileDate: event.fileDate, tradeDate: event.tradeDate, sourceUrl: event.sourceUrl,
          purchaseSignalEligible: event.purchaseSignalEligible, purchaseSignalStatus: event.purchaseSignalStatus, purchaseSignalReason: event.purchaseSignalReason,
        } : null,
      };
    }));
    result.items.push(...batch);
  }
  const historical = await recentHistoricalScores(env, result.items.filter(row => row.score == null).map(row => row.ticker), now);
  for (const row of result.items) {
    const saved = historical.get(row.ticker);
    if (saved) Object.assign(row, saved);
  }
  return result;
}
