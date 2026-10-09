import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuoteHistory } from '../src/quote-history-quality.js';

const time = date => Date.parse(date) / 1000;
const quote = { regularMarketPrice: 105, regularMarketTime: time('2026-10-09T16:00:00Z') };
const normalize = (meta, points, options = {}) => normalizeQuoteHistory({ meta, points, isIntraday: false, range: '1y', ...options });

test('daily reference is the latest earlier dated session whether the chart includes today or not', () => {
  const points = [{ date: '2026-10-07', close: 90 }, { date: '2026-10-08', close: 100 }];
  assert.deepEqual(normalize(quote, points), { previousClose: 100, change: 5, changePct: 5, historyComparable: true });
  assert.deepEqual(normalize(quote, [...points, { date: '2026-10-09', close: 105 }]), { previousClose: 100, change: 5, changePct: 5, historyComparable: true });
});

test('stale daily history cannot manufacture the observed VRME multi-thousand-percent daily return', () => {
  const points = [{ date: '2026-09-15', close: .7195 }, { date: '2026-09-16', close: .7 }];
  const original = structuredClone(points);
  assert.deepEqual(normalize({ ...quote, regularMarketPrice: 8.98 }, points), { previousClose: null, change: null, changePct: null, historyComparable: false });
  assert.deepEqual(points, original);
});

test('a real metadata previous close remains usable even when the chart is stale or quote time is absent', () => {
  for (const regularMarketTime of [quote.regularMarketTime, null, 'bad']) {
    const r = normalize({ regularMarketPrice: 8.98, previousClose: 8.98, regularMarketTime }, [{ date: '2026-09-16', close: .7 }]);
    assert.deepEqual(r, { previousClose: 8.98, change: 0, changePct: 0, historyComparable: false });
  }
  assert.equal(normalize({ ...quote, previousClose: 90, regularMarketPreviousClose: 100 }, []).previousClose, 100);
});

test('weekends and a seven-day gap are allowed but an eight-day gap is stale', () => {
  const monday = { regularMarketPrice: 100, regularMarketTime: time('2026-10-12T16:00:00Z') };
  assert.equal(normalize(monday, [{ date: '2026-10-09', close: 100 }]).changePct, 0);
  assert.equal(normalize(quote, [{ date: '2026-10-02', close: 100 }]).historyComparable, true);
  assert.deepEqual(normalize(quote, [{ date: '2026-10-01', close: 100 }]), { previousClose: null, change: null, changePct: null, historyComparable: false });
});

test('intraday change never compares against an earlier intraday bar or a five-day chart start', () => {
  const points = [{ date: '2026-10-09T15:55', close: 104 }, { date: '2026-10-09T16:00', close: 105 }];
  assert.equal(normalize({ ...quote, chartPreviousClose: 100 }, points, { isIntraday: true, range: '1d' }).changePct, 5);
  assert.equal(normalize({ ...quote, chartPreviousClose: 100 }, points, { isIntraday: true, range: '5d' }).changePct, null);
  assert.equal(normalize({ ...quote, previousClose: 100 }, points, { isIntraday: true, range: '5d' }).changePct, 5);
  assert.equal(normalize(quote, points, { isIntraday: true, range: '1d' }).changePct, null);
});

test('a one-year chartPreviousClose is never a daily close and missing quote date does not imply today', () => {
  const points = [{ date: '2026-10-08', close: 100 }];
  assert.equal(normalize({ regularMarketPrice: 105, chartPreviousClose: 20 }, points).previousClose, null);
  assert.equal(normalize({ ...quote, chartPreviousClose: 20 }, points).previousClose, 100);
});

test('invalid and missing immediate closes are not replaced by a different older session', () => {
  for (const close of [null, '', false, 0, -1, Infinity, 'bad']) {
    const points = [{ date: '2026-10-07', close: 90 }, { date: '2026-10-08', close }];
    assert.equal(normalize({ ...quote, previousClose: close }, points).previousClose, null);
  }
  const r = normalize({ ...quote, regularMarketPrice: '105', previousClose: '100' }, []);
  assert.equal(r.changePct, 5);
  assert.equal(normalize({ ...quote, regularMarketPrice: false, previousClose: 100 }, []).change, null);
});

test('future or invalid point dates cannot become a daily reference', () => {
  const r = normalize(quote, [{ date: '2026-10-10', close: 101 }, { date: '2026-02-30', close: 90 }, { date: 'bad', close: 80 }]);
  assert.equal(r.previousClose, null);
  assert.equal(r.historyComparable, false);
});

test('original timestamps respect the exchange-local day for Australian sessions across UTC midnight', () => {
  const meta = { regularMarketPrice: 126, regularMarketTime: time('2026-10-08T05:00:00Z'), gmtoffset: 39600 };
  const points = [
    { date: '2026-10-06', timestamp: time('2026-10-06T23:00:00Z'), close: 120 },
    { date: '2026-10-07', timestamp: time('2026-10-07T23:00:00Z'), close: 126 },
  ];
  assert.equal(normalize(meta, points).previousClose, 120);
  assert.equal(normalize(meta, points).changePct, 5);
});
