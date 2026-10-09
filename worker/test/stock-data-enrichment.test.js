import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeAvailableNumbers, enrichYahooFinancials, buildEstimatedHealth } from '../src/stock-data-enrichment.js';

const context = { ticker: 'TEST', requestedTicker: 'TEST', quoteCurrency: 'USD', financialCurrency: 'USD' };

test('available merges keep prior observations through empty provider values and preserve zero', () => {
  const first = { marketCap: 400, eps: 2, beta: 1, currency: 'USD', recommendationKey: 'buy' };
  const merged = mergeAvailableNumbers(first, { marketCap: null, eps: '', beta: 0, currency: ' ', recommendationKey: 'N/A' }, { eps: '3.5', newField: Infinity });
  assert.deepEqual(merged, { marketCap: 400, eps: 3.5, beta: 0, currency: 'USD', recommendationKey: 'buy' });
  assert.equal(first.beta, 1);
  for (const value of [null, undefined, '', ' ', '-', '—', 'N/A', 'NaN', 'Infinity', '-Infinity', '1e309', NaN, Infinity, false]) {
    assert.equal(mergeAvailableNumbers({ value: 42 }, { value }).value, 42);
  }
});

test('Yahoo fills absent observations with their units and source without changing primary values', () => {
  const input = { fundamentals: { currency: 'USD', peRatio: 22, beta: 0 }, extendedRatios: { ps: 4 }, margins: { profit: { numeric: 18, display: '18.00%', source: 'stockanalysis' } } };
  const original = structuredClone(input);
  const result = enrichYahooFinancials(input, { ...context, marketCap: 12e9, revenue: 8e9, freeCashFlow: 0, peRatio: 33, psRatio: 7, beta: 2, eps: -2, dividendPerShare: 0, sharesOut: 100e6, profitMargin: .2, grossMargin: .4, roe: .15, debtToEquity: 125, currentRatio: 1.5 });
  assert.deepEqual(input, original);
  assert.equal(result.fundamentals.marketCap, 12e9);
  assert.equal(result.fundamentals.marketCapCurrency, 'USD');
  assert.equal(result.fundamentals.revenue, 8e9);
  assert.equal(result.fundamentals.freeCashFlow, 0);
  assert.equal(result.fundamentals.peRatio, 22);
  assert.equal(result.fundamentals.beta, 0);
  assert.equal(result.fundamentals.eps, -2);
  assert.equal(result.fundamentals.dividendPerShare, 0);
  assert.equal(result.fundamentals.sharesOut, 100e6);
  assert.equal(result.extendedRatios.ps, 4);
  assert.equal(result.margins.profit.numeric, 18);
  assert.equal(result.margins.gross.numeric, 40);
  assert.equal(result.margins.gross.display, '40.00%');
  assert.equal(result.returns.roe.numeric, 15);
  assert.equal(result.financialPosition.debtEquity.numeric, 1.25);
  assert.deepEqual(result.fundamentals._sources.revenue, { source: 'yahoo', symbol: 'TEST', currency: 'USD', unit: 'currency' });
  assert.equal(result.fundamentals._sources.peRatio, undefined);
  assert.equal(result.margins.gross.source, 'yahoo');
  assert.equal(result.margins.gross.unit, 'percent');
});

test('Yahoo percentages retain API fractions or convert to displayed percent according to the field', () => {
  const r = enrichYahooFinancials({}, { ...context, dividendYield: .025, payoutRatio: .3, profitMargin: .2, revenueGrowth: .1, earningsGrowth: -.2, insiderOwnership: .015, institutionalOwnership: .8, grossMargin: 0, operatingMargin: -.05, ebitdaMargin: .12, roa: -.01, quickRatio: 0, debtToEquity: 0, evEbitda: 15, evSales: 4 });
  assert.equal(r.fundamentals.dividendYield, .025);
  assert.equal(r.fundamentals.payoutRatio, .3);
  assert.equal(r.fundamentals.profitMargin, .2);
  assert.equal(r.fundamentals.revenueGrowth, .1);
  assert.equal(r.fundamentals.earningsGrowth, -.2);
  assert.equal(r.fundamentals.insiderOwnership, 1.5);
  assert.equal(r.fundamentals.institutionalOwnership, 80);
  assert.equal(r.margins.gross.numeric, 0);
  assert.equal(r.margins.operating.numeric, -5);
  assert.equal(r.margins.ebitda.numeric, 12);
  assert.equal(r.returns.roa.numeric, -1);
  assert.equal(r.financialPosition.quickRatio.numeric, 0);
  assert.equal(r.financialPosition.debtEquity.numeric, 0);
  assert.equal(r.extendedRatios.evEbitda, 15);
  assert.equal(r.extendedRatios.evSales, 4);
});

test('reporting currency mismatch prevents financial amounts and EPS being labelled with quote currency', () => {
  const r = enrichYahooFinancials({ fundamentals: { currency: 'USD' } }, { ...context, financialCurrency: 'EUR', marketCap: 12e9, revenue: 8e9, netIncome: 1e9, freeCashFlow: 2e9, eps: 3, dividendPerShare: 1, profitMargin: .2, roe: .1 });
  assert.equal(r.fundamentals.marketCap, 12e9);
  assert.equal(r.fundamentals.dividendPerShare, 1);
  for (const key of ['revenue', 'netIncome', 'freeCashFlow', 'eps']) assert.equal(r.fundamentals[key], undefined, key);
  assert.equal(r.margins.profit.numeric, 20);
  assert.equal(r.returns.roe.numeric, 10);
});

test('quote currency mismatch, missing currencies and subunit currencies are not silently converted', () => {
  for (const [currency, quoteCurrency, financialCurrency] of [['EUR', 'USD', 'USD'], ['GBp', 'GBP', 'GBP'], ['USD', undefined, undefined]]) {
    const r = enrichYahooFinancials({ fundamentals: { currency } }, { ...context, quoteCurrency, financialCurrency, marketCap: 12e9, enterpriseValue: 15e9, revenue: 8e9, eps: 4, dividendPerShare: 2, high52w: 90, peRatio: 22 });
    for (const key of ['marketCap', 'enterpriseValue', 'revenue', 'eps', 'dividendPerShare', 'high52w']) assert.equal(r.fundamentals[key], undefined, `${currency}: ${key}`);
    assert.equal(r.fundamentals.peRatio, 22);
  }
});

test('listing mismatch prevents ADR shares, EPS and price ranges being copied onto the local listing', () => {
  const r = enrichYahooFinancials({ fundamentals: { currency: 'USD' } }, { ...context, ticker: 'ADR', requestedTicker: 'LOCAL', sharesOut: 1e6, sharesFloat: 9e5, eps: 4, dividendPerShare: 2, high52w: 80, low52w: 40, sma50: 60, sma200: 50, peRatio: 20, roe: .1 });
  for (const key of ['sharesOut', 'sharesFloat', 'eps', 'dividendPerShare', 'high52w', 'low52w', 'sma50', 'sma200']) assert.equal(r.fundamentals[key], undefined, key);
  assert.equal(r.fundamentals.peRatio, 20);
  assert.equal(r.returns.roe.numeric, 10);
  const unknown = enrichYahooFinancials({}, { quoteCurrency: 'USD', financialCurrency: 'USD', eps: 2, sharesOut: 1e6 });
  assert.equal(unknown.fundamentals.eps, undefined);
  assert.equal(unknown.fundamentals.sharesOut, undefined);
});

test('missing or invalid Yahoo fields do not invent observations, derived ratios or health scores', () => {
  const r = enrichYahooFinancials({}, { ...context, marketCap: Infinity, roe: true, grossMargin: '', profitMargin: 'N/A', debtToEquity: NaN, currentRatio: {}, sharesOut: -1, sharesFloat: 0 });
  for (const key of ['marketCap', 'sharesOut', 'sharesFloat', 'pfcfRatio', 'netCash']) assert.equal(r.fundamentals[key], undefined, key);
  assert.deepEqual(r.margins, {});
  assert.deepEqual(r.returns, {});
  assert.deepEqual(r.financialPosition, {});
  assert.equal(buildEstimatedHealth(r), null);
});

test('health uses available raw observations and the actual seven existing criteria thresholds', () => {
  const result = buildEstimatedHealth({ margins: { profit: { numeric: 0, source: 'yahoo' }, gross: { raw: 20 }, operating: { numeric: 3 } }, returns: { roa: { numeric: -1 }, roe: { raw: 2 } }, financialPosition: { currentRatio: { numeric: 1 }, debtEquity: { numeric: 0, source: 'yahoo' } } });
  assert.equal(result.score, 4);
  assert.equal(result.total, 7);
  assert.equal(result.ratio, 57);
  assert.equal(result.zone, 'mid');
  assert.equal(result.source, 'kairos');
  assert.equal(result.estimated, true);
  assert.deepEqual(result.criteria.map(c => c.value), [0, -1, 2, 20, 3, 1, 0]);
  assert.deepEqual(result.criteria.map(c => c.ok), [false, false, true, true, true, false, true]);
  assert.equal(result.criteria.at(-1).threshold, 2);
  assert.equal(result.criteria.at(-1).minimum, 0);
  assert.equal(result.criteria.at(-1).unit, 'ratio');
  assert.equal(result.criteria.at(-1).source, 'yahoo');
});

test('health needs four observed criteria and never treats placeholders as observations', () => {
  const input = { margins: { profit: { numeric: 1 }, gross: { numeric: 2 }, operating: { raw: 3 } }, returns: { roe: { numeric: Infinity }, roa: { numeric: true } }, financialPosition: { currentRatio: { numeric: '' } } };
  assert.equal(buildEstimatedHealth(input), null);
  input.financialPosition.debtEquity = { numeric: -1 };
  const health = buildEstimatedHealth(input);
  assert.equal(health.total, 4);
  assert.equal(health.score, 3);
  assert.equal(health.criteria.at(-1).ok, false);
  assert.equal(health.altmanZ, undefined);
  assert.equal(health.piotroskiF, undefined);
});
