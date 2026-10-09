const DAY_MS = 86_400_000;
const number = value => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const positive = value => {
  const parsed = number(value);
  return parsed != null && parsed > 0 ? parsed : null;
};
const epoch = seconds => {
  const parsed = positive(seconds);
  return parsed != null && parsed <= 8_640_000_000_000 ? parsed * 1000 : null;
};
function dateDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value)) return null;
  const date = value.slice(0, 10);
  const parsed = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === date ? parsed / DAY_MS : null;
}
function pointTime(point) {
  const timestamp = epoch(point?.timestamp);
  if (timestamp != null) return timestamp;
  if (typeof point?.date !== 'string' || !point.date.includes('T') || dateDay(point.date) == null) return null;
  const value = /(?:Z|[+-]\d{2}:\d{2})$/.test(point.date) ? point.date : `${point.date}Z`;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function localDay(timestamp, meta) {
  if (typeof meta.exchangeTimezoneName === 'string') {
    try {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: meta.exchangeTimezoneName, year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(timestamp).map(part => [part.type, part.value]));
      const parsed = dateDay(`${parts.year}-${parts.month}-${parts.day}`);
      if (parsed != null) return parsed;
    } catch {}
  }
  const offset = number(meta.gmtoffset);
  return Math.floor((timestamp + (offset != null && Math.abs(offset) <= 86_400 ? offset * 1000 : 0)) / DAY_MS);
}

/**
 * Calculate daily change only from an explicit close or a recent prior session.
 * Supply original Yahoo timestamps when possible to retain exchange-local dates.
 * No historical point is added, repaired, rescaled or mutated by this helper.
 */
export function normalizeQuoteHistory({ meta = {}, points = [], isIntraday = false, range } = {}) {
  meta = meta || {};
  points = Array.isArray(points) ? points : [];
  const marketTime = epoch(meta.regularMarketTime);
  const timedPoints = points.some(point => pointTime(point) != null);
  const marketDay = marketTime == null ? null : timedPoints ? localDay(marketTime, meta) : Math.floor(marketTime / DAY_MS);
  const dated = points.map(point => {
    const timestamp = pointTime(point);
    return { day: timestamp != null ? localDay(timestamp, meta) : dateDay(point?.date), close: positive(point?.close) };
  }).filter(point => point.day != null && marketDay != null && point.day <= marketDay)
    .sort((left, right) => right.day - left.day);
  const lastObserved = dated.find(point => point.close != null);
  const historyComparable = !!lastObserved && marketDay - lastObserved.day <= 7;

  let previousClose = positive(meta.regularMarketPreviousClose) ?? positive(meta.previousClose);
  if (previousClose == null && isIntraday && range === '1d') previousClose = positive(meta.chartPreviousClose);
  if (previousClose == null && !isIntraday && marketDay != null) {
    // Keep a missing immediate session missing instead of skipping to an older one.
    const previous = dated.find(point => point.day < marketDay);
    if (previous && marketDay - previous.day <= 7) previousClose = previous.close;
  }
  const current = positive(meta.regularMarketPrice);
  const change = current != null && previousClose != null ? current - previousClose : null;
  const changePct = change != null ? change / previousClose * 100 : null;
  return { previousClose, change, changePct, historyComparable };
}
