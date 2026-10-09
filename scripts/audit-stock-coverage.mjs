#!/usr/bin/env node
// Anonymous, bounded inventory. Example:
// node scripts/audit-stock-coverage.mjs --label before
// node scripts/audit-stock-coverage.mjs --label after --compare .tmp/data-audit/before.json
// Recompute a report without network: add --offline.
// Use the published SEO view for specified symbols: --public-symbols MSFT,AVGO
// Reuse successful saved responses: --resume (failed responses may be fetched once).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_SYMBOLS = ['AAPL', 'NVDA', 'MSFT', 'AVGO', 'AMZN', 'ASML.AS', 'MC.PA', 'TTE.PA', 'VRME', 'BKNG'];
const AXES = ['insider', 'smartMoney', 'momentum', 'valuation', 'analyst', 'health', 'earnings'];
const FUNDAMENTALS = ['marketCap', 'enterpriseValue', 'peRatio', 'forwardPE', 'psRatio', 'pbRatio', 'pegRatio', 'pfcfRatio', 'eps', 'revenue', 'netIncome', 'sharesOut', 'sharesFloat', 'insiderOwnership', 'institutionalOwnership', 'beta', 'dividendYield', 'dividendPerShare', 'dividendGrowth', 'payoutRatio', 'targetMeanPrice', 'targetHighPrice', 'targetLowPrice', 'targetMedianPrice', 'targetUpsidePct', 'analystCount', 'numberOfAnalystOpinions', 'price52wChangePct', 'sma50', 'sma200'];
const RATIO_GROUPS = {
  extendedRatios: ['ps', 'psForward', 'pb', 'pfcf', 'peg', 'evEarnings', 'evSales', 'evEbitda', 'evFcf'],
  margins: ['gross', 'operating', 'pretax', 'profit', 'fcf', 'ebitda'],
  returns: ['roe', 'roa', 'roic', 'roce'],
  financialPosition: ['currentRatio', 'quickRatio', 'debtEquity', 'debtEbitda', 'interestCoverage'],
};

const missing = value => value === null || value === undefined || value === '';
const finite = value => typeof value === 'number' && Number.isFinite(value);
const presentText = value => typeof value === 'string' && value.trim().length > 0;
const get = (object, dotted) => dotted.split('.').reduce((value, key) => value?.[key], object);
const first = (...values) => values.find(value => !missing(value)) ?? null;

export function numericField(value, allowRatioObject = false, allowDisplayString = false) {
  if (missing(value)) return { state: 'missing', value: value ?? null };
  if (finite(value)) return { state: 'present', value };
  if (allowRatioObject && value && typeof value === 'object' && !Array.isArray(value)) {
    const numeric = first(value.numeric, value.raw);
    if (finite(numeric)) return { state: 'present', value: numeric, display: value.display ?? null };
    if (!missing(numeric)) return { state: 'invalid_numeric_object', value };
    if (presentText(value.display)) return numericField(value.display, false, true);
    if ('numeric' in value || 'raw' in value || 'display' in value) return { state: 'missing', value };
    return { state: 'invalid_numeric_object', value };
  }
  if (allowDisplayString && presentText(value)) {
    if (/^(?:n\/?a|none|null|undefined|[-–—])$/i.test(value.trim())) return { state: 'unavailable_display', value };
    return { state: 'display_only', value };
  }
  return { state: typeof value === 'object' ? 'invalid_numeric_object' : 'invalid_numeric', value };
}

function numericGroup(value, required, ratios = false, displays = false) {
  const fields = Object.fromEntries([...new Set([...required, ...Object.keys(value || {})])]
    .filter(key => required.includes(key) || finite(value?.[key]))
    .map(key => [key, numericField(value?.[key], ratios, displays)]));
  return { counts: counts(fields), fields };
}

function counts(fields) {
  const result = { total: 0, present: 0, missing: 0, display_only: 0, unavailable_display: 0, invalid_numeric: 0, invalid_numeric_object: 0 };
  for (const item of Object.values(fields)) { result.total++; result[item.state] = (result[item.state] || 0) + 1; }
  return result;
}

function dateSummary(value) {
  if (missing(value)) return null;
  if (typeof value === 'number') {
    const date = new Date(value < 1e12 ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? { raw: value, valid: false } : { raw: value, iso: date.toISOString(), valid: true };
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? { raw: value, valid: false } : { raw: value, iso: date.toISOString(), valid: true };
}

function providerEvidence(value, prefix = '', found = []) {
  if (!value || typeof value !== 'object') return found;
  for (const [key, item] of Object.entries(value)) {
    const location = prefix ? `${prefix}.${key}` : key;
    if (/^_?(?:source|provider|status|error|warning|reason|unavailableReason|availability|available|sourceAvailable|partial|degraded|synthetic|estimated)$/i.test(key)
      && (typeof item !== 'object' || item === null)) found.push({ path: location, value: item });
    if (item && typeof item === 'object' && !Array.isArray(item)) providerEvidence(item, location, found);
  }
  return found;
}

export function auditPayload(symbol, data, fetchMeta = {}) {
  if (data.error || (fetchMeta.httpStatus && fetchMeta.httpStatus !== 200)) return {
    symbol, coverageStatus: 'not_observed', fetched: fetchMeta,
    accessIssue: { code: data.code ?? null, error: data.error ?? null },
    price: { state: 'not_observed' }, chart: { count: null, lastDate: null },
    score: { supportedAxes: 0, unsupportedAxes: 0, unknownAxes: 7, axes: {} },
    company: { description: { state: 'not_observed' } },
    earnings: { historyCount: null, next: null }, peers: { count: null }, news: { count: null },
    fieldCounts: counts({}), fieldStates: {}, missingFields: [], invalidNumericFields: [],
    providerEvidence: [], unavailableProviderEvidence: [],
    missingReason: 'No stock payload was observable. Access or transport failures are not missing stock data or provider failures.',
  };
  const fields = {};
  const company = {};
  for (const key of ['name', 'description', 'sector', 'industry', 'country', 'employees']) {
    const value = data.company?.[key];
    company[key] = key === 'employees' ? numericField(value) : { state: presentText(value) ? 'present' : 'missing', value: value ?? null };
    if (key === 'description' && presentText(value)) { company[key].characters = value.length; company[key].value = value.slice(0, 160); }
    fields[`company.${key}`] = company[key];
  }
  const fundamentals = numericGroup(data.fundamentals, FUNDAMENTALS);
  for (const [key, value] of Object.entries(fundamentals.fields)) fields[`fundamentals.${key}`] = value;
  const ratios = {};
  for (const [group, keys] of Object.entries(RATIO_GROUPS)) {
    ratios[group] = numericGroup(data[group], keys, true, group === 'extendedRatios');
    for (const [key, value] of Object.entries(ratios[group].fields)) fields[`${group}.${key}`] = value;
  }
  const priceValue = typeof data.price === 'object' ? first(data.price?.regularMarketPrice, data.price?.current, data.price?.price, data.price?.close) : data.price;
  const price = { ...numericField(priceValue), raw: data.price ?? null };
  price.marketTime = dateSummary(data.price?.regularMarketTime);
  fields.price = price;
  const chartItems = Array.isArray(data.chart) ? data.chart : Array.isArray(data.chart?.points) ? data.chart.points : Array.isArray(data.chart?.data) ? data.chart.data : Array.isArray(data.chart?.prices) ? data.chart.prices : [];
  const dated = chartItems.map(row => dateSummary(first(row?.date, row?.time, row?.timestamp, row?.t))).filter(Boolean);
  const validDates = dated.filter(row => row.valid).sort((a, b) => a.iso.localeCompare(b.iso));
  const axes = Object.fromEntries(AXES.map(key => [key, {
    dataOk: typeof data.score?.breakdown?.[key]?.dataOk === 'boolean' ? data.score.breakdown[key].dataOk : null,
    score: data.score?.breakdown?.[key]?.score ?? null,
    max: data.score?.breakdown?.[key]?.max ?? null,
    detail: data.score?.breakdown?.[key]?.detail ?? null,
  }]));
  const analysts = {
    consensus: data.consensus ?? null,
    zonebourseConsensus: data.zonebourseConsensus ?? null,
    counts: Object.fromEntries(['analystCount', 'numberOfAnalystOpinions'].map(key => [key, numericField(data.fundamentals?.[key])])),
    targets: Object.fromEntries(['targetMeanPrice', 'targetMedianPrice', 'targetHighPrice', 'targetLowPrice', 'targetUpsidePct'].map(key => [key, numericField(data.fundamentals?.[key])])),
    countSource: data.fundamentals?.analystCountSource ?? null,
    reportedConsensusTotal: data.consensus?.total ?? null,
    sumOfReportedRatingBuckets: data.consensus && ['strongBuy', 'buy', 'hold', 'sell', 'strongSell'].every(key => finite(data.consensus[key])) ? ['strongBuy', 'buy', 'hold', 'sell', 'strongSell'].reduce((sum, key) => sum + data.consensus[key], 0) : null,
    consensusSource: first(data.consensus?._source, data.consensus?.source),
    explicitlySynthetic: data.consensus?._synthetic === true || data.consensus?.synthetic === true,
    note: 'Raw consensus and its provenance are retained. A derived rating distribution is not evidence of actual analyst votes; zero is an observed value, never missing.',
  };
  const earningsRows = Array.isArray(data.earnings?.history) ? data.earnings.history : [];
  const evidence = providerEvidence(data);
  const unavailableProviderEvidence = evidence.filter(row => (/(?:available|sourceAvailable)$/i.test(row.path) && row.value === false)
    || /(?:unavailable|error|denied|rate.?limit|failed|timeout|forbidden|unauthorized|not.?supported)/i.test(String(row.value)));
  return {
    symbol, coverageStatus: 'observed', returnedTicker: data.ticker ?? null, fetched: fetchMeta, updatedAt: data.updatedAt ?? null, cachedAt: data._cachedAt ?? null,
    publicTruncation: data._truncated === true, topLevelKeys: Object.keys(data),
    price,
    chart: { count: chartItems.length, firstDate: validDates[0] ?? null, lastDate: validDates.at(-1) ?? null, invalidDateCount: dated.filter(row => !row.valid).length, sample: chartItems.slice(-2), rawShape: Array.isArray(data.chart) ? 'array' : typeof data.chart },
    score: { total: data.score?.total ?? null, breakdownHidden: data.score?._breakdownHidden === true, supportedAxes: Object.values(axes).filter(row => row.dataOk === true).length, unsupportedAxes: Object.values(axes).filter(row => row.dataOk === false).length, unknownAxes: Object.values(axes).filter(row => row.dataOk === null).length, axes },
    company, fundamentals, ...ratios, analysts,
    earnings: { historyCount: earningsRows.length, historyWithActualEps: earningsRows.filter(row => finite(first(row.epsActual, row.actual, row.eps))).length, historyWithEstimate: earningsRows.filter(row => finite(first(row.epsEst, row.epsEstimate, row.estimate, row.estimated))).length, next: data.earnings?.next ?? null, historySample: earningsRows.slice(0, 2) },
    peers: { count: Array.isArray(data.peers) ? data.peers.length : null, withNames: Array.isArray(data.peers) ? data.peers.filter(row => presentText(row.name)).length : null, sample: data.peers?.slice?.(0, 3) ?? null },
    news: { count: Array.isArray(data.news) ? data.news.length : null, totalBeforePublicTruncation: data._totalNews ?? null, latestDate: first(data.news?.[0]?.pubDate, data.news?.[0]?.datetime, data.news?.[0]?.date, data.news?.[0]?.publishedAt), sample: data.news?.slice?.(0, 1) ?? null },
    fieldCounts: counts(fields),
    fieldStates: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.state])),
    missingFields: Object.entries(fields).filter(([, row]) => row.state === 'missing').map(([key]) => key),
    invalidNumericFields: Object.entries(fields).filter(([, row]) => row.state.startsWith('invalid_')).map(([key, row]) => ({ path: key, ...row })),
    providerEvidence: evidence, unavailableProviderEvidence,
    missingReason: unavailableProviderEvidence.length ? 'Explicit availability markers are listed; they apply only to their own provider/section.' : 'The public payload does not explain why absent fields are missing; provider failure cannot be inferred from absence.',
  };
}

function comparable(report) {
  return Object.fromEntries(report.stocks.map(stock => [stock.symbol, stock]));
}

export function compareReports(before, after) {
  const old = comparable(before);
  return {
    before: before.generatedAt, after: after.generatedAt,
    stocks: after.stocks.map(stock => {
      const previous = old[stock.symbol];
      if (!previous) return { symbol: stock.symbol, added: true };
      if (previous.coverageStatus !== 'observed' || stock.coverageStatus !== 'observed') return { symbol: stock.symbol, comparable: false, before: previous.coverageStatus, after: stock.coverageStatus };
      return {
        symbol: stock.symbol,
        presentFieldsDelta: stock.fieldCounts.present - previous.fieldCounts.present,
        supportedAxesDelta: stock.score.unknownAxes || previous.score.unknownAxes ? null : stock.score.supportedAxes - previous.score.supportedAxes,
        restoredFields: previous.missingFields.filter(key => stock.fieldStates[key] === 'present'),
        newlyMissingFields: stock.missingFields.filter(key => !previous.missingFields.includes(key)),
        invalidNumericBefore: previous.invalidNumericFields.length, invalidNumericAfter: stock.invalidNumericFields.length,
        chartLastDateBefore: previous.chart.lastDate, chartLastDateAfter: stock.chart.lastDate,
        earningsHistoryBefore: previous.earnings.historyCount, earningsHistoryAfter: stock.earnings.historyCount,
        peersBefore: previous.peers.count, peersAfter: stock.peers.count,
        newsBefore: previous.news.count, newsAfter: stock.news.count,
      };
    }),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const label = option('--label', 'before');
  if (!/^[a-z0-9_-]+$/i.test(label)) throw new Error('Use a simple label containing letters, digits, underscores or hyphens.');
  const root = path.resolve(option('--output', '.tmp/data-audit'));
  const payloadDir = path.join(root, label);
  const symbols = option('--symbols', DEFAULT_SYMBOLS.join(',')).split(',').map(value => value.trim().toUpperCase()).filter(Boolean);
  if (!symbols.every(symbol => /^[A-Z0-9.^-]+$/.test(symbol))) throw new Error('Invalid ticker.');
  if (symbols.length !== new Set(symbols).size) throw new Error('Duplicate tickers are not allowed.');
  const offline = args.includes('--offline');
  const resume = args.includes('--resume');
  const baseline = args.includes('--compare') ? JSON.parse(await readFile(option('--compare'), 'utf8')) : null;
  const inheritedPublicSymbols = baseline?.stocks?.filter(stock => stock.fetched?.url?.includes('/public/stock/')).map(stock => stock.symbol).join(',') ?? '';
  const publicSymbols = option('--public-symbols', inheritedPublicSymbols).split(',').map(value => value.trim().toUpperCase()).filter(Boolean);
  const endpoints = { full: 'https://kairos-insider-api.natquinson.workers.dev/api/stock/', public: 'https://kairos-insider-api.natquinson.workers.dev/public/stock/' };
  await mkdir(payloadDir, { recursive: true });
  let next = 0;
  const results = new Array(symbols.length);
  const fetchMetadata = {};
  const metadataPath = path.join(root, `${label}.requests.json`);
  const existingMetadata = offline || resume ? JSON.parse(await readFile(metadataPath, 'utf8').catch(() => '{}')) : {};
  async function worker() {
    while (next < symbols.length) {
      const index = next++;
      const symbol = symbols[index];
      const payloadPath = path.join(payloadDir, `${symbol}.json`);
      let data, metadata;
      if (offline || (resume && existingMetadata[symbol]?.httpStatus === 200)) {
        data = JSON.parse(await readFile(payloadPath, 'utf8'));
        metadata = existingMetadata[symbol] ?? { offline: true };
      } else {
        const started = Date.now();
        const url = (publicSymbols.includes(symbol) ? endpoints.public : endpoints.full) + encodeURIComponent(symbol);
        try {
          // Exactly one request per symbol, no retries, no credentials, at most two workers.
          const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(60000), redirect: 'error' });
          const body = await response.text();
          metadata = { url, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, httpStatus: response.status, contentType: response.headers.get('content-type') };
          try { data = JSON.parse(body); } catch { data = { error: 'non_json_response', body: body.slice(0, 1000) }; }
        } catch (error) {
          metadata = { url, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, requestError: String(error.message), cause: error.cause?.code ?? null };
          data = { error: 'request_failed', message: String(error.message) };
        }
        if (resume && existingMetadata[symbol]) {
          const previousPayload = await readFile(payloadPath, 'utf8').catch(() => null);
          if (previousPayload) await writeFile(path.join(payloadDir, `${symbol}.prior-error.json`), previousPayload);
          metadata.previousRequest = existingMetadata[symbol];
        }
        await writeFile(payloadPath, JSON.stringify(data, null, 2) + '\n');
      }
      fetchMetadata[symbol] = metadata;
      results[index] = auditPayload(symbol, data, metadata);
      console.log(`${symbol}: HTTP ${metadata.httpStatus ?? 'unavailable'}, ${results[index].fieldCounts.present} numeric/text fields, ${results[index].score.supportedAxes} supported/${results[index].score.unknownAxes} unknown axes, chart ${results[index].chart.count}, earnings ${results[index].earnings.historyCount}, peers ${results[index].peers.count}, news ${results[index].news.count}`);
    }
  }
  await Promise.all([worker(), worker()]);
  if (!offline) await writeFile(metadataPath, JSON.stringify(fetchMetadata, null, 2) + '\n');
  const report = {
    generatedAt: new Date().toISOString(), label, offline,
    method: { endpoints, publicSymbols: results.filter(stock => stock.fetched.url?.includes('/public/stock/')).map(stock => stock.symbol), symbols, concurrency: 2, timeoutMs: 60000, maxNewRequestsPerSymbol: offline ? 0 : 1, resume, authenticated: false, absentFieldsDoNotProveProviderFailure: true, zeroCountsAsPresent: true, numericStringCountsAsNumeric: false, numericRatioShapes: ['raw', 'numeric'] },
    summary: { symbols: results.length, successfulResponses: results.filter(row => row.fetched.httpStatus === 200).length, withPrice: results.filter(row => row.price.state === 'present').length, withChart: results.filter(row => row.chart.count > 0).length, withDescription: results.filter(row => row.company.description.state === 'present').length, withEarningsHistory: results.filter(row => row.earnings.historyCount > 0).length, withNextEarnings: results.filter(row => row.earnings.next !== null).length, invalidNumericFields: results.reduce((sum, row) => sum + row.invalidNumericFields.length, 0) },
    stocks: results,
  };
  const reportPath = path.join(root, `${label}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  if (baseline) {
    await writeFile(path.join(root, `${label}.comparison.json`), JSON.stringify(compareReports(baseline, report), null, 2) + '\n');
  }
  console.log(`Saved ${reportPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
