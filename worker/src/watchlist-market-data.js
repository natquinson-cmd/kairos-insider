// Lightweight public market snapshots. Reading a watchlist never launches a
// full stock analysis or writes user, subscription, quota or alert records.
export const STOCK_ANALYSIS_VERSION = 'v27';
export const STOCK_SUMMARY_PREFIX = `stock-summary:${STOCK_ANALYSIS_VERSION}:`;
const QUOTE_PREFIX = 'watchlist-quote:v1:';
const FRESH_MS = 5 * 60 * 1000;
const RETENTION_SECONDS = 7 * 86400;
const numeric = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
const validSymbol = v => typeof v === 'string' && /^[A-Z0-9][A-Z0-9.\-]{0,11}$/.test(v);

export async function storeStockSummarySnapshot(env, result) {
  const ticker = result?.ticker;
  if (!validSymbol(ticker) || result.error || !numeric(result._cachedAt)) return;
  if (result.score?.breakdown && !Object.values(result.score.breakdown).some(axis => axis?.dataOk === true)) return;
  const key = STOCK_SUMMARY_PREFIX + ticker;
  const previous = await env.CACHE.get(key, 'json').catch(() => null);
  if (previous?.ticker === ticker && numeric(previous._cachedAt) >= result._cachedAt) return;
  // The analysis cache may expire after 15 min; this small dated projection
  // survives it. A method-version key prevents resurrecting obsolete scores.
  const snapshot = {
    ticker, company: {name: result.company?.name || ticker},
    price: result.price ? {
      current: result.price.current, currency: result.price.currency,
      changePct: result.price.changePct, regularMarketTime: result.price.regularMarketTime,
    } : null,
    score: {total: result.score?.total ?? null}, _cachedAt: result._cachedAt,
  };
  await env.CACHE.put(key, JSON.stringify(snapshot), {expirationTtl: RETENTION_SECONDS});
}

function validQuote(row, ticker) {
  return row?.ticker === ticker && numeric(row.price?.current) > 0;
}

function marketProjection(row, fetchedAt) {
  return row && {
    ticker: row.ticker, company: {name: row.company?.name || row.ticker},
    price: row.price ? {current: row.price.current, currency: row.price.currency,
      changePct: row.price.changePct, regularMarketTime: row.price.regularMarketTime} : null,
    chart: {points: (Array.isArray(row.chart?.points) ? row.chart.points : []).slice(-96)
      .map(point => ({date: point.date, close: point.close}))}, _quoteFetchedAt: fetchedAt,
  };
}

function quoteFromChart(result, ticker, now) {
  const meta = result?.meta;
  // Do not let provider redirects silently substitute another listing.
  if (String(meta?.symbol || '').toUpperCase() !== ticker || !(numeric(meta.regularMarketPrice) > 0)) return null;
  const marketTime = numeric(meta.regularMarketTime);
  const quoteTime = marketTime > 0 && marketTime * 1000 <= now + FRESH_MS ? marketTime : null;
  const utcOffset = Math.abs(numeric(meta.gmtoffset) || 0) <= 18 * 3600 ? numeric(meta.gmtoffset) || 0 : 0;
  const tradingDay = seconds => new Date((seconds + utcOffset) * 1000).toISOString().slice(0, 10);
  const quoteDay = quoteTime ? tradingDay(quoteTime) : null;
  const closes = result.indicators?.quote?.[0]?.close || [];
  const sessions = (Array.isArray(result.timestamp) ? result.timestamp : []).map((ts, i) => {
    if (!(numeric(ts) > 0) || ts * 1000 > now + FRESH_MS) return null;
    return {date: tradingDay(ts), close: numeric(closes[i]) > 0 ? closes[i] : null};
  }).filter(Boolean).sort((a,b) => a.date.localeCompare(b.date));
  const points = sessions.filter(row => row.close != null);
  // chartPreviousClose is the start of the 3-month range, not yesterday.
  const previous = numeric(meta.regularMarketPreviousClose) > 0 ? meta.regularMarketPreviousClose
    : quoteDay ? sessions.filter(p => p.date < quoteDay).at(-1)?.close : null;
  const changePct = quoteTime && previous > 0 ? (meta.regularMarketPrice - previous) / previous * 100 : null;
  return {
    ticker, company: {name: meta.longName || meta.shortName || ticker},
    price: {current: meta.regularMarketPrice, currency: typeof meta.currency === 'string' ? meta.currency : null,
      changePct, regularMarketTime: quoteTime}, chart: {points}, _quoteFetchedAt: now,
  };
}

export async function readWatchlistQuote(env, ticker, analysis, now, allowRefresh = true) {
  const key = QUOTE_PREFIX + ticker;
  const saved = await env.CACHE.get(key, 'json').catch(() => null);
  const candidates = [marketProjection(saved, saved?._quoteFetchedAt), marketProjection(analysis, analysis?._cachedAt)]
    .filter(row => validQuote(row, ticker) && numeric(row._quoteFetchedAt) > 0
      && now - row._quoteFetchedAt >= 0 && now - row._quoteFetchedAt < RETENTION_SECONDS * 1000);
  // Prefer the most recent market observation, then the most recent retrieval.
  candidates.sort((a,b) => (numeric(b.price.regularMarketTime) || 0) - (numeric(a.price.regularMarketTime) || 0)
    || (numeric(b._quoteFetchedAt) || 0) - (numeric(a._quoteFetchedAt) || 0));
  const fallback = candidates[0] || null;
  const recent = fallback && now - fallback._quoteFetchedAt >= 0 && now - fallback._quoteFetchedAt < FRESH_MS;
  if (recent) return {...fallback, quoteRefreshFailed: false};
  if (saved?._retryAfter > now || !(typeof allowRefresh === 'function' ? allowRefresh() : allowRefresh)) return fallback ? {...fallback, quoteRefreshFailed: true} : null;
  try {
    const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=3mo&interval=1d`, {
      headers: {'User-Agent': 'Mozilla/5.0', Accept: 'application/json'}, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Quote provider unavailable');
    const body = await response.json();
    const quote = quoteFromChart(body?.chart?.result?.[0], ticker, now);
    if (!quote) throw new Error('Invalid quote');
    // A stale provider reply must not replace a more recent market observation.
    if (fallback?.price?.regularMarketTime > (quote.price.regularMarketTime || 0)) throw new Error('Older quote');
    if (quote.chart.points.length < 2 && fallback?.chart?.points?.length >= 2) quote.chart = fallback.chart;
    await env.CACHE.put(key, JSON.stringify(quote), {expirationTtl: RETENTION_SECONDS}).catch(() => {});
    return {...quote, quoteRefreshFailed: false};
  } catch {
    // Cache only the retry cooldown, retaining the last valid dated quote.
    const retry = {...(fallback || {ticker}), _retryAfter: now + 60000};
    await env.CACHE.put(key, JSON.stringify(retry), {expirationTtl: fallback ? RETENTION_SECONDS : 60}).catch(() => {});
    return fallback ? {...fallback, quoteRefreshFailed: true} : null;
  }
}
