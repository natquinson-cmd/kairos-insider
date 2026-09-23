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
  const result = {ok: true, exists, cacheOnly: true, items: [], updatedAt: new Date(now).toISOString()};
  if (!tickers.length) return result;

  const feed = await env.CACHE.get('insider-transactions', 'json').catch(() => null);
  const wanted = new Set(tickers), latest = new Map(), today = result.updatedAt.slice(0, 10);
  for (const row of Array.isArray(feed?.transactions) ? feed.transactions : []) {
    const event = normalizeInsiderMovement(row);
    if (!event || !wanted.has(event.ticker) || event.fileDate > today) continue;
    const previous = latest.get(event.ticker);
    if (!previous || event.fileDate > previous.fileDate ||
        event.fileDate === previous.fileDate && (event.tradeDate || '') > (previous.tradeDate || '')) latest.set(event.ticker, event);
  }

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
