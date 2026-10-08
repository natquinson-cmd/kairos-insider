import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeKairosScore, handleStockAnalysis } from '../src/stock-api.js';
import { validateInsiderScoringConfig, INSIDER_SCORING_DEFAULTS } from '../src/insider-score.js';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const DAY = 86400000;
const dateAgo = days => new Date(NOW - days * DAY).toISOString().slice(0, 10);
const transaction = (patch = {}) => ({ ticker: 'AAPL', insider: 'Alice Buyer', type: 'buy', date: dateAgo(0), fileDate: dateAgo(0), shares: 1000, value: 100000, currency: 'USD', source: 'sec', ...patch });
const score = (insiders, extra = {}) => computeKairosScore({ insiders, smartMoney: {}, govEtf: { inEtfs: [] }, quote: {}, fundamentals: {}, health: {}, earnings: {}, scoringNow: NOW, ...extra }).breakdown.insider;
const axis = (transactions, extra) => score({ transactions, dataAvailable: true }, extra);

test('a comparable purchase contributes approximately three times the sale penalty', () => {
  const buy = axis([transaction()]), sell = axis([transaction({ type: 'sell' })]);
  assert.ok(buy.score > 10 && sell.score < 10);
  assert.ok(buy.signals.buyStrength / sell.signals.salePenalty >= 3);
  assert.equal(buy.signals.buyStrength, sell.signals.saleStrength);
  assert.equal(sell.signals.salePenalty, sell.signals.saleStrength * 0.33);
});

test('an enormous sale cannot cancel a material cluster of distinct purchasers', () => {
  const buys = ['Alice', 'Bob', 'Chloe'].map(insider => transaction({ insider }));
  const alone = axis(buys), mixed = axis([...buys, transaction({ insider: 'Seller', type: 'sell', value: 1e12 })]);
  assert.equal(mixed.signals.buyStrength, alone.signals.buyStrength);
  assert.equal(mixed.signals.uniqueBuyers, 3);
  assert.equal(mixed.signals.convergence, true);
  assert.ok(mixed.score > 10);
});

test('duplicate filings are one purchase while distinct identified buyers stay distinct', () => {
  const original = transaction({ accession: 'one' });
  const duplicate = transaction({ accession: 'two', fileDate: dateAgo(-1) });
  const originalAxis = axis([original]);
  assert.deepEqual(axis([original, duplicate]).signals, originalAxis.signals);
  const distinct = axis([original, transaction({ insider: 'Bob' }), transaction({ insider: 'Chloe' })]);
  assert.equal(distinct.signals.uniqueBuyers, 3);
  assert.equal(distinct.signals.convergence, true);
  const unidentified = axis([transaction({ insider: '' }), transaction({ insider: '', shares: 2000 }), transaction({ insider: 'N/A', shares: 3000 })]);
  assert.equal(unidentified.signals.uniqueBuyers, 0);
  assert.equal(unidentified.signals.convergence, false);
});

test('repeated purchases require distinct trade dates by the same identified person', () => {
  const sameDay = axis([transaction(), transaction({ shares: 2000 })]);
  const repeated = axis([transaction(), transaction({ date: dateAgo(1) })]);
  assert.equal(sameDay.signals.repeatedBuyers, 0);
  assert.equal(repeated.signals.repeatedBuyers, 1);
  assert.ok(repeated.signals.repeatBonus > 0);
});

test('freshness follows the trade date and rejects future trades', () => {
  const fresh = axis([transaction()]);
  const aged = axis([transaction({ date: dateAgo(30) })]);
  assert.equal(aged.signals.effectiveBuyCount, fresh.signals.effectiveBuyCount / 2);
  const lateFiling = axis([transaction({ date: dateAgo(120), fileDate: dateAgo(0) })]);
  assert.equal(lateFiling.signals.convergence, false);
  assert.ok(lateFiling.signals.buyStrength < aged.signals.buyStrength);
  const future = axis([transaction({ date: dateAgo(-1) })]);
  assert.equal(future.score, 10);
  assert.equal(future.signals.buyCount, 0);
});

test('missing trade dates use a conservative filing fallback without convergence or repetition', () => {
  const fallback = axis(['Alice', 'Bob', 'Chloe'].map(insider => transaction({ insider, date: null })));
  assert.equal(fallback.signals.effectiveBuyCount, 0.75);
  assert.equal(fallback.signals.recentBuyers, 0);
  assert.equal(fallback.signals.convergence, false);
  assert.equal(fallback.signals.dateFallbackCount, 3);
  assert.equal(axis([transaction({ date: '2026-02-30', fileDate: null })]).dataOk, false);
});

test('absence is neutral, unavailable and undated legacy data are explicitly unavailable', () => {
  assert.equal(axis([]).score, 10);
  assert.equal(axis([]).dataOk, true);
  for (const insiders of [{}, { transactions: [], dataAvailable: false }, { buyCount: 100, sellCount: 0, uniqueInsiders: 50, netValueUsd: 1e9, clusterSignal: {} }]) {
    const result = score(insiders);
    assert.equal(result.score, 10);
    assert.equal(result.dataOk, false);
  }
});

test('exercises and grants never become purchases even if their broad type says buy', () => {
  const result = axis(['M', 'A', 'F', 'exercise', 'grant'].map(transactionCode => transaction({ transactionCode })));
  assert.equal(result.score, 10);
  assert.equal(result.signals.buyCount, 0);
  assert.equal(result.signals.uniqueBuyers, 0);
});

test('foreign currencies are never added as dollars and known FX is explicit', () => {
  const eur = transaction({ currency: 'EUR', value: 1e9 });
  const foreign = axis([eur]);
  assert.equal(foreign.signals.buyValueUsd, 0);
  assert.equal(foreign.signals.monetaryIncomplete, true);
  assert.equal(foreign.signals.buyTotalsByCurrency.EUR, 1e9);
  assert.equal(foreign.signals.buyAmountBonus, 0);
  assert.equal(axis([{ ...eur, fxRateToUsd: 1.1 }]).signals.buyValueUsd, 1.1e9);
  assert.equal(axis([transaction({ currency: '' })]).signals.buyAmountBonus, 0);
});

test('insider parameters change their own components without changing eight-axis weights', () => {
  const tx = [transaction({ type: 'sell' })];
  assert.equal(axis(tx, { insiderScoring: { saleWeight: 0 } }).score, 10);
  assert.equal(axis([transaction({ date: dateAgo(30) })], { insiderScoring: { halfLifeDays: 60 } }).signals.effectiveBuyCount, Math.SQRT1_2);
  const customized = axis([transaction()], { weights: { insider: 40 }, insiderScoring: { saleWeight: 0.5 } });
  assert.equal(customized.max, 40);
  assert.equal(customized.score, 25); // (10 + 2 USD-magnitude + 0.4 buyer) / 20 * 40, rounded.
});

test('configuration rejects unsafe values and malformed saved config safely uses defaults', () => {
  assert.deepEqual(validateInsiderScoringConfig({ saleWeight: 0.5 }), { saleWeight: 0.5, halfLifeDays: 30, convergenceWindowDays: 30 });
  for (const input of [null, [], true, { saleWeight: -1 }, { saleWeight: 1.1 }, { saleWeight: '0.33' }, { saleWeight: NaN },
    { halfLifeDays: 0 }, { halfLifeDays: 181 }, { halfLifeDays: 14.5 }, { convergenceWindowDays: 6 }, { convergenceWindowDays: 91 }, { convergenceWindowDays: Infinity }, { unknown: 3 }]) {
    assert.throws(() => validateInsiderScoringConfig(input));
  }
  assert.deepEqual(axis([transaction()], { insiderScoring: { saleWeight: 'broken' } }).signals.parameters, INSIDER_SCORING_DEFAULTS);
});

test('convergence window excludes old trades and unconverted market cap never suppresses dollar evidence', () => {
  const purchases = ['Alice', 'Bob', 'Chloe'].map(insider => transaction({ insider, date: dateAgo(20) }));
  assert.equal(axis(purchases).signals.convergence, true);
  assert.equal(axis(purchases, { insiderScoring: { convergenceWindowDays: 14 } }).signals.convergence, false);
  const foreignCap = axis([transaction()], { fundamentals: { marketCap: 1e12, marketCapCurrency: 'EUR' } });
  assert.equal(foreignCap.signals.buyAmountBonus, axis([transaction()]).signals.buyAmountBonus);
  const dollarCap = axis([transaction()], { fundamentals: { marketCap: 1e12, marketCapCurrency: 'USD' } });
  assert.ok(dollarCap.signals.buyAmountBonus < foreignCap.signals.buyAmountBonus);
});

test('splitting a same-person purchase into filing rows does not increase its score', () => {
  const one = axis([transaction({ value: 1000000, shares: 10000 })]);
  const split = axis(Array.from({ length: 10 }, (_, i) => transaction({ shares: 1000, price: 99.5 + i / 10, value: 100000 })));
  assert.equal(split.signals.buyStrength, one.signals.buyStrength);
  assert.equal(split.signals.effectiveBuyCount, 1);
});

test('repeated rows from one buyer cannot masquerade as ten distinct buyers', () => {
  const repeated = axis(Array.from({ length: 10 }, (_, i) => transaction({ date: dateAgo(i) })));
  const distinct = axis(Array.from({ length: 10 }, (_, i) => transaction({ insider: 'Buyer ' + i, date: dateAgo(i) })));
  assert.equal(repeated.signals.effectiveBuyCount, 1);
  assert.ok(distinct.signals.effectiveBuyCount > 8);
  assert.equal(repeated.signals.convergence, false);
  assert.equal(distinct.signals.convergence, true);
});

test('a known identity remains the same buyer when a duplicate omits its CIK', () => {
  const identified = transaction({ insiderCik: '00012345' });
  const result = axis([identified, transaction({ accession: 'amendment' }), transaction({ date: dateAgo(1) })]);
  assert.equal(result.signals.buyCount, 2);
  assert.equal(result.signals.uniqueBuyers, 1);
  assert.equal(result.signals.repeatedBuyers, 1);
});

test('reversed name aliases and ambiguous shared names cannot create additional buyers', () => {
  const alias = axis([transaction({ insiderCik: '1', insider: 'Alice Doe' }), transaction({ insider: 'Doe, Alice', date: dateAgo(1) })]);
  assert.equal(alias.signals.uniqueBuyers, 1);
  const ambiguous = axis([transaction({ insiderCik: '1' }), transaction({ insiderCik: '2', value: 200000 }), transaction({ value: 300000 })]);
  assert.equal(ambiguous.signals.uniqueBuyers, 2);
  assert.equal(ambiguous.signals.convergence, false);
});

test('an optional price in a duplicate does not count the same purchase twice', () => {
  const original = transaction({ insiderCik: '1' }), enriched = { ...original, price: 100 };
  for (const rows of [[original, enriched], [enriched, original]]) {
    assert.equal(axis(rows).signals.buyCount, 1);
    assert.equal(axis(rows).signals.buyValueUsd, 100000);
    assert.equal(axis(rows).signals.buyStrength, 2.4);
  }
});

test('equivalent foreign duplicates retain verified dollar enrichment regardless of order', () => {
  const native = transaction({ currency: 'EUR' });
  for (const enriched of [{ ...native, valueUsd: 110000 }, { ...native, fxRateToUsd: 1.1 }]) {
    assert.deepEqual(axis([native, enriched]).signals, axis([enriched, native]).signals);
    assert.ok(Math.abs(axis([native, enriched]).signals.buyValueUsd - 110000) < 1e-6);
    assert.equal(axis([native, enriched]).signals.monetaryIncomplete, false);
  }
});

test('unknown actors in separate filings cannot be merged solely by matching economic values', () => {
  const a = transaction({ insider: '', accession: 'one' }), b = { ...a, accession: 'two' };
  const result = axis([a, { ...a }, b]);
  assert.equal(result.signals.buyCount, 2);
  assert.equal(result.signals.uniqueBuyers, 0);
});

test('future filings and impossible chronology cannot create purchase conviction', () => {
  for (const row of [transaction({ fileDate: dateAgo(-1) }), transaction({ fileDate: dateAgo(1) })]) {
    assert.equal(axis([row]).signals.buyCount, 0);
    assert.equal(axis([row]).dataOk, false);
  }
  const valid = transaction(), invalidRicherCopy = transaction({ price: 100, fileDate: dateAgo(-1) });
  assert.deepEqual(axis([invalidRicherCopy, valid]).signals, axis([valid]).signals);
  assert.equal(axis([transaction({ fileDate: null })]).signals.buyCount, 1);
});

test('fresh stock assembly scores every transaction before truncation and loads independent config', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 404 }));
  const today = new Date().toISOString().slice(0, 10);
  const transactions = Array.from({ length: 55 }, (_, i) => transaction({ insider: 'Buyer ' + i, date: today, fileDate: today, shares: i + 1 }));
  const store = new Map([
    ['yahoo-search:v4:AAPL', { symbol: 'AAPL' }],
    ['insider-transactions', { transactions }],
    ['config:insider-scoring', { saleWeight: 0.2, halfLifeDays: 60, convergenceWindowDays: 14 }],
    ['stock-analysis:v23:AAPL:full:1y', { _cachedAt: Date.now(), obsoleteFormula: true }],
  ]);
  const env = { CACHE: { async get(key) { return store.get(key) ?? null; }, async put(key, value) { store.set(key, JSON.parse(value)); } } };
  const result = await handleStockAnalysis('AAPL', env);
  assert.equal(result.obsoleteFormula, undefined);
  assert.equal(result.insiders.transactions.length, 50);
  assert.equal(result.score.breakdown.insider.signals.uniqueBuyers, 55);
  assert.equal(result.score.breakdown.insider.signals.parameters.halfLifeDays, 60);
});
