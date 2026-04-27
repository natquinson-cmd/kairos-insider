// Aggregator EU thresholds : pour un ticker donne (Yahoo symbol style),
// matche les filings dans les 5 KV EU (amf, fca, bafin, afm, six) en
// retrouvant le nom de societe officiel via le mapping eu_yahoo_symbols.
//
// Sortie : { fundCount, activistsCount, filings, topFilers, totalFilings,
//            biggestFiler, recentFilings }
// pour booster le pilier smartMoney du Kairos Score.

import { EU_YAHOO_SYMBOLS } from './eu_yahoo_symbols.js';

// Mapping inverse : yahooSymbol -> nom de société matchable
// Ex : "MC.PA" -> "LVMH MOET HENNESSY"
const REVERSE_MAP = {};
for (const entry of EU_YAHOO_SYMBOLS) {
  // Premier match gagne (entries triées par spécificité)
  if (!REVERSE_MAP[entry.symbol]) {
    REVERSE_MAP[entry.symbol] = entry.match;
  }
}

const SUFFIX_TO_COUNTRY = {
  '.PA': 'FR', '.L': 'UK', '.DE': 'DE', '.AS': 'NL',
  '.SW': 'CH', '.MI': 'IT', '.MC': 'ES',
  '.ST': 'SE', '.OL': 'NO', '.CO': 'DK', '.HE': 'FI',
};

/**
 * Trouve les filings EU pour un ticker donné (US ou EU).
 * @param {string} ticker - Ticker (ex: "MC.PA", "AAPL", "BARC.L")
 * @param {object} env - Cloudflare worker env (avec env.CACHE)
 * @returns {Promise<{fundCount, activistsCount, filings, topFilers, biggestFiler, recentFilings, totalFilings}>}
 */
export async function aggregateEuThresholds(ticker, env) {
  const result = {
    fundCount: 0,
    activistsCount: 0,
    totalFilings: 0,
    recentFilings: 0,  // last 30 days
    filings: [],
    topFilers: [],     // [{ name, count, isActivist }]
    biggestFiler: null,
    sources: {},       // counts by KV source (amf, fca, etc.)
  };

  if (!ticker || !env?.CACHE) return result;

  const tickerUp = String(ticker).toUpperCase().trim();

  // Detect country from suffix
  let country = null;
  let companyMatch = null;
  for (const [suffix, ccode] of Object.entries(SUFFIX_TO_COUNTRY)) {
    if (tickerUp.endsWith(suffix)) {
      country = ccode;
      // Lookup nom de societe via reverse map
      companyMatch = REVERSE_MAP[tickerUp] || null;
      break;
    }
  }

  // Si pas de suffix EU, c'est probablement US -> on retourne 0 (pas de filings EU)
  if (!country || !companyMatch) {
    return result;
  }

  // Determine quels KV charger selon le pays (pour optimiser)
  const kvKeys = [];
  if (country === 'FR') kvKeys.push('amf-thresholds-recent');
  else if (country === 'UK') kvKeys.push('uk-thresholds-recent');
  else if (country === 'DE') kvKeys.push('bafin-thresholds-recent');
  else if (country === 'NL') kvKeys.push('nl-thresholds-recent');
  else if (country === 'CH') kvKeys.push('ch-thresholds-recent');
  else if (country === 'IT') kvKeys.push('it-thresholds-recent');
  else if (country === 'ES') kvKeys.push('es-thresholds-recent');
  else if (country === 'SE') kvKeys.push('se-thresholds-recent');
  else if (country === 'NO') kvKeys.push('no-thresholds-recent');
  else if (country === 'DK') kvKeys.push('dk-thresholds-recent');
  else if (country === 'FI') kvKeys.push('fi-thresholds-recent');
  if (kvKeys.length === 0) return result;

  // Cas particulier : pour les multi-listing (ex Stellantis sur Euronext + Milan + Madrid)
  // on charge aussi les KV des autres pays grosses-caps
  const auxKvs = ['amf-thresholds-recent', 'uk-thresholds-recent', 'bafin-thresholds-recent',
                  'nl-thresholds-recent', 'ch-thresholds-recent'];

  // Fetch tous les KV en parallele
  const allKvKeys = [...new Set([...kvKeys, ...auxKvs])];
  const kvData = await Promise.all(
    allKvKeys.map(k => env.CACHE.get(k, 'json').catch(() => null))
  );

  const matchUpper = companyMatch.toUpperCase();
  const allFilings = [];
  for (let i = 0; i < allKvKeys.length; i++) {
    const data = kvData[i];
    if (!data || !Array.isArray(data.filings)) continue;
    const kvKey = allKvKeys[i];
    const matches = data.filings.filter(f => {
      const tn = String(f.targetName || '').toUpperCase();
      // Fuzzy match : si le mapping match est dans le targetName
      return tn.includes(matchUpper);
    });
    for (const m of matches) {
      allFilings.push({ ...m, _kvSource: kvKey });
      result.sources[kvKey] = (result.sources[kvKey] || 0) + 1;
    }
  }

  // Sort by date desc
  allFilings.sort((a, b) => (b.fileDate || '').localeCompare(a.fileDate || ''));

  result.totalFilings = allFilings.length;
  result.filings = allFilings.slice(0, 30); // top 30 most recent

  // Compter activists / unique filers
  const filerMap = new Map();
  const cutoff30 = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  })();
  let recentCount = 0;
  let activists = 0;
  for (const f of allFilings) {
    const filerName = (f.filerName || f.activistLabel || '').trim();
    if (filerName) {
      const key = filerName.toUpperCase();
      const entry = filerMap.get(key) || { name: filerName, count: 0, isActivist: !!f.isActivist };
      entry.count += 1;
      if (f.isActivist) entry.isActivist = true;
      filerMap.set(key, entry);
    }
    if (f.fileDate && f.fileDate >= cutoff30) recentCount += 1;
    if (f.isActivist) activists += 1;
  }
  result.recentFilings = recentCount;
  result.activistsCount = activists;
  result.fundCount = filerMap.size;

  // Top 10 filers par count (activists prioritaires)
  result.topFilers = Array.from(filerMap.values())
    .sort((a, b) => {
      if (a.isActivist !== b.isActivist) return a.isActivist ? -1 : 1;
      return b.count - a.count;
    })
    .slice(0, 10);

  if (result.topFilers.length > 0) {
    result.biggestFiler = result.topFilers[0];
  }

  return result;
}
