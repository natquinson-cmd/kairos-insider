function finiteNumber(value) {
  if (value == null || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function normalizeEarningsRecord({ actual, estimate }) {
  const actualNumber = finiteNumber(actual);
  const estimateNumber = finiteNumber(estimate);
  const valid = actualNumber != null && estimateNumber != null && estimateNumber !== 0;
  return {
    actual: Number.isFinite(actualNumber) ? actualNumber : null,
    estimate: Number.isFinite(estimateNumber) ? estimateNumber : null,
    surprisePct: valid ? ((actualNumber - estimateNumber) / Math.abs(estimateNumber)) * 100 : null,
    beat: valid ? actualNumber >= estimateNumber : null,
  };
}

export function summarizeEarningsBeats(history) {
  const available = (Array.isArray(history) ? history : [])
    .slice(0, 4)
    .filter(entry => typeof entry?.beat === 'boolean');
  return { available: available.length, beats: available.filter(entry => entry.beat).length };
}

export function normalizeEarningsHistory(history) {
  return (Array.isArray(history) ? history : []).map(entry => {
    const normalized = normalizeEarningsRecord({ actual: entry.epsActual, estimate: entry.epsEst });
    return {
      ...entry,
      epsActual: normalized.actual,
      epsEst: normalized.estimate,
      epsSurprisePct: normalized.surprisePct,
      beat: normalized.beat,
    };
  });
}

export function normalizeStockAnalysisEarningsRecord(entry) {
  const normalized = normalizeEarningsRecord({ actual: entry.eps_actual, estimate: entry.eps_est });
  return {
    date: entry.date,
    year: entry.year,
    period: entry.period,
    epsEst: normalized.estimate,
    epsActual: normalized.actual,
    epsSurprisePct: normalized.surprisePct,
    revenueEst: entry.revenue_est,
    revenueActual: entry.revenue_actual,
    revenueSurprisePct: entry.revenue_surprise_percent,
    beat: normalized.beat,
  };
}

export function normalizeDividendYield(value, unit) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return unit === 'percent' ? numeric / 100 : numeric;
}
