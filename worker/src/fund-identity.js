const CANONICAL_BY_CIK = Object.freeze({
  '0000019617': { fundName: 'JPMORGAN CHASE & CO', label: 'JPMorgan Chase', category: 'Bank Asset Manager' },
  '0000914208': { fundName: 'INVESCO LTD.', label: 'Invesco', category: 'Asset Manager' },
});

const LEGACY_ALIAS_TO_CIK = Object.freeze({
  'GOLDMAN SACHS GROUP|GOLDMAN AM': '0000019617',
  'WELLINGTON MANAGEMENT|JEAN HYNES': '0000914208',
});

export function normalizeCik(cik) {
  const digits = String(cik || '').replace(/\D/g, '');
  return digits ? digits.padStart(10, '0').slice(-10) : '';
}

export function canonicalizeFundIdentity(fund) {
  const legacyKey = `${String(fund?.fundName || '').trim().toUpperCase()}|${String(fund?.label || '').trim().toUpperCase()}`;
  const cik = normalizeCik(fund?.cik) || LEGACY_ALIAS_TO_CIK[legacyKey] || '';
  const canonical = CANONICAL_BY_CIK[cik];
  return canonical ? { ...fund, cik, ...canonical } : { ...fund, ...(cik ? { cik } : {}) };
}

export function summarizeReportDates(funds) {
  const dates = [...new Set((funds || []).map(f => f.reportDate).filter(Boolean))].sort();
  return { latest: dates.at(-1) || null, earliest: dates[0] || null, mixed: dates.length > 1 };
}
