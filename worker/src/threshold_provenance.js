const OFFICIAL_HOSTS = new Set([
  'bdif.amf-france.org',
  'amf-france.org',
  'www.amf-france.org',
  'portal.mvp.bafin.de',
  'www.afm.nl',
  'afm.nl',
  'data.fca.org.uk',
  'www.fca.org.uk',
  'fca.org.uk',
  'www.six-exchange-regulation.com',
  'six-exchange-regulation.com',
  'www.ser-ag.com',
  'ser-ag.com',
  'www.cnmv.es',
  'cnmv.es',
]);

const PRESS_METHODS = new Set(['google-news-rss', 'borsa-italiana-radiocor']);
const THRESHOLD_TYPES = new Set(['shareholding', 'substantial', 'threshold', 'tr1', 'participation']);
const THRESHOLD_METHODS = new Set([
  'amf-bdif-official', 'amf-stealth', 'bafin-csv-official',
  'afm-csv-official', 'six-ser-official',
]);

function hostname(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isOfficialUrl(value) {
  const host = hostname(value);
  return OFFICIAL_HOSTS.has(host) || [...OFFICIAL_HOSTS].some((known) => host.endsWith(`.${known}`));
}

function pressProvider(filing) {
  const provider = String(filing.sourceProvider || '').trim();
  if (provider && !/^(amf|fca|bafin|afm|six|cnmv|consob)$/i.test(provider)) return provider;
  const source = String(filing.source || '').trim();
  return /^(amf|fca|bafin|afm|six|cnmv|consob)$/i.test(source) ? null : (source || null);
}

/**
 * Normalizes old and new cached rows according to the evidence URL and collector method.
 * Labels alone are deliberately not accepted as proof of a regulatory filing.
 */
export function normalizeThresholdFilingProvenance(filing, payload = {}) {
  const row = { ...filing };
  const method = String(row.collectionMethod || payload.method || '').toLowerCase();
  const urlIsOfficial = isOfficialUrl(row.sourceUrl);
  const urlHost = hostname(row.sourceUrl);
  const explicitPress = row.provenance?.kind === 'press-report' || PRESS_METHODS.has(method) || urlHost === 'news.google.com';
  const explicitOfficial = row.provenance?.kind === 'official-regulator';
  const official = !explicitPress && urlIsOfficial && (explicitOfficial || method !== 'unknown');
  const announcementType = String(row.announcementType || '').toLowerCase();
  const form = String(row.form || '').toLowerCase();
  const isThresholdDisclosure = THRESHOLD_TYPES.has(announcementType)
    || THRESHOLD_METHODS.has(method)
    || /franchissement|shareholding|substantial|stimmrechtsmitteilung|threshold/.test(form);

  if (official) {
    return {
      ...row,
      provenance: {
        kind: 'official-regulator',
        officialDocument: true,
        verified: true,
        method: method || null,
        evidenceUrl: row.sourceUrl || null,
      },
      regulatorySignalEligible: isThresholdDisclosure,
    };
  }

  return {
    ...row,
    source: 'press',
    regulator: null,
    sourceProvider: pressProvider(row),
    provenance: {
      kind: 'press-report',
      officialDocument: false,
      verified: false,
      method: method || null,
      evidenceUrl: row.sourceUrl || null,
    },
    regulatorySignalEligible: false,
    isActivist: false,
    activistLabel: null,
  };
}

export function partitionThresholdFilings(filings, payload = {}) {
  const regulatoryFilings = [];
  const pressReports = [];
  for (const filing of Array.isArray(filings) ? filings : []) {
    const normalized = normalizeThresholdFilingProvenance(filing, payload);
    if (normalized.regulatorySignalEligible) regulatoryFilings.push(normalized);
    else pressReports.push(normalized);
  }
  return { regulatoryFilings, pressReports };
}
