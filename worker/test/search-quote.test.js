import {test} from 'node:test';import assert from 'node:assert/strict';import {searchQuote} from '../src/search-quote.js';
test('search chart uses real monthly closes and daily rather than monthly price change',()=>{const q=searchQuote({meta:{regularMarketPrice:120,chartPreviousClose:80},indicators:{quote:[{close:[90,null,100,120]}]}});assert.deepEqual(q.sparkline,[90,100,120]);assert.equal(q.changePercent,20);});
test('missing daily comparison remains unavailable',()=>{assert.equal(searchQuote({meta:{regularMarketPrice:120,chartPreviousClose:80}}).changePercent,null);});
