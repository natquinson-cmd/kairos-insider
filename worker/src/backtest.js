/**
 * Backtest Smart Money — feature gratuite (acquisition)
 *
 * Concept : "Si tu avais suivi {Cevian, BlackRock, Elliott...} pendant 1/3/5 ans,
 *            quel serait ton rendement ?"
 *
 * Methodologie MVP :
 *   1. Pour un filer (activist/institutionnel) choisi, lister tous les filings
 *      sur la période (1y, 3y, 5y) dans les 6 KV thresholds (SEC + AMF + FCA + SIX + AFM + BaFin)
 *   2. Pour chaque target, considérer la 1ère date d'apparition comme entrée
 *      Si le filer a re-franchit en baisse, considérer cette date comme sortie
 *      Sinon = encore en position (sortie = aujourd'hui)
 *   3. Récupérer les prix Yahoo entry/exit, calculer rendement
 *   4. Aggréger : rendement moyen pondéré, comparé à S&P500 / CAC40
 *
 * Endpoint : GET /api/backtest/:filer?period=1y
 * Response : { filer, period, positions, summary, comparison }
 */

const SUFFIX_TO_BENCHMARK = {
  'US': '%5EGSPC',  // S&P 500
  'FR': '%5EFCHI',  // CAC 40
  'UK': '%5EFTSE',  // FTSE 100
  'DE': '%5EGDAXI', // DAX
  'NL': '%5EAEX',   // AEX
  'CH': '%5ESSMI',  // SMI
  'IT': 'FTSEMIB.MI', // FTSE MIB
  'ES': '%5EIBEX',  // IBEX 35
  'SE': '%5EOMX',   // OMXS30
  'NO': '%5EOSEAX', // OBX
  'DK': '%5EOMXC25',// OMXC25
  'FI': '%5EOMXH25',// OMXH25
};

const PERIOD_TO_DAYS = { '1y': 365, '3y': 1095, '5y': 1825 };

// Liste des grands smart money pour autocomplete + acquisition
export const KNOWN_FILERS = [
  // Activists US
  { key: 'CEVIAN', label: 'Cevian Capital', country: 'EU', tag: 'activist' },
  { key: 'BLUEBELL', label: 'Bluebell Capital', country: 'UK', tag: 'activist' },
  { key: 'ELLIOTT', label: 'Elliott Management', country: 'US', tag: 'activist' },
  { key: 'PERSHING SQUARE', label: 'Pershing Square (Bill Ackman)', country: 'US', tag: 'activist' },
  { key: 'STARBOARD', label: 'Starboard Value', country: 'US', tag: 'activist' },
  { key: 'TRIAN', label: 'Trian Fund Management', country: 'US', tag: 'activist' },
  { key: 'CARL ICAHN', label: 'Icahn Enterprises', country: 'US', tag: 'activist' },
  { key: 'TCI FUND', label: 'TCI Fund Management', country: 'UK', tag: 'activist' },
  { key: 'JANA PARTNERS', label: 'Jana Partners', country: 'US', tag: 'activist' },
  // Institutionnels
  { key: 'BLACKROCK', label: 'BlackRock', country: 'GLOBAL', tag: 'institutional' },
  { key: 'VANGUARD', label: 'Vanguard', country: 'GLOBAL', tag: 'institutional' },
  { key: 'STATE STREET', label: 'State Street', country: 'US', tag: 'institutional' },
  { key: 'NORGES BANK', label: 'Norges Bank Investment Mgmt', country: 'GLOBAL', tag: 'institutional' },
  { key: 'GIC', label: 'GIC (Singapour)', country: 'GLOBAL', tag: 'institutional' },
  { key: 'TEMASEK', label: 'Temasek Holdings', country: 'GLOBAL', tag: 'institutional' },
  { key: 'CAPITAL GROUP', label: 'Capital Group', country: 'US', tag: 'institutional' },
  { key: 'FIDELITY', label: 'Fidelity', country: 'US', tag: 'institutional' },
  { key: 'WELLINGTON', label: 'Wellington Management', country: 'US', tag: 'institutional' },
  // Hedge Funds
  { key: 'CITADEL', label: 'Citadel (Ken Griffin)', country: 'US', tag: 'hedgefund' },
  { key: 'BRIDGEWATER', label: 'Bridgewater Associates (Ray Dalio)', country: 'US', tag: 'hedgefund' },
  { key: 'MILLENNIUM', label: 'Millennium Partners (Englander)', country: 'US', tag: 'hedgefund' },
  { key: 'RENAISSANCE', label: 'Renaissance Technologies (Simons)', country: 'US', tag: 'hedgefund' },
  // FR-specific
  { key: 'BPIFRANCE', label: 'Bpifrance', country: 'FR', tag: 'state' },
  { key: 'AMUNDI', label: 'Amundi', country: 'FR', tag: 'institutional' },
  { key: 'BOLLORE', label: 'Groupe Bolloré', country: 'FR', tag: 'family' },
  { key: 'ARNAULT', label: 'Bernard Arnault (LVMH)', country: 'FR', tag: 'family' },
  { key: 'PINAULT', label: 'Pinault (Artemis)', country: 'FR', tag: 'family' },
];


/**
 * Cherche tous les filings d'un filer dans toutes les KV thresholds
 * Retourne une liste de positions [{target, ticker, entryDate, exitDate, percent, kvSource}]
 */
async function gatherFilerPositions(filerKey, periodDays, env) {
  const cutoffDate = new Date(Date.now() - periodDays * 24 * 3600 * 1000)
    .toISOString().slice(0, 10);
  const filerUpper = filerKey.toUpperCase();

  const KV_KEYS = [
    '13dg-recent',         // SEC US
    'amf-thresholds-recent', // FR
    'uk-thresholds-recent',  // UK
    'bafin-thresholds-recent', // DE
    'nl-thresholds-recent',  // NL
    'ch-thresholds-recent',  // CH
    'it-thresholds-recent', 'es-thresholds-recent',
    'se-thresholds-recent', 'no-thresholds-recent',
    'dk-thresholds-recent', 'fi-thresholds-recent',
  ];

  const dataList = await Promise.all(
    KV_KEYS.map(k => env.CACHE.get(k, 'json').catch(() => null))
  );

  const matches = [];
  for (let i = 0; i < KV_KEYS.length; i++) {
    const data = dataList[i];
    if (!data || !Array.isArray(data.filings)) continue;
    const kvKey = KV_KEYS[i];
    for (const f of data.filings) {
      if (!f.fileDate || f.fileDate < cutoffDate) continue;
      const filer = String(f.filerName || f.activistLabel || '').toUpperCase();
      const beneficial = String(f.beneficialOwner || '').toUpperCase();
      if (filer.includes(filerUpper) || beneficial.includes(filerUpper)) {
        matches.push({
          ...f,
          _kvSource: kvKey,
        });
      }
    }
  }

  // Group by target : 1ère apparition = entry, dernière = exit (peut être same)
  const byTarget = new Map();
  for (const m of matches) {
    const targetKey = (m.targetName || m.ticker || '').toUpperCase();
    if (!targetKey) continue;
    if (!byTarget.has(targetKey)) {
      byTarget.set(targetKey, {
        target: m.targetName || m.ticker,
        ticker: m.ticker || '',
        country: m.country || 'US',
        firstDate: m.fileDate,
        lastDate: m.fileDate,
        percent: m.percentOfClass || m.crossingThreshold || null,
        direction: m.crossingDirection || 'up',
        filings: [m],
        kvSource: m._kvSource,
        regulator: m.regulator || '',
      });
    } else {
      const e = byTarget.get(targetKey);
      e.filings.push(m);
      if (m.fileDate < e.firstDate) e.firstDate = m.fileDate;
      if (m.fileDate > e.lastDate) e.lastDate = m.fileDate;
      if (m.percentOfClass) e.percent = m.percentOfClass;
    }
  }

  return Array.from(byTarget.values());
}


/**
 * Fetch close price Yahoo at a given date (approximate - returns nearest trading day)
 */
async function fetchPriceAtDate(yahooSymbol, isoDate) {
  if (!yahooSymbol || !isoDate) return null;
  // Yahoo period1/period2 in seconds, fetch ±5 days range
  const date = new Date(isoDate + 'T00:00:00Z');
  const period1 = Math.floor((date.getTime() - 5 * 24 * 3600 * 1000) / 1000);
  const period2 = Math.floor((date.getTime() + 5 * 24 * 3600 * 1000) / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?period1=${period1}&period2=${period2}&interval=1d`;
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    const r = json?.chart?.result?.[0];
    if (!r || !r.timestamp || !r.indicators?.quote?.[0]?.close) return null;
    const closes = r.indicators.quote[0].close;
    const target = date.getTime() / 1000;
    let bestIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < r.timestamp.length; i++) {
      const diff = Math.abs(r.timestamp[i] - target);
      if (closes[i] != null && diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }
    return {
      price: closes[bestIdx],
      date: new Date(r.timestamp[bestIdx] * 1000).toISOString().slice(0, 10),
      currency: r.meta?.currency || 'USD',
    };
  } catch {
    return null;
  }
}


/**
 * Fetch current price (latest close)
 */
async function fetchCurrentPrice(yahooSymbol) {
  if (!yahooSymbol) return null;
  try {
    const resp = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=5d`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
        },
      }
    );
    if (!resp.ok) return null;
    const json = await resp.json();
    const r = json?.chart?.result?.[0];
    if (!r) return null;
    return {
      price: r.meta?.regularMarketPrice || null,
      date: r.meta?.regularMarketTime
        ? new Date(r.meta.regularMarketTime * 1000).toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10),
      currency: r.meta?.currency || 'USD',
    };
  } catch {
    return null;
  }
}


/**
 * Main backtest endpoint handler.
 * GET /api/backtest/:filer?period=1y|3y|5y
 */
export async function handleBacktest(filerKey, periodKey, env) {
  if (!filerKey) {
    return { error: 'Missing filer parameter' };
  }
  const periodDays = PERIOD_TO_DAYS[periodKey] || PERIOD_TO_DAYS['1y'];

  // 1. Gather all positions for this filer
  const rawPositions = await gatherFilerPositions(filerKey, periodDays, env);
  if (rawPositions.length === 0) {
    return {
      filer: filerKey,
      period: periodKey,
      positions: [],
      summary: { totalPositions: 0, message: 'Aucune position trouvée pour ce filer sur cette période' },
    };
  }

  // 2. Pour chaque position, fetch prix entry et current
  // Lookup yahooSymbol via mapping (utilise eu_yahoo_symbols)
  const { lookupEuYahooSymbol } = await import('./eu_yahoo_symbols.js');
  const positions = await Promise.all(rawPositions.slice(0, 30).map(async (p) => {
    let yahooSymbol = p.ticker;
    if (p.country !== 'US' || !yahooSymbol) {
      const looked = lookupEuYahooSymbol(p.target, p.country);
      if (looked) yahooSymbol = looked;
    }
    if (!yahooSymbol) {
      return { ...p, yahooSymbol: null, returnPct: null, _skipReason: 'no_yahoo_symbol' };
    }
    const [entryPrice, currentPrice] = await Promise.all([
      fetchPriceAtDate(yahooSymbol, p.firstDate),
      fetchCurrentPrice(yahooSymbol),
    ]);
    if (!entryPrice || !currentPrice || !entryPrice.price || !currentPrice.price) {
      return { ...p, yahooSymbol, returnPct: null, _skipReason: 'no_price_data' };
    }
    const returnPct = ((currentPrice.price - entryPrice.price) / entryPrice.price) * 100;
    return {
      ...p,
      yahooSymbol,
      entryPrice: entryPrice.price,
      entryDate: entryPrice.date,
      currentPrice: currentPrice.price,
      currentDate: currentPrice.date,
      currency: currentPrice.currency,
      returnPct: Math.round(returnPct * 100) / 100,
    };
  }));

  // 3. Aggregate stats
  const validPositions = positions.filter(p => p.returnPct != null);
  const avgReturn = validPositions.length > 0
    ? validPositions.reduce((s, p) => s + p.returnPct, 0) / validPositions.length
    : 0;
  const winRate = validPositions.length > 0
    ? (validPositions.filter(p => p.returnPct > 0).length / validPositions.length) * 100
    : 0;
  const bestPosition = validPositions.length > 0
    ? validPositions.reduce((best, p) => (p.returnPct > (best?.returnPct || -Infinity) ? p : best), null)
    : null;
  const worstPosition = validPositions.length > 0
    ? validPositions.reduce((worst, p) => (p.returnPct < (worst?.returnPct || Infinity) ? p : worst), null)
    : null;

  // 4. Comparison vs benchmark : S&P 500 (default) ou CAC40 si majorité FR, etc.
  const countriesFreq = {};
  for (const p of validPositions) countriesFreq[p.country || 'US'] = (countriesFreq[p.country || 'US'] || 0) + 1;
  const dominantCountry = Object.keys(countriesFreq).sort((a, b) => countriesFreq[b] - countriesFreq[a])[0] || 'US';
  const benchmarkSymbol = SUFFIX_TO_BENCHMARK[dominantCountry] || SUFFIX_TO_BENCHMARK['US'];

  // Average entry date pour benchmark
  const entryTimestamps = validPositions
    .map(p => p.firstDate)
    .filter(Boolean)
    .map(d => new Date(d + 'T00:00:00Z').getTime());
  const avgEntryDate = entryTimestamps.length > 0
    ? new Date(entryTimestamps.reduce((s, t) => s + t, 0) / entryTimestamps.length).toISOString().slice(0, 10)
    : null;

  let benchmarkReturn = null;
  if (avgEntryDate) {
    const [bEntry, bCurrent] = await Promise.all([
      fetchPriceAtDate(benchmarkSymbol, avgEntryDate),
      fetchCurrentPrice(benchmarkSymbol),
    ]);
    if (bEntry?.price && bCurrent?.price) {
      benchmarkReturn = Math.round(((bCurrent.price - bEntry.price) / bEntry.price) * 10000) / 100;
    }
  }

  return {
    filer: filerKey,
    period: periodKey,
    positions: positions.sort((a, b) => (b.returnPct || -Infinity) - (a.returnPct || -Infinity)),
    summary: {
      totalPositions: rawPositions.length,
      validPositions: validPositions.length,
      avgReturn: Math.round(avgReturn * 100) / 100,
      winRate: Math.round(winRate * 10) / 10,
      bestPosition: bestPosition ? {
        target: bestPosition.target, ticker: bestPosition.yahooSymbol,
        returnPct: bestPosition.returnPct, country: bestPosition.country,
      } : null,
      worstPosition: worstPosition ? {
        target: worstPosition.target, ticker: worstPosition.yahooSymbol,
        returnPct: worstPosition.returnPct, country: worstPosition.country,
      } : null,
    },
    comparison: {
      benchmark: dominantCountry,
      benchmarkSymbol,
      benchmarkReturn,
      alpha: benchmarkReturn != null ? Math.round((avgReturn - benchmarkReturn) * 100) / 100 : null,
    },
    metadata: {
      computedAt: new Date().toISOString(),
      filerLabel: KNOWN_FILERS.find(f => f.key === filerKey.toUpperCase())?.label || filerKey,
      coverNote: 'MVP : entry = 1ère déclaration, exit = aujourd\'hui. À enrichir v9 avec exits réels.',
    },
  };
}
