const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stockLinks } = require('../assets/core-sharing.js');
test('shared action uses public SSR route, with French and English image and X composer links', () => {
  for (const lang of ['fr', 'en']) {
    const link = stockLinks(' air.pa ', lang, new Date('2026-09-22T10:00:00Z'));
    assert.equal(new URL(link.url).pathname, '/a/AIR.PA');
    assert.equal(new URL(link.url).searchParams.get('lang'), lang);
    assert.equal(new URL(link.x).searchParams.get('url'), link.url);
    assert.equal(new URL(link.image).searchParams.get('lang'), lang);
    assert.equal(new URL(link.image).pathname, '/og/AIR.PA.png');
    assert.ok(!link.url.includes('#'));
  }
});
test('share refuses malformed or injected symbols', () => {
  for (const ticker of ['', '<script>', 'AAPL?uid=me', '../admin', 'A'.repeat(13)]) assert.throws(() => stockLinks(ticker));
});
