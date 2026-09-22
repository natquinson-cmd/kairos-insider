import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeKairosScore, handleStockAnalysis } from '../src/stock-api.js';

const base = { insiders: {}, smartMoney: {}, govEtf: { inEtfs: [] }, quote: {}, fundamentals: {}, earnings: {} };
const scoreHealth = (health, weights) => computeKairosScore({ ...base, health, weights }).breakdown.health;

test('supplied Kairos criteria supply an explicitly estimated health axis with admin weights', () => {
  const health = { kairosScore: { score: '6', total: '7', ratio: 86, criteria: [{ ok: true, label: 'Supplied criterion' }] } };
  const axis = scoreHealth(health, { health: 21 });
  assert.equal(axis.dataOk, true);
  assert.equal(axis.score, 18);
  assert.equal(axis.max, 21);
  assert.equal(axis.estimated, true);
  assert.equal(axis.source, 'kairos');
  assert.match(axis.detail, /estimée.*6\/7/);
  assert.equal(health.altmanZ, undefined);
  assert.equal(health.piotroskiF, undefined);
});

test('health fallback accepts zero and percentage-only cached scores without inventing missing data', () => {
  for (const [kairosScore, expected] of [[{ score: 0, total: 7 }, 0], [{ ratio: '60' }, 6]]) {
    const axis = scoreHealth({ kairosScore });
    assert.equal(axis.dataOk, true);
    assert.equal(axis.score, expected);
  }
  for (const kairosScore of [{}, { score: 2, total: 0 }, { score: 8, total: 7 }, { score: -1, total: 7 }, { ratio: Infinity }, { ratio: 'N/A' }, { ratio: true }, { ratio: -1 }, { ratio: 101 }]) {
    const axis = scoreHealth({ altmanZ: 'N/A', piotroskiF: Infinity, kairosScore });
    assert.equal(axis.dataOk, false, JSON.stringify(kairosScore));
    assert.equal(axis.detail, 'Scores indisponibles');
    assert.equal(axis.estimated, undefined);
  }
});

test('finite original health measures remain authoritative and accept cached numeric strings', () => {
  assert.deepEqual(scoreHealth({ altmanZ: '3.2', piotroskiF: '7', kairosScore: { ratio: 0 } }), scoreHealth({ altmanZ: 3.2, piotroskiF: 7 }));
  const zero = scoreHealth({ altmanZ: 0, kairosScore: { ratio: 100 } });
  assert.equal(zero.score, 2);
  assert.equal(zero.estimated, undefined);
});

test('fresh assembly uses cached provider criteria and stock cache preserves the resulting axis', async t => {
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async () => { fetches++; return new Response('{}', { status: 404 }); });
  const kairosScore = { score: 6, total: 7, ratio: 86, criteria: [{ ok: false, label: 'Liquidité générale > 1' }], source: 'kairos' };
  const store = new Map([
    ['yahoo-search:v4:AAPL', { symbol: 'AAPL' }],
    ['finnhub-metrics:v4:AAPL', { healthScore: kairosScore, fetchedAt: new Date().toISOString() }],
    ['config:score-weights', { health: 21 }],
    ['stock-analysis:v22:AAPL:full:1y', { _cachedAt: Date.now(), staleBeforeHealthFix: true }],
  ]);
  const env = { FINNHUB_KEY: 'test', CACHE: { async get(key) { return store.get(key) ?? null; }, async put(key, value) { store.set(key, JSON.parse(value)); } } };
  const current = await handleStockAnalysis('AAPL', env);
  assert.equal(current.staleBeforeHealthFix, undefined);
  assert.deepEqual(current.health.kairosScore, kairosScore);
  assert.equal(current.score.breakdown.health.dataOk, true);
  assert.equal(current.score.breakdown.health.score, 18);
  const beforeCacheRead = fetches;
  const cached = await handleStockAnalysis('AAPL', env);
  assert.deepEqual(cached.score.breakdown.health, current.score.breakdown.health);
  assert.equal(fetches, beforeCacheRead);
});

test('fresh health criteria expose real values and thresholds, preserve zero debt and reject nonfinite values', async t => {
  let debt = 0;
  t.mock.method(globalThis, 'fetch', async url => String(url).includes('/stock/metric?')
    ? new Response(JSON.stringify({ metric: { netProfitMarginTTM: '20', roaTTM: 12, roeTTM: true, grossMarginTTM: 'Infinity', operatingMarginTTM: 25, currentRatioAnnual: '', 'totalDebt/totalEquityAnnual': debt } }))
    : new Response('{}', { status: 404 }));
  for (const debtValue of [0, -1]) {
    debt = debtValue;
    const store = new Map([['yahoo-search:v4:AAPL', { symbol: 'AAPL' }], ['finnhub-metrics:v3:AAPL', { fetchedAt: new Date().toISOString(), healthScore: { score: 7, total: 7 } }]]);
    const env = { FINNHUB_KEY: 'test', CACHE: { async get(key) { return store.get(key) ?? null; }, async put(key, value) { store.set(key, JSON.parse(value)); } } };
    const result = await handleStockAnalysis('AAPL', env),criteria = result.health.kairosScore.criteria;
    assert.deepEqual(criteria.map(c => c.key), ['netMargin', 'roa', 'operatingMargin', 'debtEquity']);
    assert.deepEqual(criteria[0], { key: 'netMargin', value: 20, unit: 'percent', threshold: 0, comparison: '>', ok: true, label: 'Marge nette positive' });
    assert.deepEqual(criteria.at(-1), { key: 'debtEquity', value: debtValue, unit: 'ratio', threshold: 2, comparison: '<', minimum: 0, ok: debtValue === 0, label: 'Endettement maîtrisé' });
    assert.equal(result.health.kairosScore.score, debtValue === 0 ? 4 : 3);
    assert.equal(result.health.kairosScore.total, 4);
  }
});
