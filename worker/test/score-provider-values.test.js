import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeKairosScore } from '../src/stock-api.js';
const base = { insiders:{}, smartMoney:{}, govEtf:{inEtfs:[],totalPct:0}, quote:{price:{current:20,low52w:10,high52w:30}}, health:{}, earnings:{history:[]} };
test('numeric strings from providers produce the same score and details as numbers', () => {
  const numbers = computeKairosScore({...base,fundamentals:{targetMeanPrice:25.4,peRatio:21,forwardPE:19}});
  const strings = computeKairosScore({...base,fundamentals:{targetMeanPrice:'25.4',peRatio:'21',forwardPE:'19'}});
  assert.deepEqual(strings, numbers);
});
test('missing and invalid price targets are unavailable rather than zero or a crash', () => {
  for (const value of [null, '', '—', 'N/A', true, Infinity]) {
    const score = computeKairosScore({...base,fundamentals:{targetMeanPrice:value}});
    assert.equal(score.breakdown.analyst.dataOk, false);
    assert.equal(score.breakdown.analyst.detail, 'Pas de consensus');
  }
});
