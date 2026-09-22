import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as stock from '../src/stock-api.js';

test('company profile fills unavailable primary fields from observed Yahoo data', () => {
  const company = stock.mergeCompanyProfile({ ticker: 'TEST', primary: {name: null, sector: null}, yahoo: {
    longName: 'Example Corporation', sector: 'Technology', industry: 'Software', country: 'United States',
    website: 'https://example.com', longBusinessSummary: 'Reported business description.', fullTimeEmployees: 1200,
    address1: '1 Example Street', city: 'Example City', state: 'CA', zip: '12345',
    companyOfficers: [{name: 'Finance Officer', title: 'Chief Financial Officer'}, {name: 'Executive Name', title: 'Chief Executive Officer & Director'}],
  }, quote: {name: 'TEST'} });
  assert.equal(company.name, 'Example Corporation');
  assert.equal(company.sector, 'Technology');
  assert.equal(company.country, 'United States');
  assert.equal(company.description, 'Reported business description.');
  assert.equal(company.employees, 1200);
  assert.equal(company.ceo, 'Executive Name');
  assert.equal(company.headquarters, '1 Example Street, Example City, CA, 12345, United States');
});

test('company profile keeps primary facts and does not invent missing executives or addresses', () => {
  const primary = {name: 'Primary', sector: 'Primary sector', description: 'Primary description', employees: 42, ceo: 'Primary CEO', headquarters: 'Primary HQ', founded: 1980};
  const company = stock.mergeCompanyProfile({ticker: 'TEST', primary, yahoo: {longName: 'Other', fullTimeEmployees: 99, country: 'United States', companyOfficers: [{name: 'Finance Officer', title: 'CFO'}]}});
  for (const key of Object.keys(primary)) assert.equal(company[key], primary[key]);
  const absent = stock.mergeCompanyProfile({ticker: 'TEST', yahoo: {country: 'United States', companyOfficers: [{name: 'Finance Officer', title: 'CFO'}, {name: 'Past Executive', title: 'Former CEO'}]}});
  assert.equal(absent.name, 'TEST');
  assert.equal(absent.headquarters, null);
  assert.equal(absent.ceo, null);
  assert.equal(absent.employees, null);
});

test('Yahoo share count fallback keeps absolute shares and respects an existing observation', () => {
  const fundamentals = {};
  stock.applyYahooFundamentals(fundamentals, {sharesOut: 14500000000, targetMeanPrice: 250, recommendationKey: 'buy'});
  assert.equal(fundamentals.sharesOut, 14500000000);
  assert.equal(fundamentals.targetMeanPrice, 250);
  stock.applyYahooFundamentals(fundamentals, {sharesOut: 99, targetMeanPrice: 99});
  assert.equal(fundamentals.sharesOut, 14500000000);
  assert.equal(fundamentals.targetMeanPrice, 250);
  for (const value of [null, undefined, '', 0, -1, 'bad']) {
    const missing = {};
    stock.applyYahooFundamentals(missing, {sharesOut: value});
    assert.equal(missing.sharesOut, undefined);
  }
});

test('Yahoo response retains source address and officers and unwraps shares without scaling', async t => {
  const profile = {sector: 'Technology', address1: '1 Source Street', city: 'Source City', state: 'CA', zip: '12345', country: 'United States', companyOfficers: [{name: 'Source CEO', title: 'CEO'}]};
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({quoteSummary:{result:[{assetProfile:profile, defaultKeyStatistics:{sharesOutstanding:{raw:14500000000}}}]}}), {status:200, headers:{'Content-Type':'application/json'}}));
  const result = await stock.fetchYahooFundamentals('TEST', {CACHE:{get:async () => ({cookie:'test', crumb:'test', at:Date.now()})}});
  for (const field of ['address1','city','state','zip','country','companyOfficers']) assert.deepEqual(result.profile[field], profile[field]);
  assert.equal(result.stats.sharesOut, 14500000000);
});
