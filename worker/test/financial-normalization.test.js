import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeDividendYield,
  normalizeEarningsHistory,
  normalizeEarningsRecord,
  normalizeStockAnalysisEarningsRecord,
  summarizeEarningsBeats,
} from '../src/financial-normalization.js';
import { canonicalizeFundIdentity, summarizeReportDates } from '../src/fund-identity.js';

test('derives an earnings surprise percentage from actual and consensus EPS', () => {
  assert.ok(Math.abs(normalizeEarningsRecord({ actual: 2.02, estimate: 1.89 }).surprisePct - 6.8783068783) < 1e-9);
  assert.ok(Math.abs(normalizeEarningsRecord({ actual: 2.01, estimate: 1.94 }).surprisePct - 3.6082474227) < 1e-9);
});

test('does not produce a surprise for a missing or zero consensus', () => {
  assert.equal(normalizeEarningsRecord({ actual: 2.02, estimate: 0 }).surprisePct, null);
  assert.equal(normalizeEarningsRecord({ actual: 2.02, estimate: null }).surprisePct, null);
  assert.equal(normalizeEarningsRecord({ actual: 'not-a-number', estimate: 1.89 }).beat, null);
});

test('derives beat from valid EPS values independently of the provider surprise field', () => {
  assert.equal(normalizeEarningsRecord({ actual: 2.02, estimate: 1.89 }).beat, true);
  assert.equal(normalizeEarningsRecord({ actual: 1.8, estimate: 1.89 }).beat, false);
});

test('normalizes a StockAnalysis row when its provider surprise field is absent', () => {
  const row = normalizeStockAnalysisEarningsRecord({ eps_actual: 2.02, eps_est: 1.89, eps_surprise_percent: null });
  assert.ok(Math.abs(row.epsSurprisePct - 6.8783068783) < 1e-9);
  assert.equal(row.beat, true);
});

test('rejects blank and boolean EPS values instead of coercing them to zero', () => {
  assert.equal(normalizeEarningsRecord({ actual: ' ', estimate: 1.89 }).surprisePct, null);
  assert.equal(normalizeEarningsRecord({ actual: false, estimate: 1.89 }).beat, null);
  assert.equal(normalizeEarningsRecord({ actual: 2.02, estimate: true }).surprisePct, null);
  assert.equal(normalizeStockAnalysisEarningsRecord({ eps_actual: ' ', eps_est: 1.89 }).epsSurprisePct, null);
});

test('earnings beat summary ignores unknown results among the latest four', () => {
  assert.deepEqual(summarizeEarningsBeats([{ beat: null }, { beat: null }]), { available: 0, beats: 0 });
  assert.deepEqual(summarizeEarningsBeats([{ beat: true }, { beat: null }, { beat: false }, { beat: true }, { beat: true }]), { available: 3, beats: 2 });
});

test('renormalizes legacy cached Finnhub history from its EPS values', () => {
  const history = normalizeEarningsHistory([{ epsActual: '2.02', epsEst: '1.89', epsSurprisePct: 0.0688, beat: false }]);
  assert.ok(Math.abs(history[0].epsSurprisePct - 6.8783068783) < 1e-9);
  assert.equal(history[0].epsActual, 2.02);
  assert.equal(history[0].epsEst, 1.89);
  assert.equal(history[0].beat, true);
  assert.equal(normalizeEarningsHistory([{ epsActual: ' ', epsEst: 1.89 }])[0].epsActual, null);
});

test('normalizes provider dividend percentages to API fractions and preserves missing values', () => {
  assert.equal(normalizeDividendYield(0.004, 'fraction'), 0.004);
  assert.equal(normalizeDividendYield(0.4, 'percent'), 0.004);
  assert.equal(normalizeDividendYield(null, 'percent'), null);
  assert.equal(normalizeDividendYield('   ', 'percent'), null);
});

test('replaces known cached 13F aliases using the authoritative filer CIK', () => {
  assert.deepEqual(canonicalizeFundIdentity({ cik: '19617', fundName: 'Goldman Sachs Group', label: 'Goldman AM' }), {
    cik: '0000019617', fundName: 'JPMORGAN CHASE & CO', label: 'JPMorgan Chase', category: 'Bank Asset Manager',
  });
  assert.equal(canonicalizeFundIdentity({ cik: '0000914208', label: 'Jean Hynes' }).fundName, 'INVESCO LTD.');
});

test('repairs the two proven legacy aliases in compact cache rows that predate CIK storage', () => {
  assert.equal(canonicalizeFundIdentity({ fundName: 'Goldman Sachs Group', label: 'Goldman AM' }).label, 'JPMorgan Chase');
  assert.equal(canonicalizeFundIdentity({ fundName: 'Wellington Management', label: 'Jean Hynes' }).label, 'Invesco');
});

test('reports mixed 13F periods without merging or inventing a common period', () => {
  assert.deepEqual(summarizeReportDates([{ reportDate: '2026-03-31' }, { reportDate: '2025-12-31' }, { reportDate: '2026-03-31' }]), {
    latest: '2026-03-31', earliest: '2025-12-31', mixed: true,
  });
});
