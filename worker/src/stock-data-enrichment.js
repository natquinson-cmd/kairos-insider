// Provider observations are normalized before filling missing dashboard fields.
// Financial amounts retain their reporting currency; quote amounts must match.
const number = value => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const symbol = value => text(value)?.toUpperCase() || null;
const placeholders = /^(?:[-–—]+|n\/?a|nan|[+-]?infinity|null|undefined)$/i;

/** Later available observations win; empty provider values never erase facts. */
export function mergeAvailableNumbers(...objects) {
  const merged = {};
  for (const object of objects) {
    if (!object || typeof object !== 'object' || Array.isArray(object)) continue;
    for (const [key, value] of Object.entries(object)) {
      if (value == null || typeof value === 'boolean') continue;
      if (typeof value === 'number' && !Number.isFinite(value)) continue;
      if (typeof value === 'string') {
        const cleaned = value.trim();
        if (!cleaned || placeholders.test(cleaned)) continue;
        if (!Number.isNaN(Number(cleaned)) && !Number.isFinite(Number(cleaned))) continue;
        merged[key] = number(cleaned) ?? cleaned;
      } else {
        merged[key] = value;
      }
    }
  }
  return merged;
}

function metricNumber(metric) {
  if (metric && typeof metric === 'object') return number(metric.numeric) ?? number(metric.raw);
  return number(metric);
}

/**
 * Yahoo input percentages are fractions except debtToEquity (percentage points).
 * Currency strings remain case-sensitive: GBp and GBP are different units.
 * ticker identifies the returned listing; requestedTicker identifies the page.
 */
export function enrichYahooFinancials(input = {}, stats = {}) {
  input = input || {};
  stats = stats || {};
  const result = Object.fromEntries(['fundamentals', 'extendedRatios', 'margins', 'returns', 'financialPosition']
    .map(key => [key, { ...(input[key] || {}) }]));
  const fundamentals = result.fundamentals;
  const sourceSymbol = symbol(stats.ticker);
  const requestedSymbol = symbol(stats.requestedTicker);
  const sameListing = !!sourceSymbol && sourceSymbol === requestedSymbol;
  const quoteCurrency = text(stats.quoteCurrency);
  const financialCurrency = /^[A-Z]{3}$/.test(text(stats.financialCurrency) || '') ? text(stats.financialCurrency) : null;
  if (!text(fundamentals.currency) && sameListing && quoteCurrency) fundamentals.currency = quoteCurrency;
  const targetCurrency = text(fundamentals.currency);
  const quoteMatches = !!targetCurrency && !!quoteCurrency && targetCurrency === quoteCurrency;
  const source = (unit, currency) => ({ source: 'yahoo', symbol: sourceSymbol, ...(currency ? { currency } : {}), unit });
  const markSource = (target, key, unit, currency) => {
    target._sources = { ...(target._sources || {}), [key]: source(unit, currency) };
  };
  const fill = (target, key, value, unit = 'ratio', currency = null, valid = () => true) => {
    const existing = number(target[key]);
    if (existing != null && valid(existing)) return false;
    const observed = number(value);
    if (observed == null || !valid(observed)) return false;
    target[key] = observed;
    markSource(target, key, unit, currency);
    return true;
  };
  const scaled = (value, factor) => {
    const observed = number(value);
    return observed == null ? null : observed * factor;
  };
  const fillMetric = (target, key, value, unit) => {
    if (metricNumber(target[key]) != null) return;
    const observed = number(value);
    if (observed == null) return;
    target[key] = {
      numeric: observed,
      raw: observed,
      display: `${observed.toFixed(2)}${unit === 'percent' ? '%' : ''}`,
      ...source(unit),
    };
  };

  for (const key of ['peRatio', 'forwardPE', 'psRatio', 'pbRatio', 'pegRatio', 'evEbitda', 'evSales', 'beta']) {
    fill(fundamentals, key, stats[key]);
  }
  for (const key of ['dividendYield', 'payoutRatio', 'profitMargin', 'revenueGrowth', 'earningsGrowth']) {
    fill(fundamentals, key, stats[key], 'fraction');
  }
  for (const key of ['insiderOwnership', 'institutionalOwnership']) {
    fill(fundamentals, key, scaled(stats[key], 100), 'percent');
  }
  if (quoteMatches) {
    if (fill(fundamentals, 'marketCap', stats.marketCap, 'currency', quoteCurrency, value => value > 0)) {
      fundamentals.marketCapCurrency = quoteCurrency;
    }
    fill(fundamentals, 'enterpriseValue', stats.enterpriseValue, 'currency', quoteCurrency);
  }
  // Financial reports can use another currency than the traded listing. Keep the
  // observed amount unchanged and attach that currency to each inserted field.
  if (financialCurrency) {
    for (const key of ['revenue', 'netIncome', 'freeCashFlow', 'operatingCashFlow', 'totalCash', 'totalDebt']) {
      fill(fundamentals, key, stats[key], 'currency', financialCurrency);
    }
    const cash = number(stats.totalCash), debt = number(stats.totalDebt);
    if (cash != null && debt != null && fill(fundamentals, 'netCash', cash - debt, 'currency', financialCurrency)) {
      fundamentals._sources.netCash.calculation = 'totalCash - totalDebt';
    }
    if (sameListing) fill(fundamentals, 'eps', stats.eps, 'currency/share', financialCurrency);
  }
  if (sameListing) {
    for (const key of ['sharesOut', 'sharesFloat']) {
      fill(fundamentals, key, stats[key], 'shares', null, value => value > 0);
    }
    if (quoteMatches) {
      fill(fundamentals, 'dividendPerShare', stats.dividendPerShare, 'currency/share', quoteCurrency, value => value >= 0);
      for (const key of ['high52w', 'low52w', 'sma50', 'sma200']) {
        fill(fundamentals, key, stats[key], 'currency/share', quoteCurrency, value => value > 0);
      }
    }
  }
  for (const [key, field] of Object.entries({ ps: 'psRatio', pb: 'pbRatio', peg: 'pegRatio', evEbitda: 'evEbitda', evSales: 'evSales' })) {
    fill(result.extendedRatios, key, stats[field]);
  }
  for (const [key, field] of Object.entries({ gross: 'grossMargin', operating: 'operatingMargin', profit: 'profitMargin', ebitda: 'ebitdaMargin' })) {
    fillMetric(result.margins, key, scaled(stats[field], 100), 'percent');
  }
  for (const key of ['roe', 'roa']) fillMetric(result.returns, key, scaled(stats[key], 100), 'percent');
  for (const key of ['currentRatio', 'quickRatio']) fillMetric(result.financialPosition, key, stats[key], 'ratio');
  fillMetric(result.financialPosition, 'debtEquity', scaled(stats.debtToEquity, .01), 'ratio');
  return result;
}

/** An explicitly estimated score; never a substituted Altman or Piotroski score. */
export function buildEstimatedHealth({ margins = {}, returns = {}, financialPosition = {} } = {}) {
  const definitions = [
    ['netMargin', margins?.profit, 'percent', 0, '>', 'Marge nette positive'],
    ['roa', returns?.roa, 'percent', 0, '>', 'ROA positif'],
    ['roe', returns?.roe, 'percent', 0, '>', 'ROE positif'],
    ['grossMargin', margins?.gross, 'percent', 0, '>', 'Marge brute positive'],
    ['operatingMargin', margins?.operating, 'percent', 0, '>', 'Marge opérationnelle positive'],
    ['currentRatio', financialPosition?.currentRatio, 'ratio', 1, '>', 'Liquidité générale > 1'],
    ['debtEquity', financialPosition?.debtEquity, 'ratio', 2, '<', 'Endettement maîtrisé'],
  ];
  const criteria = [];
  for (const [key, metric, unit, threshold, comparison, label] of definitions) {
    const value = metricNumber(metric);
    if (value == null) continue;
    const debt = key === 'debtEquity';
    criteria.push({
      key, value, unit, threshold, comparison,
      ...(debt ? { minimum: 0 } : {}),
      ok: debt ? value >= 0 && value < threshold : value > threshold,
      label,
      ...(text(metric?.source) ? { source: metric.source } : {}),
      ...(text(metric?.symbol) ? { symbol: metric.symbol } : {}),
    });
  }
  if (criteria.length < 4) return null;
  const score = criteria.filter(criterion => criterion.ok).length;
  const ratio = score / criteria.length;
  const zone = ratio >= .71 ? 'strong' : ratio >= .43 ? 'mid' : 'weak';
  return {
    score,
    total: criteria.length,
    ratio: Math.round(ratio * 100),
    zone,
    label: { strong: 'SOLIDE', mid: 'MOYEN', weak: 'FAIBLE' }[zone],
    criteria,
    source: 'kairos',
    estimated: true,
  };
}
