const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname, '../assets/analysis-presentation.js');
const presentation = existsSync(file) ? require(file) : {};

test('fractional dividend yields become percentages on French and English pages', () => {
  assert.equal(typeof presentation.formatDividendYield, 'function');
  assert.equal(presentation.formatDividendYield(0.0032, 'fr'), '0,32 %');
  assert.equal(presentation.formatDividendYield(0.0032, 'en'), '0.32%');
  assert.equal(presentation.formatDividendYield(0, 'en'), '0.00%');
});

test('unknown dividend yields are not represented as zero', () => {
  assert.equal(typeof presentation.formatDividendYield, 'function');
  for (const value of [null, undefined, '', 'not available', NaN, Infinity, -0.01]) {
    assert.equal(presentation.formatDividendYield(value, 'fr'), '—');
    assert.equal(presentation.dividendBand(value), 'missing');
  }
});

test('a positive dividend below one percent is low rather than absent', () => {
  assert.equal(typeof presentation.dividendBand, 'function');
  assert.equal(presentation.dividendBand(0.0032), 'low');
  assert.equal(presentation.dividendBand(0), 'none');
  assert.equal(presentation.dividendBand(0.04), 'moderate');
  assert.equal(presentation.dividendBand(0.06), 'high');
});

test('unit prices retain cents and small positive amounts never round to zero', () => {
  assert.equal(typeof presentation.formatUnitPrice, 'function');
  assert.equal(presentation.formatUnitPrice(332.27, 'USD', 'en'), '$332.27');
  assert.equal(presentation.formatUnitPrice(0.1867, 'USD', 'en'), '$0.1867');
  assert.equal(presentation.formatUnitPrice(null, 'USD', 'en'), '—');
});

test('explicit SEC transaction codes take precedence over acquired/disposed flags', () => {
  assert.equal(typeof presentation.insiderKind, 'function');
  assert.equal(presentation.insiderKind({ transType: 'S', adType: 'D' }), 'sell');
  assert.equal(presentation.insiderKind({ transactionCode: 'M', adType: 'A' }), 'other');
  assert.equal(presentation.insiderKind({ transactionCode: 'A', adType: 'A' }), 'other');
  assert.equal(presentation.insiderKind({ transactionCode: 'D', adType: 'D' }), 'other');
  assert.equal(presentation.insiderKind({ type: 'P' }), 'buy');
  assert.equal(presentation.insiderKind({ type: 'F', adType: 'D' }), 'other');
  assert.equal(presentation.insiderKind({ adType: 'D' }), 'sell');
  assert.equal(presentation.insiderKind({}), 'other');
});
