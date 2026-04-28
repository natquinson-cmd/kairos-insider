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

// Benchmarks par pays - brut (PAS pre-encode, encodeURIComponent ferait double-encode)
const SUFFIX_TO_BENCHMARK = {
  'US': '^GSPC',    // S&P 500
  'FR': '^FCHI',    // CAC 40
  'UK': '^FTSE',    // FTSE 100
  'DE': '^GDAXI',   // DAX
  'NL': '^AEX',     // AEX
  'CH': '^SSMI',    // SMI
  'IT': 'FTSEMIB.MI', // FTSE MIB (pas de ^)
  'ES': '^IBEX',    // IBEX 35
  'SE': '^OMX',     // OMXS30
  'NO': '^OSEAX',   // OBX
  'DK': '^OMXC25',  // OMXC25
  'FI': '^OMXH25',  // OMXH25
};

const PERIOD_TO_DAYS = { '1y': 365, '3y': 1095, '5y': 1825 };

// Fonds vedettes pour la landing : 5 fonds tres reconnaissables qui resonnent
// avec le grand public. Cache 24h pour eviter recalcul a chaque load page.
// Note : ARNAULT et BOLLORE viennent rarement comme filer dans les KV.
// Selection : 1 activist EU + 1 institutional global + 1 sovereign +
//             1 activist US + 1 state FR
export const FEATURED_FILERS = ['CEVIAN', 'BLACKROCK', 'NORGES BANK', 'ELLIOTT', 'BPIFRANCE'];

// Liste des grands smart money pour autocomplete + acquisition
export const KNOWN_FILERS = [
  // Légendes
  { key: 'BERKSHIRE', label: 'Berkshire Hathaway (Warren Buffett)', country: 'US', tag: 'legend' },
  { key: 'BERKSHIRE HATHAWAY', label: 'Berkshire Hathaway (Warren Buffett)', country: 'US', tag: 'legend' },
  { key: 'BUFFETT', label: 'Berkshire Hathaway (Warren Buffett)', country: 'US', tag: 'legend' },
  { key: 'WARREN BUFFETT', label: 'Berkshire Hathaway (Warren Buffett)', country: 'US', tag: 'legend' },
  { key: 'MUNGER', label: 'Charlie Munger (Berkshire/Daily Journal)', country: 'US', tag: 'legend' },
  { key: 'BAUPOST', label: 'Baupost Group (Seth Klarman)', country: 'US', tag: 'legend' },
  { key: 'OAKMARK', label: 'Oakmark Funds (Bill Nygren)', country: 'US', tag: 'legend' },
  { key: 'TUDOR INVESTMENT', label: 'Tudor Investment (Paul Tudor Jones)', country: 'US', tag: 'legend' },
  { key: 'SOROS', label: 'Soros Fund Management (George Soros)', country: 'US', tag: 'legend' },
  { key: 'EINHORN', label: 'Greenlight Capital (David Einhorn)', country: 'US', tag: 'legend' },
  { key: 'GREENLIGHT', label: 'Greenlight Capital (David Einhorn)', country: 'US', tag: 'legend' },
  { key: 'COATUE', label: 'Coatue Management (Philippe Laffont)', country: 'US', tag: 'legend' },
  { key: 'TIGER GLOBAL', label: 'Tiger Global (Chase Coleman)', country: 'US', tag: 'legend' },
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
 * Cherche tous les filings d'un filer dans toutes les KV thresholds.
 * v2 : detection sortie reelle - si un filing 'down' suit un 'up' = exit point.
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

  // Group by target : detection entry/exit reelle
  // - 1er filing 'up' = entry
  // - 1er filing 'down' apres = exit (close position)
  // - Si seulement des 'up' = encore en position
  const byTarget = new Map();
  for (const m of matches) {
    const targetKey = (m.targetName || m.ticker || '').toUpperCase();
    if (!targetKey) continue;
    if (!byTarget.has(targetKey)) {
      byTarget.set(targetKey, {
        target: m.targetName || m.ticker,
        ticker: m.ticker || '',
        country: m.country || 'US',
        filings: [],
        kvSource: m._kvSource,
        regulator: m.regulator || '',
      });
    }
    byTarget.get(targetKey).filings.push(m);
  }

  // Pour chaque target, trie filings par date asc, identifie entry/exit
  const positions = [];
  for (const [targetKey, group] of byTarget) {
    const sorted = group.filings.slice().sort((a, b) =>
      (a.fileDate || '').localeCompare(b.fileDate || ''));

    // Detection entry/exit : on cherche le 1er 'up' puis le 1er 'down' apres
    const upFilings = sorted.filter(f => (f.crossingDirection || 'up') === 'up');
    const downFilings = sorted.filter(f => (f.crossingDirection || '') === 'down');
    const entryFiling = upFilings[0] || sorted[0];  // fallback : 1ère apparition
    let exitFiling = null;
    if (entryFiling) {
      exitFiling = downFilings.find(d => (d.fileDate || '') > (entryFiling.fileDate || '')) || null;
    }

    // % maximum atteint pendant la période
    let maxPercent = 0;
    for (const f of sorted) {
      const p = f.percentOfClass || f.crossingThreshold || 0;
      if (p > maxPercent) maxPercent = p;
    }

    positions.push({
      target: group.target,
      ticker: group.ticker,
      country: group.country,
      regulator: group.regulator,
      firstDate: entryFiling?.fileDate || sorted[0]?.fileDate,
      entryDate: entryFiling?.fileDate || sorted[0]?.fileDate,  // alias
      exitDate: exitFiling?.fileDate || null,  // null = encore en position
      maxPercent,
      filingsCount: sorted.length,
      isClosed: !!exitFiling,
      filings: sorted,
      kvSource: group.kvSource,
    });
  }

  return positions;
}


/**
 * Fetch full price timeline for a Yahoo symbol from start date to today.
 * Returns { timestamps: [unix], closes: [number], currency, marketPrice }
 *
 * Une seule requete par ticker - on lookup les dates entry/exit localement
 * (au lieu de 2 requetes par position). Optimisation cle vs v1.
 */
async function fetchPriceTimeline(yahooSymbol, startIso) {
  if (!yahooSymbol) return null;
  const startMs = startIso
    ? new Date(startIso + 'T00:00:00Z').getTime() - 7 * 24 * 3600 * 1000  // 7d buffer
    : Date.now() - 365 * 24 * 3600 * 1000;
  const period1 = Math.floor(startMs / 1000);
  const period2 = Math.floor(Date.now() / 1000);
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
    return {
      timestamps: r.timestamp,
      closes: r.indicators.quote[0].close,
      currency: r.meta?.currency || 'USD',
      marketPrice: r.meta?.regularMarketPrice || null,
      marketTime: r.meta?.regularMarketTime || null,
    };
  } catch {
    return null;
  }
}


/**
 * Lookup nearest trading day price within a fetched timeline.
 */
function priceAtDateLocal(timeline, isoDate) {
  if (!timeline || !timeline.timestamps || !isoDate) return null;
  const target = new Date(isoDate + 'T00:00:00Z').getTime() / 1000;
  let bestIdx = -1;
  let bestDiff = Infinity;
  for (let i = 0; i < timeline.timestamps.length; i++) {
    if (timeline.closes[i] == null) continue;
    const diff = Math.abs(timeline.timestamps[i] - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return null;
  return {
    price: timeline.closes[bestIdx],
    date: new Date(timeline.timestamps[bestIdx] * 1000).toISOString().slice(0, 10),
    currency: timeline.currency,
  };
}


/**
 * Fetch current price (latest close) - for benchmarks (no need for full timeline).
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
 * Fetch a price-at-date (for benchmark) using the fetchPriceTimeline helper.
 */
async function fetchPriceAtDate(yahooSymbol, isoDate) {
  const tl = await fetchPriceTimeline(yahooSymbol, isoDate);
  if (!tl) return null;
  return priceAtDateLocal(tl, isoDate);
}


/**
 * Run promises in batches of `concurrency` to respect Yahoo rate-limits.
 */
async function runWithConcurrency(items, concurrency, asyncFn) {
  const results = new Array(items.length);
  let nextIdx = 0;
  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= items.length) return;
      try {
        results[i] = await asyncFn(items[i], i);
      } catch (e) {
        results[i] = { error: String(e) };
      }
    }
  }
  const workers = Array(Math.min(concurrency, items.length)).fill(0).map(() => worker());
  await Promise.all(workers);
  return results;
}


/**
 * Featured filers handler : retourne les stats backtest 3y des 5 fonds
 * vedettes pour affichage landing page. Cache 24h dans KV.
 *
 * GET /api/backtest/featured[?refresh=1]
 */
export async function handleBacktestFeatured(env, opts = {}) {
  const cacheKey = 'backtest-featured-3y';
  if (!opts.refresh) {
    try {
      const cached = await env.CACHE.get(cacheKey, 'json');
      if (cached && cached.computedAt) {
        const age = (Date.now() - new Date(cached.computedAt).getTime()) / 1000;
        if (age < 86400) {  // 24h
          return cached;
        }
      }
    } catch {}
  }

  // Compute en parallele les 5 fonds (3y period)
  const results = await Promise.all(
    FEATURED_FILERS.map(async (filerKey) => {
      try {
        const data = await handleBacktest(filerKey, '3y', env);
        const s = data.summary || {};
        const c = data.comparison || {};
        const filerInfo = KNOWN_FILERS.find(f => f.key === filerKey) || {};
        return {
          key: filerKey,
          label: filerInfo.label || filerKey,
          tag: filerInfo.tag || 'unknown',
          country: filerInfo.country || 'GLOBAL',
          totalPositions: s.totalPositions || 0,
          validPositions: s.validPositions || 0,
          avgReturn: s.avgReturn,
          winRate: s.winRate,
          alpha: c.alpha,
          benchmark: c.benchmark,
          bestPosition: s.bestPosition || null,
          openPositions: s.openPositions || 0,
          closedPositions: s.closedPositions || 0,
        };
      } catch (e) {
        return { key: filerKey, error: String(e) };
      }
    })
  );

  const payload = {
    period: '3y',
    computedAt: new Date().toISOString(),
    filers: results,
  };

  try {
    await env.CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: 86400 + 3600 });
  } catch {}

  return payload;
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

  // 2. Pour chaque position, fetch UN SEUL timeline complet par ticker
  // (vs v1 : 2 fetch par position). Avec runWithConcurrency(5) pour
  // respecter rate-limit Yahoo. Beaucoup plus rapide -> permet 100+ positions.
  const { lookupEuYahooSymbol } = await import('./eu_yahoo_symbols.js');

  // Etape 2a : assigne yahooSymbol a chaque position
  const positionsWithSymbol = rawPositions.slice(0, 100).map(p => {
    let yahooSymbol = p.ticker;
    if (p.country !== 'US' || !yahooSymbol) {
      const looked = lookupEuYahooSymbol(p.target, p.country);
      if (looked) yahooSymbol = looked;
    }
    return { ...p, yahooSymbol };
  });

  // Etape 2b : group by yahooSymbol pour 1 fetch par ticker unique
  const symbolGroups = new Map();
  for (const p of positionsWithSymbol) {
    if (!p.yahooSymbol) continue;
    if (!symbolGroups.has(p.yahooSymbol)) {
      symbolGroups.set(p.yahooSymbol, { symbol: p.yahooSymbol, positions: [], minDate: p.firstDate });
    }
    const g = symbolGroups.get(p.yahooSymbol);
    g.positions.push(p);
    if (p.firstDate && p.firstDate < g.minDate) g.minDate = p.firstDate;
  }
  const uniqueSymbols = Array.from(symbolGroups.values());

  // Etape 2c : fetch timeline pour chaque ticker unique (concurrence = 5)
  const timelines = await runWithConcurrency(uniqueSymbols, 5, async (g) => {
    const tl = await fetchPriceTimeline(g.symbol, g.minDate);
    return { symbol: g.symbol, timeline: tl };
  });
  const timelineBySymbol = new Map();
  for (const t of timelines) {
    if (t && t.timeline) timelineBySymbol.set(t.symbol, t.timeline);
  }

  // Etape 2d : compute returns pour chaque position
  const positions = positionsWithSymbol.map(p => {
    if (!p.yahooSymbol) {
      return { ...p, returnPct: null, _skipReason: 'no_yahoo_symbol' };
    }
    const tl = timelineBySymbol.get(p.yahooSymbol);
    if (!tl) {
      return { ...p, returnPct: null, _skipReason: 'no_timeline' };
    }
    const entryPrice = priceAtDateLocal(tl, p.firstDate);
    // Exit price : si position fermée (filer franchit en baisse) -> prix au exitDate
    //              sinon -> prix actuel (latest close)
    let exitPrice = null;
    let exitDateUsed = null;
    let isStillOpen = true;
    if (p.exitDate) {
      exitPrice = priceAtDateLocal(tl, p.exitDate);
      exitDateUsed = p.exitDate;
      isStillOpen = false;
    } else {
      // Position encore active : utiliser dernier prix du timeline
      const lastIdx = tl.timestamps.length - 1;
      if (tl.closes[lastIdx] != null) {
        exitPrice = {
          price: tl.closes[lastIdx],
          date: new Date(tl.timestamps[lastIdx] * 1000).toISOString().slice(0, 10),
          currency: tl.currency,
        };
        exitDateUsed = exitPrice.date;
      } else {
        exitPrice = { price: tl.marketPrice, date: new Date().toISOString().slice(0, 10), currency: tl.currency };
        exitDateUsed = exitPrice.date;
      }
    }

    if (!entryPrice || !exitPrice || !entryPrice.price || !exitPrice.price) {
      return { ...p, returnPct: null, _skipReason: 'no_price_data', isStillOpen };
    }
    const returnPct = ((exitPrice.price - entryPrice.price) / entryPrice.price) * 100;
    return {
      ...p,
      yahooSymbol: p.yahooSymbol,
      entryPrice: entryPrice.price,
      entryDate: entryPrice.date,
      exitPrice: exitPrice.price,
      exitDate: exitDateUsed,
      currentPrice: exitPrice.price,  // alias for backward compat
      currentDate: exitDateUsed,       // alias
      currency: exitPrice.currency,
      returnPct: Math.round(returnPct * 100) / 100,
      isStillOpen,
    };
  });

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

  // Equity curve : portfolio simule equipondere des positions actives
  // Pour chaque position avec timeline, on lookup les prix par decade de jours
  // et on cumule le ratio (price_t / price_entry) - 1 normalise.
  // Resultat : tableau { date, totalReturnPct } sur la periode.
  const equityCurve = computeEquityCurve(validPositions, timelineBySymbol, periodDays);

  // Stats supplementaires v2
  const closedPositions = validPositions.filter(p => !p.isStillOpen);
  const openPositions = validPositions.filter(p => p.isStillOpen);
  const closedReturns = closedPositions.map(p => p.returnPct);
  const avgReturnClosed = closedReturns.length > 0
    ? closedReturns.reduce((s, x) => s + x, 0) / closedReturns.length
    : null;

  return {
    filer: filerKey,
    period: periodKey,
    positions: positions.sort((a, b) => (b.returnPct || -Infinity) - (a.returnPct || -Infinity)),
    summary: {
      totalPositions: rawPositions.length,
      validPositions: validPositions.length,
      closedPositions: closedPositions.length,
      openPositions: openPositions.length,
      avgReturn: Math.round(avgReturn * 100) / 100,
      avgReturnClosed: avgReturnClosed != null ? Math.round(avgReturnClosed * 100) / 100 : null,
      winRate: Math.round(winRate * 10) / 10,
      bestPosition: bestPosition ? {
        target: bestPosition.target, ticker: bestPosition.yahooSymbol,
        returnPct: bestPosition.returnPct, country: bestPosition.country,
        entryDate: bestPosition.entryDate, exitDate: bestPosition.exitDate,
        isStillOpen: bestPosition.isStillOpen,
      } : null,
      worstPosition: worstPosition ? {
        target: worstPosition.target, ticker: worstPosition.yahooSymbol,
        returnPct: worstPosition.returnPct, country: worstPosition.country,
        entryDate: worstPosition.entryDate, exitDate: worstPosition.exitDate,
        isStillOpen: worstPosition.isStillOpen,
      } : null,
    },
    comparison: {
      benchmark: dominantCountry,
      benchmarkSymbol,
      benchmarkReturn,
      alpha: benchmarkReturn != null ? Math.round((avgReturn - benchmarkReturn) * 100) / 100 : null,
    },
    equityCurve,
    metadata: {
      computedAt: new Date().toISOString(),
      filerLabel: KNOWN_FILERS.find(f => f.key === filerKey.toUpperCase())?.label || filerKey,
      uniqueTickers: uniqueSymbols.length,
      symbolsWithTimeline: timelineBySymbol.size,
      coverNote: 'v2 : detection sortie reelle (filer franchit en baisse). Position encore active = exit = aujourd\'hui.',
    },
  };
}


/**
 * Build equity curve : evolution % portfolio equipondere des positions actives
 * sur la periode. Sample 1 point par 7 jours.
 */
function computeEquityCurve(positions, timelineBySymbol, periodDays) {
  if (!positions || positions.length === 0) return [];

  const now = Date.now();
  const start = now - periodDays * 24 * 3600 * 1000;
  const samplingDays = Math.max(7, Math.floor(periodDays / 50));  // ~50 points sur la courbe

  // Indexer les positions actives par ticker pour lookup rapide
  const activePositions = positions.filter(p => p.yahooSymbol && p.firstDate);
  if (activePositions.length === 0) return [];

  const points = [];
  for (let t = start; t <= now; t += samplingDays * 24 * 3600 * 1000) {
    const dateStr = new Date(t).toISOString().slice(0, 10);
    let totalRet = 0;
    let count = 0;
    for (const p of activePositions) {
      if (p.firstDate > dateStr) continue;  // pas encore entré
      // Si position fermée et date après exit, on garde le rendement à exit (frozen)
      const cutoffDate = (p.exitDate && dateStr > p.exitDate) ? p.exitDate : dateStr;
      const tl = timelineBySymbol.get(p.yahooSymbol);
      if (!tl) continue;
      const px = priceAtDateLocal(tl, cutoffDate);
      if (!px || !px.price || !p.entryPrice) continue;
      const ret = ((px.price - p.entryPrice) / p.entryPrice) * 100;
      totalRet += ret;
      count++;
    }
    if (count > 0) {
      points.push({
        date: dateStr,
        totalReturnPct: Math.round((totalRet / count) * 100) / 100,
        positions: count,
      });
    }
  }
  return points;
}
