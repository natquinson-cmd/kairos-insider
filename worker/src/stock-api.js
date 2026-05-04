/**
 * Kairos Insider — Analyse action (ticker deep-dive)
 *
 * Endpoint : GET /api/stock/:ticker (premium) ou /public/stock/:ticker (SEO tronque)
 *
 * Agrege en parallele :
 *   - Prix + chart + fondamentaux (Yahoo Finance, non-officiel)
 *   - News RSS (Yahoo Finance)
 *   - Analyst consensus (Finnhub, optionnel si FINNHUB_KEY defini)
 *   - Insiders (SEC + BaFin + AMF) depuis KV insider-transactions
 *   - Smart Money 13F depuis KV 13f-all-funds
 *   - ETF Politiciens / Gurus (NANC, GOP, GURU) depuis KV etf-*
 *
 * Calcule un "Kairos Score" composite (0-100) avec 6 sous-scores transparents :
 *   Insider (25) + SmartMoney (25) + GovGuru (15) + Momentum (15) + Valo (10) + Analyst (10)
 *
 * Cache KV 15 min par ticker pour limiter les hits Yahoo/Finnhub.
 *
 * TODO futurs (rappel projet) :
 *   - Google Trends (interet web)
 *   - Reddit WSB mentions + sentiment
 *   - Insider buy/sell ratio sectoriel
 *   - Options flow (call/put ratio)
 *   - Earnings surprises history
 */

import { aggregateEuThresholds } from './eu_thresholds_aggregator.js';
import { fetchZonebourseConsensus } from './zonebourse_consensus.js';

const YAHOO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
const CACHE_TTL = 900; // 15 min

// ============================================================
// fetchWithRetry : fetch resilient avec retry + backoff exponentiel
// ============================================================
// Usage : const resp = await fetchWithRetry(url, { headers }, { retries: 2, backoffMs: 400 })
// Retry UNIQUEMENT sur :
//   - exception reseau (timeout, DNS, reset)
//   - status 5xx (server error)
//   - status 429 (rate limit, avec backoff respectant Retry-After si present)
// JAMAIS retry sur 4xx != 429 (logique metier : la source dit "bad request", pas la peine d'insister).
async function fetchWithRetry(url, init = {}, opts = {}) {
  const { retries = 2, backoffMs = 400, label = '' } = opts;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, init);
      if (resp.ok) return resp;
      // Retry sur 5xx et 429
      if (resp.status >= 500 || resp.status === 429) {
        if (attempt < retries) {
          // Respect Retry-After si header present (sinon backoff exponentiel)
          const retryAfter = resp.headers.get('Retry-After');
          const wait = retryAfter && !isNaN(parseInt(retryAfter, 10))
            ? Math.min(parseInt(retryAfter, 10) * 1000, 5000)
            : backoffMs * Math.pow(2, attempt);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
      }
      // 4xx != 429 : pas de retry, on retourne direct la reponse pour que
      // le caller decide (souvent : default/empty).
      return resp;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        const wait = backoffMs * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
    }
  }
  // Tous les retries echouent : on throw l'exception pour que le caller
  // (qui est deja dans un try/catch) puisse retourner la valeur par defaut.
  throw lastErr || new Error(`fetchWithRetry failed: ${label || url}`);
}

// ============================================================
// ENTREE PRINCIPALE
// ============================================================
export async function handleStockAnalysis(rawInput, env, options = {}) {
  const { publicView = false, chartRange = '1y' } = options;
  // userInputRaw : garde les espaces et accents pour Yahoo Search
  // (UBS AG, BlackRock Inc., LVMH Moet Hennessy, etc.)
  const userInputRaw = String(rawInput || '').toUpperCase().trim().slice(0, 80);
  // userInput : version sanitised pour Yahoo direct ticker (sans espaces/special)
  const userInput = userInputRaw.replace(/[^A-Z0-9.\-]/g, '');
  if (!userInputRaw || userInputRaw.length === 0) {
    return { error: 'Invalid ticker', code: 'INVALID_TICKER' };
  }
  // Si l'input contient des espaces/caracteres specials, c'est une RECHERCHE par nom
  // -> on force Yahoo Search resolver. Sinon on utilise le ticker direct.
  const isSearchByName = userInputRaw !== userInput || userInputRaw.length > 12;

  // ============================================================
  // RESOLUTION INTELLIGENTE DU TICKER (v2)
  // L'utilisateur peut taper : LVMH, BARCLAYS, NESTLE, SAP, etc.
  // -> on doit les mapper vers leur ticker Yahoo (MC.PA, BARC.L, NESN.SW, SAP.DE)
  // Sinon Yahoo retourne null et on affiche "small cap regional" pour LVMH
  // qui est UNE DES PLUS GRANDES CAP MONDIALES.
  // ============================================================
  let ticker = userInput || userInputRaw;
  let originalInput = userInputRaw;  // ce que l'user a tape (avec espaces pour search by name)
  let resolvedFromName = false;

  // Si pas de suffix Yahoo (.PA, .L, .DE, etc.) ET pas un ticker US connu,
  // tenter de resolver via 1) Yahoo Search (universel) 2) mapping local
  const hasYahooSuffix = /\.(PA|L|DE|AS|SW|MI|MC|ST|OL|CO|HE|TO|AX|HK|SG)$/i.test(ticker);

  if (!hasYahooSuffix || isSearchByName) {
    // STRATEGIE 1 : Yahoo Search (universel, accepte espaces et nom complet)
    try {
      const yahooResolved = await resolveTickerViaYahooSearch(userInputRaw, env);
      if (yahooResolved && yahooResolved !== userInputRaw && yahooResolved !== ticker) {
        ticker = yahooResolved;
        resolvedFromName = true;
        console.log(`[STOCK] Yahoo Search "${userInputRaw}" -> "${ticker}"`);
      }
    } catch {}

    // STRATEGIE 2 : fallback sur le mapping local (instantanee)
    if (!resolvedFromName) {
      try {
        const { lookupEuYahooSymbol } = await import('./eu_yahoo_symbols.js');
        const looked = lookupEuYahooSymbol(userInputRaw, null);
        if (looked && looked !== userInputRaw) {
          ticker = looked;
          resolvedFromName = true;
          console.log(`[STOCK] Local mapping "${userInputRaw}" -> "${ticker}"`);
        }
      } catch {}
    }
  }

  // Si on n'a toujours pas resolu et que l'input n'est pas un ticker valide,
  // on retourne une erreur claire (pas 400 silencieux)
  if (!ticker || ticker.length === 0 || (isSearchByName && !resolvedFromName)) {
    return {
      error: `Aucun ticker trouve pour "${userInputRaw}"`,
      code: 'TICKER_NOT_FOUND',
      originalInput: userInputRaw,
    };
  }

  // Valide le range (Yahoo supporte : 1d, 5d, 1mo, 3mo, 6mo, 1y, 2y, 5y, 10y, ytd, max)
  const ALLOWED_RANGES = ['1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'max'];
  const effectiveRange = ALLOWED_RANGES.includes(chartRange) ? chartRange : '1y';

  // Cache : 2 variantes (public tronque / premium complet) x range
  // v7 : bump apres bump cache slug ZB v2 (forcer recalcul complet)
  const cacheKey = `stock-analysis:v7:${ticker}:${publicView ? 'pub' : 'full'}:${effectiveRange}`;
  const cached = await env.CACHE.get(cacheKey, 'json');
  if (cached && cached._cachedAt && (Date.now() - cached._cachedAt) < CACHE_TTL * 1000) {
    return cached;
  }

  // Etape 1 : insiders d'abord (pour extraire le company name fiable)
  const insiders = await aggregateInsiders(ticker, env);
  const companyNameFromInsiders = (insiders.transactions[0] && insiders.transactions[0].company) || null;

  // Etape 2 : tout le reste en parallele (avec le company name pour le 13F)
  // Sources stockanalysis.com en parallele : overview + statistics + earnings + employees (peers)
  // + euThresholds : aggregateur cross-KV (AMF/FCA/SIX/AFM/BaFin) pour les actions EU
  let [quote, overview, statistics, earningsData, employeesData, news, smartMoney, govEtf, googleTrends, euThresholds] = await Promise.all([
    fetchYahooQuote(ticker, effectiveRange),
    fetchStockAnalysisOverview(ticker),
    fetchStockAnalysisStatistics(ticker),
    fetchStockAnalysisEarnings(ticker),
    fetchStockAnalysisEmployees(ticker),
    fetchYahooNews(ticker),
    aggregate13F(ticker, env, companyNameFromInsiders),
    aggregateGovEtf(ticker, env),
    fetchGoogleTrends(ticker, env),
    aggregateEuThresholds(ticker, env),
  ]);

  // ZONEBOURSE CONSENSUS : recommandations analystes pour actions EU
  // Utile car stockanalysis.com ne couvre pas .PA, .DE, .SW, .MI, .MC, .AS
  // Donne : consensus (Achat/Conserver), recommendationMean (ACCUMULER),
  // analystCount (nb), targetMean (objectif moyen), ecartTargetPct (% upside)
  // + fundamentals : marketCap, PER, EPS, dividendYield, high/low 52w
  let zonebourseConsensus = null;
  try {
    if (hasYahooSuffix || /\.(PA|L|DE|AS|SW|MI|MC|ST|OL|CO|HE)$/i.test(ticker)) {
      const companyForLookup = (quote?.company?.name) || userInput;
      // v3 : on passe yahooSymbol pour la validation par ticker short dans le title.
      // Indispensable car Zonebourse a plusieurs cotations par titre (Paris MC vs
      // Moscow MOH) et la search retourne souvent le mauvais (LVMH-111960885 = page
      // news sans consensus, vs LVMH-4669 = vraie cotation Paris).
      zonebourseConsensus = await fetchZonebourseConsensus(companyForLookup, env, {
        yahooSymbol: ticker,
      });
    }
  } catch {}

  // Le merge defensive avec stockanalysis.com peut crasher selon les retours
  // (overview/statistics peuvent etre malforms). On expose juste zonebourseConsensus
  // dans le payload final, le frontend gere le rendering.
  // (merge plus complexe a faire en v2 quand on aura debugge fetchStockAnalysisOverview)

  // FALLBACK FILET DE SECURITE : si Yahoo a echoue (price.current null) ET
  // qu'on n'a pas deja resolu via mapping en debut, tenter le mapping ici.
  // Couvre le cas ou un ticker court (ex: "ENI") matche un ticker US-like
  // mais devrait en fait aller vers ENI.MI, etc.
  if ((!quote || !quote.price || !quote.price.current) && !resolvedFromName && !hasYahooSuffix) {
    try {
      const { lookupEuYahooSymbol } = await import('./eu_yahoo_symbols.js');
      const looked = lookupEuYahooSymbol(userInput, null);
      if (looked && looked !== ticker) {
        console.log(`[STOCK] Fallback retry "${ticker}" -> "${looked}" after Yahoo null`);
        ticker = looked;
        resolvedFromName = true;
        // Refetch les sources qui dependent du ticker (Yahoo + stockanalysis)
        [quote, overview, statistics, earningsData, employeesData, news] = await Promise.all([
          fetchYahooQuote(ticker, effectiveRange),
          fetchStockAnalysisOverview(ticker),
          fetchStockAnalysisStatistics(ticker),
          fetchStockAnalysisEarnings(ticker),
          fetchStockAnalysisEmployees(ticker),
          fetchYahooNews(ticker),
        ]);
        // Re-fetch euThresholds avec le nouveau ticker (yahooSymbol detect)
        euThresholds = await aggregateEuThresholds(ticker, env);
      }
    } catch (e) {
      // mapping fail - garder le ticker initial
    }
  }
  // Fusion : overview + statistics pour les fondamentaux (statistics = plus complet)
  // FALLBACK EU : pour les actions europeennes, stockanalysis.com renvoie {} vide
  // donc on merge les fondamentaux Zonebourse en complement (marketCap, PER, EPS,
  // dividendYield, high52w, low52w). Important pour LVMH, BNP, ASML, Nestle, etc.
  const fundamentals = {
    ...((zonebourseConsensus && zonebourseConsensus.fundamentals) || {}),
    ...overview.fundamentals,
    ...statistics.fundamentals,  // stockanalysis prioritaire si dispo (US)
  };
  // ENRICHISSEMENT additionnel pour EU : fallback depuis Yahoo quote.price
  // (52w high/low, currency, exchange). Yahoo chart endpoint marche pour TOUS
  // les tickers EU et fournit ces champs gratuitement, donc on remplit les
  // trous quand stockanalysis + Zonebourse n'ont pas la data.
  if (quote && quote.price) {
    const p = quote.price;
    if (fundamentals.high52w == null && p.high52w != null) fundamentals.high52w = p.high52w;
    if (fundamentals.low52w == null && p.low52w != null) fundamentals.low52w = p.low52w;
    if (!fundamentals.currency && p.currency) fundamentals.currency = p.currency;
    if (!fundamentals.exchange && p.exchange) fundamentals.exchange = p.exchange;
    // Variation YTD utile pour le scoring momentum
    if (fundamentals.changeYtdPct == null && p.changeYtdPct != null) fundamentals.changeYtdPct = p.changeYtdPct;
    if (fundamentals.change1yPct == null && p.change1yPct != null) fundamentals.change1yPct = p.change1yPct;
  }

  // ENRICHISSEMENT FINNHUB : pour les actions EU principalement (mais aussi US
  // si stockanalysis a des trous). Couvre marketCap, P/E, EPS, P/S, P/B, beta,
  // ROE, ROA, marges, enterprise value, financialPosition + earnings + peers.
  // Free tier 60 calls/min, cache 24h dans KV.
  // Activer en setant le secret FINNHUB_KEY : `wrangler secret put FINNHUB_KEY`.
  let finnhubMetrics = null;
  let finnhubEarnings = null;
  let finnhubCalendar = null;
  let finnhubPeers = null;
  if (env.FINNHUB_KEY) {
    // Parallel pour gagner du temps (4 endpoints differents Finnhub)
    [finnhubMetrics, finnhubEarnings, finnhubCalendar, finnhubPeers] = await Promise.all([
      fetchFinnhubMetrics(ticker, env.FINNHUB_KEY, env).catch(() => null),
      fetchFinnhubEarnings(ticker, env.FINNHUB_KEY, env).catch(() => null),
      fetchFinnhubEarningsCalendar(ticker, env.FINNHUB_KEY, env).catch(() => null),
      fetchFinnhubPeers(ticker, env.FINNHUB_KEY, env).catch(() => null),
    ]);
  }
  let extendedRatios = statistics.extendedRatios || {};
  let margins = statistics.margins || {};
  let returns = statistics.returns || {};
  let financialPosition = statistics.financialPosition || {};
  if (finnhubMetrics) {
    const fnh = finnhubMetrics;
    const fields = ['marketCap', 'enterpriseValue', 'revenue', 'netIncome', 'sharesOut',
      'peRatio', 'forwardPE', 'psRatio', 'pbRatio', 'pfcf', 'evEbitda',
      'eps', 'beta', 'dividendYield', 'dividendsPerShare', 'payoutRatio',
      'high52w', 'low52w', 'profitMargin'];
    for (const k of fields) {
      if (fundamentals[k] == null && fnh[k] != null) fundamentals[k] = fnh[k];
    }
    if (fnh.extendedRatios) {
      extendedRatios = { ...fnh.extendedRatios, ...extendedRatios };
    }
    if (fnh.margins) {
      for (const k of ['gross', 'operating', 'profit', 'fcf']) {
        if ((!margins[k] || !margins[k].display) && fnh.margins[k] && fnh.margins[k].display) {
          margins[k] = fnh.margins[k];
        }
      }
    }
    if (fnh.returns) {
      for (const k of ['roe', 'roa', 'roic', 'roce']) {
        if ((!returns[k] || !returns[k].display) && fnh.returns[k] && fnh.returns[k].display) {
          returns[k] = fnh.returns[k];
        }
      }
    }
    // Financial position (Sante financiere) : fallback Finnhub si stockanalysis vide
    if (fnh.financialPosition) {
      for (const k of ['currentRatio', 'quickRatio', 'debtEquity', 'debtEbitda', 'interestCoverage']) {
        if ((!financialPosition[k] || !financialPosition[k].display) && fnh.financialPosition[k] && fnh.financialPosition[k].display) {
          financialPosition[k] = fnh.financialPosition[k];
        }
      }
    }
  }

  // FUSION earnings : prend stockanalysis (US) sinon Finnhub (EU)
  // Le panneau 'Resultats trimestriels' a besoin de earnings.history et earnings.next
  let mergedEarnings = earningsData || { history: [], next: null };
  // Si stockanalysis n'a pas d'historique mais Finnhub si -> fallback
  if ((!mergedEarnings.history || mergedEarnings.history.length === 0) && finnhubEarnings && finnhubEarnings.history && finnhubEarnings.history.length > 0) {
    mergedEarnings = { ...mergedEarnings, history: finnhubEarnings.history };
  }
  // Si stockanalysis n'a pas de next earnings mais Finnhub si -> fallback
  if (!mergedEarnings.next && finnhubCalendar && finnhubCalendar.next) {
    mergedEarnings = { ...mergedEarnings, next: finnhubCalendar.next };
  }

  // FUSION peers : prend stockanalysis (US, avec name + employees) sinon Finnhub (EU, ticker only)
  let mergedPeers = (employeesData && employeesData.peers) || [];
  if (mergedPeers.length === 0 && finnhubPeers && finnhubPeers.peers && finnhubPeers.peers.length > 0) {
    mergedPeers = finnhubPeers.peers;
  }

  // FUSION health : stockanalysis a Altman Z + Piotroski F (US uniquement). Pour
  // les EU, on a calcule un Health Score Kairos (proxy sur 7 criteres) depuis
  // Finnhub. Si stockanalysis renvoie vide, on expose le score Kairos.
  let mergedHealth = statistics.health || {};
  if ((!mergedHealth.altmanZ && !mergedHealth.piotroskiF) && finnhubMetrics && finnhubMetrics.healthScore) {
    mergedHealth = { ...mergedHealth, kairosScore: finnhubMetrics.healthScore };
  }
  // Pour le consensus, prefere stockanalysis (format normalise) sinon synthese
  // ENRICHIE depuis Zonebourse : breakdown buy/hold/sell synthetise a partir
  // de la note gauge (0-10) + analystCount, format identique a stockanalysis.com
  // pour que le frontend AffiCHE le tableau Achat fort/Achat/Conserver/Vente/etc.
  let consensus = overview.consensus;
  if (!consensus && zonebourseConsensus && (zonebourseConsensus.analystCount || zonebourseConsensus.targetMean)) {
    consensus = synthesizeConsensusFromZonebourse(zonebourseConsensus);
  }

  // Poids du Kairos Score : parametrables via console admin → KV config:score-weights.
  // Cache 1h : la config ne change pas souvent et les appels stockAnalysis sont
  // tres frequents. Fallback sur les poids par defaut si KV vide ou invalide.
  let scoreWeights = null;
  try {
    const w = await env.CACHE.get('config:score-weights', 'json');
    if (w && typeof w === 'object') scoreWeights = w;
  } catch {}

  const score = computeKairosScore({
    insiders, smartMoney, govEtf, quote, fundamentals, consensus,
    health: statistics.health, earnings: mergedEarnings,
    euThresholds,  // EU activists/holdings (AMF/FCA/SIX/AFM/BaFin)
    weights: scoreWeights,
  });

  const result = {
    ticker,
    originalInput,                  // ce qu'a tape l'utilisateur (ex: "LVMH")
    resolvedFromName,               // true si on a fait LVMH -> MC.PA
    updatedAt: new Date().toISOString(),
    _cachedAt: Date.now(),
    company: {
      name: (overview.profile && overview.profile.name) || (quote && quote.company && quote.company.name) || ticker,
      sector: (overview.profile && overview.profile.sector) || null,
      industry: (overview.profile && overview.profile.industry) || null,
      country: (overview.profile && overview.profile.country) || null,
      website: (overview.profile && overview.profile.website) || null,
      description: (overview.profile && overview.profile.description) || null,
      employees: (employeesData.stats && employeesData.stats.current) || (overview.profile && overview.profile.employees) || null,
      employeesGrowth: (employeesData.stats && employeesData.stats.growth) || null,
      exchange: (overview.profile && overview.profile.exchange) || null,
      ceo: (overview.profile && overview.profile.ceo) || null,
      founded: (overview.profile && overview.profile.founded) || null,
      headquarters: (overview.profile && overview.profile.headquarters) || null,
      ipoDate: (overview.profile && overview.profile.ipoDate) || null,
      fiscalYearEnd: (overview.profile && overview.profile.fiscalYearEnd) || null,
      isin: (overview.profile && overview.profile.isin) || null,
    },
    price: quote.price,
    chart: quote.chart,
    fundamentals,
    extendedRatios,                              // P/S, PEG, EV/EBITDA (stockanalysis + Finnhub merged)
    margins,                                     // Gross, Operating, Profit, FCF (idem)
    returns,                                     // ROE, ROA, ROIC, ROCE (idem)
    financialPosition,                           // Current, Quick, D/E, D/EBITDA (stockanalysis + Finnhub)
    health: mergedHealth,                        // Altman Z + Piotroski F (US) ou kairosScore (EU)
    shortInterest: statistics.shortInterest,     // Short %, days to cover
    fairValue: statistics.fairValue,             // Lynch, Graham
    earnings: mergedEarnings,                    // history + next (stockanalysis US + Finnhub EU fallback)
    peers: mergedPeers,                          // concurrents sectoriels (stockanalysis + Finnhub fallback)
    score,
    insiders,
    smartMoney,
    euThresholds,  // Filings EU (AMF/FCA/SIX/AFM/BaFin) sur ce ticker
    govEtf,
    googleTrends,
    news,
    consensus,
    zonebourseConsensus,  // Recommandations analystes Zonebourse (EU)
  };

  // Tronquer les sections premium pour la vue publique SEO
  if (publicView) {
    result._truncated = true;
    if (result.insiders && result.insiders.transactions) {
      result.insiders._totalTransactions = result.insiders.transactions.length;
      result.insiders.transactions = result.insiders.transactions.slice(0, 3);
    }
    if (result.smartMoney && result.smartMoney.topFunds) {
      result.smartMoney._totalFunds = result.smartMoney.topFunds.length;
      result.smartMoney.topFunds = result.smartMoney.topFunds.slice(0, 2);
    }
    if (result.news && Array.isArray(result.news)) {
      result._totalNews = result.news.length;
      result.news = result.news.slice(0, 2);
    }
    // Masquer le breakdown detaille des sous-scores (garder juste le score global)
    if (result.score && result.score.breakdown) {
      result.score._breakdownHidden = true;
      result.score.breakdown = null;
    }
  }

  // Cache KV 15 min
  try {
    await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL });
  } catch (e) {
    console.error('KV cache put failed:', e);
  }

  return result;
}

// ============================================================
// YAHOO SEARCH : autocomplete multi-resultats (pour dropdown UI)
// Retourne plusieurs candidats {symbol, shortname, exchange, type}
// + RE-RANKING EU : kairos est franco-europeen, on boost les .PA/.DE/.AS/.SW/.L/.MI
// pour qu'un user qui tape "hermes" voit RMS.PA AVANT Federated Hermes US.
// ============================================================
const EU_PRIORITY_SUFFIXES = ['.PA', '.AS', '.SW', '.DE', '.MI', '.MC', '.L', '.ST', '.OL', '.CO', '.HE', '.BR', '.LS', '.WA', '.PR', '.IR', '.HE', '.AT'];
const CAC40_FAST_LOOKUP = {
  // Mapping RAPIDE des noms communs FR -> ticker exact CAC40 / SBF120.
  // Garantit que ces resultats sont en TETE peu importe ce que renvoie Yahoo.
  'LVMH': 'MC.PA', 'HERMES': 'RMS.PA', 'LOREAL': 'OR.PA', "L'OREAL": 'OR.PA',
  'TOTAL': 'TTE.PA', 'TOTALENERGIES': 'TTE.PA', 'SANOFI': 'SAN.PA',
  'AIRBUS': 'AIR.PA', 'KERING': 'KER.PA', 'AXA': 'CS.PA',
  'BNP': 'BNP.PA', 'BNP PARIBAS': 'BNP.PA', 'CARREFOUR': 'CA.PA',
  'CAPGEMINI': 'CAP.PA', 'DANONE': 'BN.PA', 'VINCI': 'DG.PA',
  'SAFRAN': 'SAF.PA', 'SCHNEIDER': 'SU.PA', 'STELLANTIS': 'STLAP.PA',
  'STM': 'STM.PA', 'STMICRO': 'STM.PA', 'STMICROELECTRONICS': 'STM.PA',
  'THALES': 'HO.PA', 'PERNOD': 'RI.PA', 'PERNOD RICARD': 'RI.PA',
  'PUBLICIS': 'PUB.PA', 'SAINT GOBAIN': 'SGO.PA', 'SAINT-GOBAIN': 'SGO.PA',
  'ACCOR': 'AC.PA', 'AIR LIQUIDE': 'AI.PA', 'BOUYGUES': 'EN.PA',
  'DASSAULT': 'DSY.PA', 'DASSAULT SYSTEMES': 'DSY.PA',
  'ESSILOR': 'EL.PA', 'ESSILORLUXOTTICA': 'EL.PA', 'ENGIE': 'ENGI.PA',
  'EUROFINS': 'ERF.PA', 'LEGRAND': 'LR.PA', 'MICHELIN': 'ML.PA',
  'ORANGE': 'ORA.PA', 'RENAULT': 'RNO.PA', 'SOCIETE GENERALE': 'GLE.PA',
  'SOGEN': 'GLE.PA', 'TELEPERFORMANCE': 'TEP.PA', 'VEOLIA': 'VIE.PA',
  'VIVENDI': 'VIV.PA', 'WORLDLINE': 'WLN.PA', 'ALSTOM': 'ALO.PA',
  'UNIBAIL': 'URW.AS', 'UNIBAIL RODAMCO': 'URW.AS',
};

export async function searchTickersAutocomplete(query, env, limit = 10) {
  if (!query || query.length < 1) return [];
  // v2 : bump apres ajout EU re-ranking + CAC40 fast-lookup
  const cacheKey = `yahoo-autocomplete:v2:${String(query).toLowerCase().trim()}`;
  if (env && env.CACHE) {
    try {
      const cached = await env.CACHE.get(cacheKey, 'json');
      if (cached && Array.isArray(cached.results)) return cached.results;
    } catch {}
  }
  try {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=${limit + 5}&newsCount=0`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': YAHOO_UA, 'Accept': 'application/json' },
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const quotes = (data?.quotes || []).filter(q => q.symbol && (q.shortname || q.longname));

    // Normalize : retourne juste les champs utiles UI
    let results = quotes.map(q => ({
      symbol: q.symbol,
      name: q.longname || q.shortname,
      exchange: q.exchange || q.exchDisp || '',
      exchangeFull: q.exchDisp || q.exchange || '',
      type: q.quoteType || q.typeDisp || '',
      industry: q.industry || null,
      sector: q.sector || null,
    }));

    // FAST-LOOKUP CAC40 : si la query matche EXACTEMENT un nom commun FR
    // (LVMH, Hermes, etc.), on injecte ce ticker en TETE meme si Yahoo
    // l'a retrograde. Garantit la decouvrabilite pour le user FR.
    const queryUpper = String(query).toUpperCase().trim();
    const fastTicker = CAC40_FAST_LOOKUP[queryUpper] ||
      CAC40_FAST_LOOKUP[queryUpper.replace(/[^A-Z]/g, ' ').replace(/\s+/g, ' ').trim()];
    if (fastTicker) {
      const existing = results.find(r => r.symbol === fastTicker);
      if (existing) {
        // Le ticker est deja dans les resultats : remonter en tete
        results = [existing, ...results.filter(r => r.symbol !== fastTicker)];
      }
      // Si Yahoo n'a pas du tout retourne le ticker, on injecte un placeholder.
      // Le frontend pourra resoudre via /api/stock/{ticker} ensuite.
      else if (!existing) {
        results.unshift({
          symbol: fastTicker,
          name: queryUpper + ' (CAC 40)',
          exchange: 'PAR',
          exchangeFull: 'Paris',
          type: 'EQUITY',
          industry: null,
          sector: null,
          _injected: true,
        });
      }
    }

    // RE-RANK EU : pour les EQUITY, push les EU (.PA, .DE, .AS, ...) AVANT
    // les CDR/OTC/US/etc. sans deplacer le fast-lookup.
    const isEuTicker = (sym) => EU_PRIORITY_SUFFIXES.some(suf => sym.endsWith(suf));
    const isEquityEu = (r) => r.type === 'EQUITY' && isEuTicker(r.symbol);
    const isOtherEquity = (r) => r.type === 'EQUITY' && !isEuTicker(r.symbol);
    const fastResult = fastTicker ? results.find(r => r.symbol === fastTicker) : null;
    const remaining = results.filter(r => r !== fastResult);
    results = [
      ...(fastResult ? [fastResult] : []),
      ...remaining.filter(isEquityEu),
      ...remaining.filter(isOtherEquity),
      ...remaining.filter(r => r.type !== 'EQUITY'),
    ].slice(0, limit);

    if (env && env.CACHE) {
      try {
        await env.CACHE.put(cacheKey, JSON.stringify({ results, fetchedAt: new Date().toISOString() }),
          { expirationTtl: 7 * 86400 });
      } catch {}
    }
    return results;
  } catch {
    return [];
  }
}


// ============================================================
// YAHOO SEARCH : resolution universelle ticker (LVMH -> MC.PA, FDJ -> FDJU.PA)
// Suit automatiquement les renames de ticker (LFD -> FDJU recently).
// Cache 7 jours (les tickers ne changent pas tous les jours).
// ============================================================
async function resolveTickerViaYahooSearch(query, env) {
  if (!query) return null;
  // v2 : bump apres ajout filter equity (eviter UBS AG -> fonds 0P00...)
  const cacheKey = `yahoo-search:v2:${String(query).toUpperCase().trim()}`;

  // Cache 7 jours
  if (env && env.CACHE) {
    try {
      const cached = await env.CACHE.get(cacheKey, 'json');
      if (cached && cached.symbol) return cached.symbol;
    } catch {}
  }

  try {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': YAHOO_UA,
        'Accept': 'application/json',
      },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const quotes = data?.quotes || [];
    if (quotes.length === 0) return null;

    // Heuristique : preferer .PA, .L, .DE, .AS, .SW, .MI, .MC pour les recherches EU
    // (Si user tape "LVMH" on veut MC.PA, pas LVMUY US ADR)
    const queryUp = query.toUpperCase();
    const looksFrench = /[ÉÈÀÂÇ]/i.test(query) || /^(LVMH|FDJ|TOTALENERGIES|SANOFI|BNP|AXA|ENGIE|VEOLIA|VINCI|RENAULT|PEUGEOT|CARREFOUR|BOLLORE|DASSAULT|SCHNEIDER|LEGRAND|PUBLICIS|HERMES|KERING|SAINT.GOBAIN|CAPGEMINI|PERNOD|UBISOFT|WORLDLINE|BUREAU.VERITAS|AMUNDI|EDENRED|ICADE|ATOS|AIR.LIQUIDE|AIR.FRANCE|TELEPERFORMANCE|VIVENDI|REMY|MICHELIN|SOITEC|EUROFINS|ESSILOR|IPSEN|SAFRAN)$/i.test(queryUp);
    const euSuffixes = /\.(PA|L|DE|AS|SW|MI|MC|ST|OL|CO|HE)$/i;

    // Filtrer pour preferer les EQUITY (actions) sur les MUTUALFUND/ETF/INDEX
    const isEquity = q => (q.quoteType || '').toLowerCase() === 'equity';
    const equityQuotes = quotes.filter(isEquity);
    const eligibles = equityQuotes.length > 0 ? equityQuotes : quotes;

    // Marches principaux (par ordre de priorite) :
    //  - .PA Paris (CAC), .L London (FTSE), .DE Frankfurt (DAX),
    //  - .AS Amsterdam (AEX), .SW Switzerland (SMI), .MI Milan (FTSE MIB),
    //  - .MC Madrid (IBEX), .ST Stockholm, .OL Oslo, .CO Copenhagen, .HE Helsinki
    //  - sans suffix = US (NYSE, NASDAQ)
    // EVITER : .JO (Johannesburg), .HK (HKex), .TO (Toronto), .SS (Shanghai), etc.
    //         = exchanges secondaires qui peuvent matcher "UBS AG" -> SAALG.JO

    const MAJOR_SUFFIXES = /\.(PA|L|DE|AS|SW|MI|MC|ST|OL|CO|HE)$/i;
    const NO_SUFFIX = /^[A-Z][A-Z0-9.\-]*$/;  // tickers US sans suffix
    const isUsTicker = q => !!(q.symbol && !q.symbol.includes('.') && /^[A-Z]/.test(q.symbol));

    let pick = null;
    // 1. Requete FR -> preferer .PA equity
    if (looksFrench) {
      pick = eligibles.find(q => /\.PA$/i.test(q.symbol || ''));
    }
    // 2. Equity sur major EU exchange
    if (!pick) pick = eligibles.find(q => MAJOR_SUFFIXES.test(q.symbol || ''));
    // 3. Equity US (sans suffix)
    if (!pick) pick = eligibles.find(q => isUsTicker(q));
    // 4. Premiere equity
    if (!pick) pick = eligibles[0];
    // 5. Dernier recours
    if (!pick) pick = quotes[0];

    const symbol = pick?.symbol || null;
    if (symbol && env && env.CACHE) {
      try {
        await env.CACHE.put(cacheKey, JSON.stringify({
          symbol,
          shortname: pick?.shortname,
          exchange: pick?.exchange,
          fetchedAt: new Date().toISOString(),
        }), { expirationTtl: 7 * 86400 });
      } catch {}
    }
    return symbol;
  } catch {
    return null;
  }
}


// ============================================================
// YAHOO FINANCE : prix + chart
// ============================================================
async function fetchYahooQuote(ticker, range = '1y') {
  const empty = { price: null, chart: null, company: { name: ticker } };
  try {
    // chart v8 : prix courant + historique daily (range configurable : 1mo, 3mo, 6mo, 1y, 2y, 5y, 10y, max)
    // Pour > 1y, Yahoo renvoie interval=1d avec un nombre de points proportionnel.
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=${encodeURIComponent(range)}&includePrePost=false`;
    const resp = await fetchWithRetry(url, { headers: { 'User-Agent': YAHOO_UA, 'Accept': 'application/json' } }, { retries: 2, label: `yahoo-quote:${ticker}` });
    if (!resp.ok) return empty;
    const json = await resp.json();
    const result = json.chart && json.chart.result && json.chart.result[0];
    if (!result) return empty;

    const meta = result.meta || {};
    const timestamps = result.timestamp || [];
    const quote = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
    const closes = quote.close || [];

    // Points pour le sparkline / chart (on subsample si >260 points)
    const chartPoints = timestamps.map((ts, i) => ({
      date: new Date(ts * 1000).toISOString().slice(0, 10),
      close: closes[i],
    })).filter(p => p.close != null);

    // DAILY change : on doit prendre le VRAI previous close, pas chartPreviousClose
    // (qui correspond au close d'il y a 1 an avec range=1y)
    // Yahoo expose previousClose dans meta, mais parfois seulement chartPreviousClose.
    // Fallback robuste : avant-dernier close du chart vs current price.
    const current = meta.regularMarketPrice;
    let dailyPrev = meta.previousClose;
    if (dailyPrev == null && chartPoints.length >= 2) {
      // avant-dernier close du chart (le dernier est aujourd'hui ou la veille)
      dailyPrev = chartPoints[chartPoints.length - 2].close;
    }
    const dailyChange = (current != null && dailyPrev != null) ? current - dailyPrev : null;
    const dailyChangePct = (current != null && dailyPrev != null && dailyPrev !== 0) ? (dailyChange / dailyPrev) * 100 : null;

    // Performance 1 an : premier point du chart vs current
    let change1y = null, change1yPct = null;
    if (chartPoints.length > 0 && current != null) {
      const firstClose = chartPoints[0].close;
      if (firstClose != null && firstClose !== 0) {
        change1y = current - firstClose;
        change1yPct = ((current - firstClose) / firstClose) * 100;
      }
    }

    // Performance YTD : premier close de l'année en cours vs current
    let changeYtdPct = null;
    const currentYear = new Date().getFullYear();
    const ytdFirst = chartPoints.find(p => p.date && p.date.startsWith(String(currentYear) + '-'));
    if (ytdFirst && ytdFirst.close && current != null) {
      changeYtdPct = ((current - ytdFirst.close) / ytdFirst.close) * 100;
    }

    return {
      price: {
        current,
        previousClose: dailyPrev,
        change: dailyChange,
        changePct: dailyChangePct,
        change1y,
        change1yPct,
        changeYtdPct,
        currency: meta.currency || 'USD',
        exchange: meta.exchangeName || null,
        exchangeFull: meta.fullExchangeName || null,
        high52w: meta.fiftyTwoWeekHigh,
        low52w: meta.fiftyTwoWeekLow,
        marketState: meta.marketState || null,
        regularMarketTime: meta.regularMarketTime || null,
      },
      chart: {
        range,
        points: chartPoints,
      },
      company: {
        name: meta.longName || meta.shortName || ticker,
      },
    };
  } catch (e) {
    console.error('Yahoo quote error:', ticker, e.message || e);
    return empty;
  }
}

// ============================================================
// STOCKANALYSIS.COM : fondamentaux + consensus + profil entreprise
// API publique gratuite, pas de cle requise, renvoie tout en un appel.
// ============================================================
function parseNumericValue(s) {
  if (s == null) return null;
  if (typeof s === 'number') return s;
  s = String(s).trim();
  if (!s || s === '-' || s === 'n/a' || s === 'N/A') return null;
  // Enleve le signe $, les espaces, les virgules (separateurs de milliers)
  let clean = s.replace(/[$\s,]/g, '');
  // Detecte un suffixe multiplicateur (K/M/B/T)
  let mult = 1;
  const last = clean.slice(-1).toUpperCase();
  if (last === 'T') { mult = 1e12; clean = clean.slice(0, -1); }
  else if (last === 'B') { mult = 1e9; clean = clean.slice(0, -1); }
  else if (last === 'M') { mult = 1e6; clean = clean.slice(0, -1); }
  else if (last === 'K') { mult = 1e3; clean = clean.slice(0, -1); }
  // Enleve le signe % si present (reste le numero brut)
  clean = clean.replace(/%$/, '');
  const n = parseFloat(clean);
  if (isNaN(n)) return null;
  return n * mult;
}

async function fetchStockAnalysisOverview(ticker) {
  const empty = {
    fundamentals: {},
    consensus: null,
    profile: {},
  };
  // stockanalysis.com distingue les "stocks" (s) des "etf" (e) dans l'URL.
  // On essaie stocks en premier, ETF en fallback.
  const paths = [`s/${ticker.toLowerCase()}`, `e/${ticker.toLowerCase()}`];
  const withTimeout = (promise, ms) => Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);

  for (const path of paths) {
    try {
      const url = `https://api.stockanalysis.com/api/symbol/${path}/overview`;
      const resp = await withTimeout(fetchWithRetry(url, {
        headers: { 'User-Agent': YAHOO_UA, 'Accept': 'application/json', 'Referer': 'https://stockanalysis.com/' },
      }, { retries: 2, backoffMs: 300, label: `sa-overview:${ticker}` }), 10000);
      if (!resp.ok) continue;
      const json = await resp.json();
      if (!json || !json.data) continue;
      const d = json.data;

      // Extraction des infos du "infoTable" (array de { t, v, u? })
      const info = {};
      (d.infoTable || []).forEach(it => { if (it && it.t) info[it.t] = it.v; });

      // Dividend yield : "1.04 (0.40%)" → on extrait le pourcentage
      let dividendYield = null;
      if (d.dividend) {
        const m = String(d.dividend).match(/\(([-\d.]+)%\)/);
        if (m) dividendYield = parseFloat(m[1]) / 100;
      }

      // Target price : "299.14 (+15.42%)" → on extrait la valeur
      let targetPrice = null;
      if (d.target) {
        const m = String(d.target).match(/([\d.]+)/);
        if (m) targetPrice = parseFloat(m[1]);
      }

      // Consensus analystes (structure : { strongBuy, buy, hold, sell, strongSell })
      let consensus = null;
      if (d.analystChart && typeof d.analystChart === 'object') {
        const ac = d.analystChart;
        const sb = Number(ac.strongBuy) || 0;
        const b  = Number(ac.buy) || 0;
        const h  = Number(ac.hold) || 0;
        const s  = Number(ac.sell) || 0;
        const ss = Number(ac.strongSell) || 0;
        const total = sb + b + h + s + ss;
        if (total > 0) {
          consensus = {
            strongBuy: sb, buy: b, hold: h, sell: s, strongSell: ss,
            total,
            bullishPct: ((sb + b) / total) * 100,
          };
        }
      }

      const fundamentals = {
        marketCap: parseNumericValue(d.marketCap),
        revenue: parseNumericValue(d.revenue),
        netIncome: parseNumericValue(d.netIncome),
        sharesOut: parseNumericValue(d.sharesOut),
        eps: parseNumericValue(d.eps),
        peRatio: parseNumericValue(d.peRatio),
        forwardPE: parseNumericValue(d.forwardPE),
        dividendYield,
        beta: parseNumericValue(d.beta),
        targetMeanPrice: targetPrice,
        recommendationKey: d.analysts ? String(d.analysts).toLowerCase() : null,
        earningsDate: d.earningsDate || null,
        exDividendDate: d.exDividendDate || null,
      };

      return {
        fundamentals,
        consensus,
        profile: {
          name: info['Name'] || info['Company'] || d.companyName || null,
          sector: info['Sector'] || null,
          industry: info['Industry'] || null,
          country: info['Country'] || null,
          website: info['Website'] || null,
          exchange: info['Stock Exchange'] || null,
          employees: parseNumericValue(info['Employees']),
          ceo: info['CEO'] || info['Chief Executive Officer'] || null,
          founded: info['Founded'] || null,
          headquarters: info['Headquarters'] || info['HQ'] || null,
          ipoDate: info['IPO Date'] || info['IPO'] || null,
          fiscalYearEnd: info['Fiscal Year Ends'] || info['Fiscal Year'] || null,
          isin: info['ISIN'] || null,
          description: d.description || null,
        },
      };
    } catch (e) {
      console.error('stockanalysis overview error:', ticker, path, e.message || e);
    }
  }
  return empty;
}

// ============================================================
// STOCKANALYSIS.COM : /statistics (scores sante, margins, returns, short interest, ratios etendus)
// ============================================================
// Helper : transforme [{ id, title, value, hover }, ...] en { id: { display, numeric, title } }
function sectionToMap(section) {
  const out = {};
  if (!section || !Array.isArray(section.data)) return out;
  section.data.forEach(item => {
    if (!item || !item.id) return;
    const display = item.value != null ? String(item.value) : null;
    const rawForNumeric = item.hover != null ? String(item.hover) : display;
    out[item.id] = {
      display,
      numeric: parseNumericValue(rawForNumeric),
      title: item.title || item.id,
    };
  });
  return out;
}

async function fetchStockAnalysisStatistics(ticker) {
  const empty = {
    fundamentals: {},
    extendedRatios: {},
    margins: {},
    returns: {},
    financialPosition: {},
    health: {},
    shortInterest: {},
    fairValue: {},
  };
  const paths = [`s/${ticker.toLowerCase()}`, `e/${ticker.toLowerCase()}`];
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

  for (const path of paths) {
    try {
      const url = `https://api.stockanalysis.com/api/symbol/${path}/statistics`;
      const resp = await withTimeout(fetchWithRetry(url, {
        headers: { 'User-Agent': YAHOO_UA, 'Accept': 'application/json', 'Referer': 'https://stockanalysis.com/' },
      }, { retries: 2, backoffMs: 300, label: `sa-stats:${ticker}` }), 10000);
      if (!resp.ok) continue;
      const json = await resp.json();
      const d = json && json.data;
      if (!d) continue;

      const valuation = sectionToMap(d.valuation);
      const ratios = sectionToMap(d.ratios);
      const evRatios = sectionToMap(d.evRatios);
      const margins = sectionToMap(d.margins);
      const finEff = sectionToMap(d.financialEfficiency);
      const finPos = sectionToMap(d.financialPosition);
      const scores = sectionToMap(d.scores);
      const shortS = sectionToMap(d.shortSelling);
      const stockP = sectionToMap(d.stockPrice);
      const dividends = sectionToMap(d.dividends);
      const shares = sectionToMap(d.shares);
      const analystF = sectionToMap(d.analystForecasts);
      const fairV = sectionToMap(d.fairValue);
      const income = sectionToMap(d.incomeStatement);

      const num = (m, k) => (m[k] && m[k].numeric != null) ? m[k].numeric : null;
      const disp = (m, k) => (m[k] ? m[k].display : null);

      return {
        fundamentals: {
          // Metriques de base (override overview si dispo)
          marketCap: num(valuation, 'marketcap'),
          enterpriseValue: num(valuation, 'enterpriseValue'),
          peRatio: num(ratios, 'pe'),
          forwardPE: num(ratios, 'peForward'),
          psRatio: num(ratios, 'ps'),
          pbRatio: num(ratios, 'pb'),
          pegRatio: num(ratios, 'peg'),
          pfcfRatio: num(ratios, 'pfcf'),
          eps: num(income, 'eps'),
          revenue: num(income, 'revenue'),
          netIncome: num(income, 'netIncome'),
          sharesOut: num(shares, 'sharesOut'),
          sharesFloat: num(shares, 'sharesFloat'),
          insiderOwnership: num(shares, 'insiderOwn'),
          institutionalOwnership: num(shares, 'institutionalOwn'),
          beta: num(stockP, 'beta'),
          dividendYield: num(dividends, 'dividendYield') != null ? num(dividends, 'dividendYield') / 100 : null,
          dividendPerShare: num(dividends, 'dps'),
          dividendGrowth: num(dividends, 'dividendGrowth'),
          payoutRatio: num(dividends, 'payoutRatio'),
          targetMeanPrice: num(analystF, 'priceTarget'),
          targetUpsidePct: num(analystF, 'priceTargetChange'),
          analystCount: num(analystF, 'analystCount'),
          recommendationKey: disp(analystF, 'analystRatings') ? String(disp(analystF, 'analystRatings')).toLowerCase() : null,
          price52wChangePct: num(stockP, 'ch1y'),
          sma50: num(stockP, 'sma50'),
          sma200: num(stockP, 'sma200'),
        },
        extendedRatios: {
          ps: disp(ratios, 'ps'),
          psForward: disp(ratios, 'psForward'),
          pb: disp(ratios, 'pb'),
          pfcf: disp(ratios, 'pfcf'),
          peg: disp(ratios, 'peg'),
          evEarnings: disp(evRatios, 'evEarnings'),
          evSales: disp(evRatios, 'evSales'),
          evEbitda: disp(evRatios, 'evEbitda'),
          evFcf: disp(evRatios, 'evFcf'),
        },
        margins: {
          gross: { display: disp(margins, 'grossMargin'), numeric: num(margins, 'grossMargin') },
          operating: { display: disp(margins, 'operatingMargin'), numeric: num(margins, 'operatingMargin') },
          pretax: { display: disp(margins, 'pretaxMargin'), numeric: num(margins, 'pretaxMargin') },
          profit: { display: disp(margins, 'profitMargin'), numeric: num(margins, 'profitMargin') },
          fcf: { display: disp(margins, 'fcfMargin'), numeric: num(margins, 'fcfMargin') },
          ebitda: { display: disp(margins, 'ebitdaMargin'), numeric: num(margins, 'ebitdaMargin') },
        },
        returns: {
          roe: { display: disp(finEff, 'roe'), numeric: num(finEff, 'roe') },
          roa: { display: disp(finEff, 'roa'), numeric: num(finEff, 'roa') },
          roic: { display: disp(finEff, 'roic'), numeric: num(finEff, 'roic') },
          roce: { display: disp(finEff, 'roce'), numeric: num(finEff, 'roce') },
        },
        financialPosition: {
          currentRatio: { display: disp(finPos, 'currentRatio'), numeric: num(finPos, 'currentRatio') },
          quickRatio: { display: disp(finPos, 'quickRatio'), numeric: num(finPos, 'quickRatio') },
          debtEquity: { display: disp(finPos, 'debtEquity'), numeric: num(finPos, 'debtEquity') },
          debtEbitda: { display: disp(finPos, 'debtEbitda'), numeric: num(finPos, 'debtEbitda') },
          interestCoverage: { display: disp(finPos, 'interestCoverage'), numeric: num(finPos, 'interestCoverage') },
        },
        health: {
          altmanZ: num(scores, 'zScore'),
          piotroskiF: num(scores, 'fScore'),
          // Interpretation Altman : >2.99 safe, 1.81-2.99 grey, <1.81 distress
          altmanZone: (() => {
            const z = num(scores, 'zScore');
            if (z == null) return null;
            if (z > 2.99) return 'safe';
            if (z > 1.81) return 'grey';
            return 'distress';
          })(),
          piotroskiZone: (() => {
            const f = num(scores, 'fScore');
            if (f == null) return null;
            if (f >= 7) return 'strong';
            if (f >= 4) return 'mid';
            return 'weak';
          })(),
        },
        shortInterest: {
          shortInterest: { display: disp(shortS, 'shortInterest'), numeric: num(shortS, 'shortInterest') },
          shortPriorMonth: { display: disp(shortS, 'shortPriorMonth'), numeric: num(shortS, 'shortPriorMonth') },
          shortPctShares: { display: disp(shortS, 'shortShares'), numeric: num(shortS, 'shortShares') },
          shortPctFloat: { display: disp(shortS, 'shortFloat'), numeric: num(shortS, 'shortFloat') },
          daysToCover: { display: disp(shortS, 'daysToCover'), numeric: num(shortS, 'daysToCover') },
        },
        fairValue: {
          lynch: { display: disp(fairV, 'lynchFairValue'), numeric: num(fairV, 'lynchFairValue') },
          lynchUpside: { display: disp(fairV, 'lynchUpside'), numeric: num(fairV, 'lynchUpside') },
          graham: { display: disp(fairV, 'grahamNumber'), numeric: num(fairV, 'grahamNumber') },
          grahamUpside: { display: disp(fairV, 'grahamUpside'), numeric: num(fairV, 'grahamUpside') },
        },
      };
    } catch (e) {
      console.error('stockanalysis statistics error:', ticker, path, e.message || e);
    }
  }
  return empty;
}

// ============================================================
// STOCKANALYSIS.COM : /earnings (historique surprises + prochaine)
// ============================================================
async function fetchStockAnalysisEarnings(ticker) {
  const empty = { history: [], next: null };
  const paths = [`s/${ticker.toLowerCase()}`, `e/${ticker.toLowerCase()}`];
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

  for (const path of paths) {
    try {
      const url = `https://api.stockanalysis.com/api/symbol/${path}/earnings`;
      const resp = await withTimeout(fetchWithRetry(url, {
        headers: { 'User-Agent': YAHOO_UA, 'Accept': 'application/json', 'Referer': 'https://stockanalysis.com/' },
      }, { retries: 2, backoffMs: 300, label: `sa-earnings:${ticker}` }), 10000);
      if (!resp.ok) continue;
      const json = await resp.json();
      const arr = json && json.data;
      if (!Array.isArray(arr)) continue;

      // Trier par date croissante
      const sorted = [...arr].sort((a, b) => (a.date || '').localeCompare(b.date || ''));

      // 4 derniers passes (eps_actual non null)
      const past = sorted.filter(x => x.eps_actual != null && x.eps_surprise_percent != null);
      const history = past.slice(-6).reverse().map(x => ({
        date: x.date,
        year: x.year,
        period: x.period,
        epsEst: x.eps_est,
        epsActual: x.eps_actual,
        epsSurprisePct: x.eps_surprise_percent,
        revenueEst: x.revenue_est,
        revenueActual: x.revenue_actual,
        revenueSurprisePct: x.revenue_surprise_percent,
        // beat = surprise > 0
        beat: (x.eps_surprise_percent || 0) > 0,
      }));

      // Prochain (eps_actual null, date future la plus proche)
      const todayISO = new Date().toISOString().slice(0, 10);
      const upcoming = sorted.filter(x => x.eps_actual == null && x.date >= todayISO);
      const next = upcoming.length > 0 ? {
        date: upcoming[0].date,
        time: upcoming[0].time,
        year: upcoming[0].year,
        period: upcoming[0].period,
        epsEst: upcoming[0].eps_est,
        revenueEst: upcoming[0].revenue_est,
        confirmed: upcoming[0].confirmed,
      } : null;

      return { history, next };
    } catch (e) {
      console.error('stockanalysis earnings error:', ticker, path, e.message || e);
    }
  }
  return empty;
}

// ============================================================
// STOCKANALYSIS.COM : /employees (peers sectoriels + evolution des effectifs)
// ============================================================
async function fetchStockAnalysisEmployees(ticker) {
  const empty = { stats: {}, peers: [] };
  const paths = [`s/${ticker.toLowerCase()}`, `e/${ticker.toLowerCase()}`];
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

  for (const path of paths) {
    try {
      const url = `https://api.stockanalysis.com/api/symbol/${path}/employees`;
      const resp = await withTimeout(fetchWithRetry(url, {
        headers: { 'User-Agent': YAHOO_UA, 'Accept': 'application/json', 'Referer': 'https://stockanalysis.com/' },
      }, { retries: 2, backoffMs: 300, label: `sa-employees:${ticker}` }), 10000);
      if (!resp.ok) continue;
      const json = await resp.json();
      const d = json && json.data;
      if (!d) continue;

      return {
        stats: {
          current: d.stats ? d.stats.current : null,
          change: d.stats ? d.stats.change : null,
          growth: d.stats ? d.stats.growth : null,
          revenuePerEmployee: d.stats ? d.stats.revenue_per_employee : null,
          profitPerEmployee: d.stats ? d.stats.profit_per_employee : null,
        },
        peers: Array.isArray(d.peers) ? d.peers.slice(0, 8).map(p => ({
          ticker: p.s,
          name: p.n,
          employees: p.employees,
        })) : [],
      };
    } catch (e) {
      console.error('stockanalysis employees error:', ticker, path, e.message || e);
    }
  }
  return empty;
}

// ============================================================
// YAHOO FINANCE : crumb + cookie (pour quoteSummary) [DEPRECATED mais conserve en fallback]
// Depuis 2024, Yahoo exige un "crumb" CSRF + cookie de session.
// On le met en cache KV 6h pour eviter un roundtrip a chaque requete.
// ============================================================
async function getYahooSession(env, forceRefresh = false) {
  const KEY = 'yahoo-session-v1';
  if (!forceRefresh) {
    const cached = await env.CACHE.get(KEY, 'json');
    if (cached && cached.cookie && cached.crumb && (Date.now() - cached.at) < 6 * 3600 * 1000) {
      return cached;
    }
  }
  // Timeout helper pour eviter de faire trainer la requete si Yahoo est lent
  const withTimeout = (promise, ms) => Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);
  try {
    // Etape 1 : poser un cookie A3 via fc.yahoo.com (endpoint technique)
    const cookieResp = await withTimeout(fetch('https://fc.yahoo.com/', {
      headers: { 'User-Agent': YAHOO_UA },
      redirect: 'manual',
    }), 4000);
    const setCookie = cookieResp.headers.get('set-cookie') || '';
    const cookie = setCookie.split(',').map(c => c.split(';')[0].trim()).filter(c => c.includes('=')).join('; ');
    if (!cookie) return { cookie: '', crumb: '' };

    // Etape 2 : obtenir le crumb
    const crumbResp = await withTimeout(fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': YAHOO_UA, 'Cookie': cookie, 'Accept': 'text/plain' },
    }), 4000);
    if (!crumbResp.ok) return { cookie, crumb: '' };
    const crumb = (await crumbResp.text()).trim();
    const session = { cookie, crumb, at: Date.now() };
    try {
      await env.CACHE.put(KEY, JSON.stringify(session), { expirationTtl: 6 * 3600 });
    } catch {}
    return session;
  } catch (e) {
    console.error('Yahoo session error:', e.message || e);
    return { cookie: '', crumb: '' };
  }
}

// ============================================================
// YAHOO FINANCE : fondamentaux (quoteSummary avec crumb)
// ============================================================
async function fetchYahooFundamentals(ticker, env) {
  const empty = { profile: {}, stats: {} };

  async function doFetch(session) {
    const modules = 'summaryDetail,defaultKeyStatistics,financialData,assetProfile,price';
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules}&crumb=${encodeURIComponent(session.crumb || '')}`;
    const headers = { 'User-Agent': YAHOO_UA, 'Accept': 'application/json' };
    if (session.cookie) headers['Cookie'] = session.cookie;
    return fetch(url, { headers });
  }

  try {
    let session = await getYahooSession(env);
    let resp = await doFetch(session);

    // Si 401 Invalid Crumb, on refresh et on reessaie une fois
    if (resp.status === 401 || resp.status === 403) {
      session = await getYahooSession(env, true);
      resp = await doFetch(session);
    }
    if (!resp.ok) return empty;
    const json = await resp.json();
    const r = json.quoteSummary && json.quoteSummary.result && json.quoteSummary.result[0];
    if (!r) return empty;

    const profile = r.assetProfile || {};
    const priceMod = r.price || {};
    const summary = r.summaryDetail || {};
    const keystats = r.defaultKeyStatistics || {};
    const finData = r.financialData || {};

    const raw = (field) => (field && typeof field === 'object' && 'raw' in field) ? field.raw : field;

    return {
      profile: {
        longName: raw(priceMod.longName) || raw(profile.longName),
        shortName: raw(priceMod.shortName),
        sector: profile.sector,
        industry: profile.industry,
        country: profile.country,
        website: profile.website,
        longBusinessSummary: profile.longBusinessSummary,
        fullTimeEmployees: profile.fullTimeEmployees,
      },
      stats: {
        marketCap: raw(priceMod.marketCap) || raw(summary.marketCap),
        peRatio: raw(summary.trailingPE),
        forwardPE: raw(summary.forwardPE) || raw(keystats.forwardPE),
        pbRatio: raw(keystats.priceToBook),
        dividendYield: raw(summary.dividendYield),
        beta: raw(summary.beta) || raw(keystats.beta),
        eps: raw(keystats.trailingEps),
        profitMargin: raw(finData.profitMargins),
        roe: raw(finData.returnOnEquity),
        revenue: raw(finData.totalRevenue),
        revenueGrowth: raw(finData.revenueGrowth),
        debtToEquity: raw(finData.debtToEquity),
        currentRatio: raw(finData.currentRatio),
        targetMeanPrice: raw(finData.targetMeanPrice),
        recommendationKey: finData.recommendationKey,
        numberOfAnalystOpinions: raw(finData.numberOfAnalystOpinions),
      },
    };
  } catch (e) {
    console.error('Yahoo fundamentals error:', ticker, e.message || e);
    return empty;
  }
}

// ============================================================
// YAHOO FINANCE : News RSS
// ============================================================
async function fetchYahooNews(ticker) {
  try {
    const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`;
    const resp = await fetch(url, { headers: { 'User-Agent': YAHOO_UA } });
    if (!resp.ok) return [];
    const xml = await resp.text();
    // Parser RSS minimaliste (pas de lib DOM dans Workers)
    const items = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRe.exec(xml)) !== null && items.length < 15) {
      const block = m[1];
      const title = (block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1];
      const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1];
      const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
      const source = (block.match(/<source[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/source>/) || [])[1];
      if (title && link) {
        items.push({
          title: title.trim(),
          link: link.trim(),
          pubDate: pubDate ? new Date(pubDate.trim()).toISOString() : null,
          source: source ? source.trim() : null,
        });
      }
    }
    return items;
  } catch (e) {
    console.error('Yahoo news error:', ticker, e.message || e);
    return [];
  }
}

// ============================================================
// FINNHUB : analyst recommendation trends (optionnel)
// ============================================================
async function fetchFinnhubConsensus(ticker, apiKey) {
  if (!apiKey) return null;
  try {
    const url = `https://finnhub.io/api/v1/stock/recommendation?symbol=${encodeURIComponent(ticker)}&token=${apiKey}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const arr = await resp.json();
    if (!Array.isArray(arr) || arr.length === 0) return null;
    // Prendre le mois le plus recent
    arr.sort((a, b) => (b.period || '').localeCompare(a.period || ''));
    const latest = arr[0];
    const total = (latest.strongBuy || 0) + (latest.buy || 0) + (latest.hold || 0) + (latest.sell || 0) + (latest.strongSell || 0);
    return {
      period: latest.period,
      strongBuy: latest.strongBuy || 0,
      buy: latest.buy || 0,
      hold: latest.hold || 0,
      sell: latest.sell || 0,
      strongSell: latest.strongSell || 0,
      total,
      bullishPct: total > 0 ? (((latest.strongBuy || 0) + (latest.buy || 0)) / total) * 100 : 0,
    };
  } catch (e) {
    console.error('Finnhub consensus error:', ticker, e.message || e);
    return null;
  }
}


// ============================================================
// FINNHUB : fundamentals complets (marketCap, P/E, EPS, ROE, ROA, marges, etc.)
// ============================================================
// Solution principale pour les actions EU. Free tier 60 calls/min.
// Endpoint /stock/metric?metric=all retourne 80+ ratios par stock.
//
// IMPORTANT : Finnhub free tier ne couvre PAS les tickers EU directs (.PA, .DE,
// .AS, .SW, .L, .MI, .MC) mais COUVRE les ADR US des memes societes.
// LVMH (MC.PA) -> LVMUY (131 fields), Hermes (RMS.PA) -> HESAY, etc.
// On fallback automatiquement vers l'ADR si ticker EU retourne vide.
//
// Cache KV 24h dans 'finnhub-metrics:{ticker}' pour eviter quota burn.
const EU_TO_US_ADR = {
  // CAC 40
  'MC.PA': 'LVMUY', 'OR.PA': 'LRLCY', 'SAN.PA': 'SNY', 'TTE.PA': 'TTE',
  'AI.PA': 'AIQUY', 'CS.PA': 'AXAHY', 'BNP.PA': 'BNPQY', 'SU.PA': 'SBGSY',
  'DG.PA': 'VCISY', 'RI.PA': 'PDRDY', 'RMS.PA': 'HESAY', 'KER.PA': 'PPRUY',
  'AIR.PA': 'EADSY', 'SAF.PA': 'SAFRY', 'GLE.PA': 'SCGLY', 'STLAP.PA': 'STLA',
  'CAP.PA': 'CGEMY', 'HO.PA': 'THLLY', 'EL.PA': 'ESLOY', 'ENGI.PA': 'ENGIY',
  'BN.PA': 'DANOY', 'CA.PA': 'CRRFY', 'DSY.PA': 'DASTY', 'ALO.PA': 'ALSMY',
  'ML.PA': 'MGDDY', 'RNO.PA': 'RNLSY', 'ORA.PA': 'ORAN', 'PUB.PA': 'PUBGY',
  'WLN.PA': 'WRDLY', 'VIV.PA': 'VIVHY', 'VIE.PA': 'VEOEY', 'TEP.PA': 'TLPFY',
  'EN.PA': 'BOUYY', 'SGO.PA': 'CODYY', 'STM.PA': 'STM', 'LR.PA': 'LGRDY',
  'ERF.PA': 'ERFSF', 'ACC.PA': 'ACRFY', 'AC.PA': 'ACCYY',
  // DAX
  'SAP.DE': 'SAP', 'SIE.DE': 'SIEGY', 'ALV.DE': 'ALIZY', 'MBG.DE': 'MBGYY',
  'VOW3.DE': 'VWAGY', 'BAS.DE': 'BASFY', 'BAYN.DE': 'BAYRY', 'ADS.DE': 'ADDYY',
  'DBK.DE': 'DB', 'DHL.DE': 'DPSGY', 'BMW.DE': 'BMWYY', 'IFX.DE': 'IFNNY',
  'DTE.DE': 'DTEGY', 'MUV2.DE': 'MURGY', 'HEN3.DE': 'HENKY', 'CON.DE': 'CTTAY',
  // AEX
  'ASML.AS': 'ASML', 'HEIA.AS': 'HEINY', 'UNA.AS': 'UL', 'PHIA.AS': 'PHG',
  'PRX.AS': 'PROSY', 'INGA.AS': 'ING', 'AD.AS': 'ADRNY', 'STLAM.MI': 'STLA',
  // SMI
  'NESN.SW': 'NSRGY', 'ROG.SW': 'RHHBY', 'NOVN.SW': 'NVS', 'UBSG.SW': 'UBS',
  'ZURN.SW': 'ZURVY', 'ABBN.SW': 'ABB', 'CFR.SW': 'CFRUY', 'GIVN.SW': 'GVDNY',
  'LONN.SW': 'LZAGY', 'SREN.SW': 'SSREY', 'GEBN.SW': 'GBERY', 'SCMN.SW': 'SCMWY',
  // FTSE 100
  'SHEL.L': 'SHEL', 'AZN.L': 'AZN', 'HSBA.L': 'HSBC', 'DGE.L': 'DEO',
  'ULVR.L': 'UL', 'BP.L': 'BP', 'GSK.L': 'GSK', 'BARC.L': 'BCS',
  'LLOY.L': 'LYG', 'VOD.L': 'VOD', 'GLEN.L': 'GLNCY', 'RIO.L': 'RIO',
  'TSCO.L': 'TSCDY', 'PRU.L': 'PUK', 'NWG.L': 'NWG', 'IMB.L': 'IMBBY',
  'CCH.L': 'CCHGY', 'BATS.L': 'BTI', 'BA.L': 'BAESY', 'NG.L': 'NGG',
  // FTSE MIB
  'RACE.MI': 'RACE', 'ENI.MI': 'E', 'ISP.MI': 'ISNPY', 'UCG.MI': 'UNCRY',
  'ENEL.MI': 'ENLAY', 'STLAM.MI': 'STLA', 'TIT.MI': 'TIIAY', 'G.MI': 'ARZGY',
  // IBEX 35
  'SAN.MC': 'SAN', 'TEF.MC': 'TEF', 'ITX.MC': 'IDEXY', 'IBE.MC': 'IBDRY',
  'BBVA.MC': 'BBVA', 'REP.MC': 'REPYY', 'AENA.MC': 'ANYYY',
};

async function fetchFinnhubMetrics(ticker, apiKey, env) {
  if (!apiKey || !ticker) return null;

  // Cache 24h sur le ticker ORIGINAL (pas l'ADR) pour le lookup ulterieur.
  // v3 : bump apres ajout healthScore + financialPosition (mai 2026).
  const cacheKey = `finnhub-metrics:v3:${String(ticker).toUpperCase()}`;
  if (env && env.CACHE) {
    try {
      const cached = await env.CACHE.get(cacheKey, 'json');
      if (cached && cached.fetchedAt) {
        const age = (Date.now() - new Date(cached.fetchedAt).getTime()) / 1000;
        if (age < 86400) return cached;
      }
    } catch {}
  }

  // Strategie : essayer le ticker direct, puis l'ADR US si vide
  const tryFetch = async (sym) => {
    const url = `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(sym)}&metric=all&token=${apiKey}`;
    try {
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const data = await resp.json();
      const m = data.metric || {};
      return Object.keys(m).length > 0 ? m : null;
    } catch { return null; }
  };

  let m = await tryFetch(ticker);
  let usedSymbol = ticker;

  // Si ticker EU vide, essayer ADR US
  if (!m) {
    const tickerUpper = String(ticker).toUpperCase();
    const adr = EU_TO_US_ADR[tickerUpper];
    if (adr) {
      m = await tryFetch(adr);
      if (m) usedSymbol = adr;
    }
  }

  if (!m || Object.keys(m).length === 0) return null;

  try {
    // Helper : retourne null si la valeur Finnhub est invalide (NaN, null, undefined)
    const num = (v) => (v != null && !isNaN(v)) ? Number(v) : null;

    // Mapping Finnhub -> notre format fundamentals
    // Note : Finnhub marketCap est en MILLIONS (ex: 233456 = 233.5B). On convertit en absolu.
    const marketCapM = num(m.marketCapitalization);
    const evM = num(m.enterpriseValue) || num(m.ev);
    const revenueM = num(m.revenueTTM) || num(m.revenuePerShareTTM);

    const result = {
      // === Section "Taille" ===
      marketCap: marketCapM != null ? marketCapM * 1_000_000 : null,
      enterpriseValue: evM != null ? evM * 1_000_000 : null,
      revenue: revenueM != null && num(m.revenueTTM) ? num(m.revenueTTM) * 1_000_000 : null,
      netIncome: num(m.netIncomeCommonAnnual) ? num(m.netIncomeCommonAnnual) * 1_000_000 : null,
      sharesOut: num(m.sharesOutstanding) ? num(m.sharesOutstanding) * 1_000_000 : null,
      // === Multiples valuation ===
      peRatio: num(m.peTTM) || num(m.peExclExtraTTM),
      forwardPE: num(m.peNormalizedAnnual) || num(m.peExclExtraAnnual),
      psRatio: num(m.psTTM) || num(m.psAnnual),
      pbRatio: num(m.pbAnnual) || num(m.pbQuarterly),
      pfcf: num(m.pfcfShareTTM),
      evEbitda: num(m['currentEv/freeCashFlowAnnual']) || num(m.evEbitdaTTM),
      // === Caracteristiques ===
      eps: num(m.epsTTM) || num(m.epsBasicExclExtraItemsTTM),
      beta: num(m.beta),
      dividendYield: num(m.currentDividendYieldTTM) != null ? num(m.currentDividendYieldTTM) / 100 : null,  // % -> fraction
      dividendsPerShare: num(m.dividendsPerShareAnnual),
      payoutRatio: num(m.payoutRatioTTM) != null ? num(m.payoutRatioTTM) / 100 : null,
      // === 52 weeks ===
      high52w: num(m['52WeekHigh']),
      low52w: num(m['52WeekLow']),
      // === Misc ===
      profitMargin: num(m.netProfitMarginTTM) != null ? num(m.netProfitMarginTTM) / 100 : null,
      _source: 'finnhub',
      fetchedAt: new Date().toISOString(),
    };

    // === Extended ratios (frontend cherche extRatios.peg/ps/pb/pfcf/evEbitda/evSales/evFcf) ===
    const extendedRatios = {
      peg: num(m.pegRatio5Y) || num(m.pegRatio),
      ps: num(m.psTTM),
      pb: num(m.pbAnnual),
      pfcf: num(m.pfcfShareTTM),
      evEbitda: num(m.evEbitdaTTM) || num(m.currentEnterpriseValueOverEbitdaTTM),
      evSales: num(m.evSalesTTM) || num(m['enterpriseValue/revenue']),
      evFcf: num(m['evToFcfTTM']) || num(m.evToFreeCashFlowTTM),
    };

    // === Marges (chaque field doit avoir .display = string formatee + .raw) ===
    const fmtPct = (v) => v != null ? `${v.toFixed(2)}%` : null;
    const margins = {
      gross: { raw: num(m.grossMarginTTM), display: fmtPct(num(m.grossMarginTTM)) },
      operating: { raw: num(m.operatingMarginTTM), display: fmtPct(num(m.operatingMarginTTM)) },
      profit: { raw: num(m.netProfitMarginTTM), display: fmtPct(num(m.netProfitMarginTTM)) },
      fcf: { raw: num(m.freeCashFlowMarginTTM), display: fmtPct(num(m.freeCashFlowMarginTTM)) },
    };

    // === Returns (ROE, ROA, ROIC, ROCE) ===
    const returns = {
      roe: { raw: num(m.roeTTM), display: fmtPct(num(m.roeTTM)) },
      roa: { raw: num(m.roaTTM), display: fmtPct(num(m.roaTTM)) },
      roic: { raw: num(m.roiTTM) || num(m.roicTTM), display: fmtPct(num(m.roiTTM) || num(m.roicTTM)) },
      roce: { raw: num(m.roceAnnual) || num(m.roceTTM), display: fmtPct(num(m.roceAnnual) || num(m.roceTTM)) },
    };

    // === Financial position (currentRatio, quickRatio, debtEquity, debtEbitda, interestCoverage) ===
    // Pour le panneau 'Sante financiere' qui etait vide pour EU.
    const fmtNum = (v) => v != null ? v.toFixed(2) : null;
    const debtEquity = num(m['totalDebt/totalEquityAnnual']) || num(m['longTermDebt/equityAnnual']);
    const debtEbitda = num(m['totalDebt/ebitdaAnnual']);
    const interestCoverage = num(m.interestCoverageAnnual) || num(m.netInterestCoverage);
    const financialPosition = {
      currentRatio: { raw: num(m.currentRatioAnnual), display: fmtNum(num(m.currentRatioAnnual)) },
      quickRatio: { raw: num(m.quickRatioAnnual), display: fmtNum(num(m.quickRatioAnnual)) },
      debtEquity: { raw: debtEquity, display: fmtNum(debtEquity) },
      debtEbitda: { raw: debtEbitda, display: fmtNum(debtEbitda) },
      interestCoverage: { raw: interestCoverage, display: fmtNum(interestCoverage) },
    };

    // === HEALTH SCORE KAIROS (proxy Piotroski F simplifie) ===
    // Pour les EU ou stockanalysis.com ne fournit pas Altman Z + Piotroski F,
    // on calcule un score sur 7 criteres binaires depuis les data Finnhub :
    // 1. Net income > 0 (rentabilite)
    // 2. ROA > 0
    // 3. ROE > 0
    // 4. Marge nette > 0
    // 5. Marge operationnelle > 0
    // 6. Current ratio > 1 (couvre dettes court terme)
    // 7. Debt/Equity < 2 (endettement maitrise)
    // Total /7. >=5 = SOLIDE, 3-4 = MOYEN, <3 = FAIBLE.
    let healthScore = null;
    {
      const checks = [];
      // 1. Net income TTM positive (proxy via netProfitMarginTTM > 0)
      const npm = num(m.netProfitMarginTTM);
      if (npm != null) checks.push({ ok: npm > 0, label: 'Marge nette positive' });
      // 2. ROA > 0
      const roa = num(m.roaTTM);
      if (roa != null) checks.push({ ok: roa > 0, label: 'ROA positif' });
      // 3. ROE > 0
      const roe = num(m.roeTTM);
      if (roe != null) checks.push({ ok: roe > 0, label: 'ROE positif' });
      // 4. Marge brute > 0
      const gm = num(m.grossMarginTTM);
      if (gm != null) checks.push({ ok: gm > 0, label: 'Marge brute positive' });
      // 5. Marge operationnelle > 0
      const om = num(m.operatingMarginTTM);
      if (om != null) checks.push({ ok: om > 0, label: 'Marge opérationnelle positive' });
      // 6. Current ratio > 1
      const cr = num(m.currentRatioAnnual);
      if (cr != null) checks.push({ ok: cr > 1, label: 'Liquidité générale > 1' });
      // 7. Debt/Equity < 2
      if (debtEquity != null) checks.push({ ok: debtEquity < 2, label: 'Endettement maîtrisé' });

      if (checks.length >= 4) {  // au moins 4 criteres dispo pour donner un score fiable
        const passed = checks.filter(c => c.ok).length;
        const total = checks.length;
        const ratio = passed / total;
        let zone, label;
        if (ratio >= 0.71) { zone = 'strong'; label = 'SOLIDE'; }
        else if (ratio >= 0.43) { zone = 'mid'; label = 'MOYEN'; }
        else { zone = 'weak'; label = 'FAIBLE'; }
        healthScore = {
          score: passed,
          total,
          ratio: Math.round(ratio * 100),
          zone,
          label,
          criteria: checks,
          source: 'kairos',  // marqueur : score Kairos vs vrai Piotroski US
        };
      }
    }

    const payload = { ...result, extendedRatios, margins, returns, financialPosition, healthScore, _usedSymbol: usedSymbol };

    // Cache 24h
    if (env && env.CACHE) {
      try {
        await env.CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: 86400 + 3600 });
      } catch {}
    }
    return payload;
  } catch (e) {
    console.error('Finnhub metrics error:', ticker, e.message || e);
    return null;
  }
}

// ============================================================
// FINNHUB EARNINGS : historique des resultats trimestriels (EU + US)
// Free tier 60 calls/min. Cache 24h.
// Solution principale pour remplir le panneau 'Resultats trimestriels'
// pour les actions EU (LVMH, BNP, ASML, etc.) ou stockanalysis.com renvoie
// vide. Avec fallback automatique vers ADR US (LVMH MC.PA -> LVMUY).
// ============================================================
async function fetchFinnhubEarnings(ticker, apiKey, env) {
  if (!apiKey || !ticker) return null;
  const cacheKey = `finnhub-earnings:${String(ticker).toUpperCase()}`;
  if (env && env.CACHE) {
    try {
      const cached = await env.CACHE.get(cacheKey, 'json');
      if (cached && cached.fetchedAt) {
        const age = (Date.now() - new Date(cached.fetchedAt).getTime()) / 1000;
        if (age < 86400) return cached;
      }
    } catch {}
  }
  const tryFetch = async (sym) => {
    try {
      const r = await fetch(`https://finnhub.io/api/v1/stock/earnings?symbol=${encodeURIComponent(sym)}&token=${apiKey}`);
      if (!r.ok) return null;
      const arr = await r.json();
      return Array.isArray(arr) && arr.length > 0 ? arr : null;
    } catch { return null; }
  };
  let arr = await tryFetch(ticker);
  if (!arr) {
    const adr = EU_TO_US_ADR[String(ticker).toUpperCase()];
    if (adr) arr = await tryFetch(adr);
  }
  if (!arr) return null;
  // Format Finnhub : [{symbol, period (date), year, quarter, actual, estimate, surprisePercent}]
  // -> Notre format : history = [{period: 'Q1', year, date, epsActual, epsEst, epsSurprisePct, beat}]
  arr.sort((a, b) => (b.period || '').localeCompare(a.period || ''));  // recent first
  const history = arr.slice(0, 12).map(e => ({
    period: e.quarter ? `Q${e.quarter}` : '',
    year: e.year,
    date: e.period || null,  // Finnhub utilise 'period' pour la date YYYY-MM-DD
    epsActual: e.actual != null ? Number(e.actual) : null,
    epsEst: e.estimate != null ? Number(e.estimate) : null,
    epsSurprisePct: e.surprisePercent != null ? Number(e.surprisePercent) : null,
    beat: (e.actual != null && e.estimate != null) ? (e.actual >= e.estimate) : null,
  }));
  const payload = { history, _source: 'finnhub', fetchedAt: new Date().toISOString() };
  try {
    await env.CACHE?.put(cacheKey, JSON.stringify(payload), { expirationTtl: 86400 + 3600 });
  } catch {}
  return payload;
}


// ============================================================
// FINNHUB EARNINGS CALENDAR : prochaine publication (EU + US)
// Endpoint /calendar/earnings retourne les events futurs et passes.
// Pour 'next earnings', on cherche le 1er event sans actual rempli.
// Cache 24h.
// ============================================================
async function fetchFinnhubEarningsCalendar(ticker, apiKey, env) {
  if (!apiKey || !ticker) return null;
  const cacheKey = `finnhub-calendar:${String(ticker).toUpperCase()}`;
  if (env && env.CACHE) {
    try {
      const cached = await env.CACHE.get(cacheKey, 'json');
      if (cached && cached.fetchedAt) {
        const age = (Date.now() - new Date(cached.fetchedAt).getTime()) / 1000;
        if (age < 86400) return cached;
      }
    } catch {}
  }
  const today = new Date().toISOString().slice(0, 10);
  const futureMax = new Date(); futureMax.setMonth(futureMax.getMonth() + 6);
  const toDate = futureMax.toISOString().slice(0, 10);
  const tryFetch = async (sym) => {
    try {
      const r = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${today}&to=${toDate}&symbol=${encodeURIComponent(sym)}&token=${apiKey}`);
      if (!r.ok) return null;
      const data = await r.json();
      const events = data.earningsCalendar || [];
      return events.length > 0 ? events : null;
    } catch { return null; }
  };
  let events = await tryFetch(ticker);
  if (!events) {
    const adr = EU_TO_US_ADR[String(ticker).toUpperCase()];
    if (adr) events = await tryFetch(adr);
  }
  if (!events) return null;
  // Premier event futur (pas encore publie : actual = null)
  events.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const upcoming = events.find(e => e.epsActual == null) || events[0];
  if (!upcoming) return null;
  // Format Finnhub hour : 'bmo' = before market open, 'amc' = after market close, 'tas' = time after session
  // Format frontend : time = 'bmo' | 'amc' | null
  const next = {
    date: upcoming.date,
    period: upcoming.quarter ? `Q${upcoming.quarter}` : '',
    year: upcoming.year,
    time: upcoming.hour || null,
    epsEst: upcoming.epsEstimate != null ? Number(upcoming.epsEstimate) : null,
    confirmed: upcoming.epsActual != null,
  };
  const payload = { next, _source: 'finnhub', fetchedAt: new Date().toISOString() };
  try {
    await env.CACHE?.put(cacheKey, JSON.stringify(payload), { expirationTtl: 86400 + 3600 });
  } catch {}
  return payload;
}


// ============================================================
// FINNHUB PEERS : concurrents sectoriels (EU + US)
// Endpoint /stock/peers retourne 10-20 tickers similaires meme secteur.
// Pour LVMH (MC.PA via LVMUY) -> ['MC.PA', 'RMS.PA' (Hermes), 'CDI.PA' (Christian Dior),
// 'KER.PA' (Kering), ...] - peers EU concrets, contrairement a stockanalysis qui melange.
// Cache 7 jours (les peers changent peu).
// ============================================================
async function fetchFinnhubPeers(ticker, apiKey, env) {
  if (!apiKey || !ticker) return null;
  // v2 : bump apres enrichissement avec longName via Yahoo chart (mai 2026).
  const cacheKey = `finnhub-peers:v2:${String(ticker).toUpperCase()}`;
  if (env && env.CACHE) {
    try {
      const cached = await env.CACHE.get(cacheKey, 'json');
      if (cached && cached.fetchedAt) {
        const age = (Date.now() - new Date(cached.fetchedAt).getTime()) / 1000;
        if (age < 7 * 86400) return cached;
      }
    } catch {}
  }
  const tryFetch = async (sym) => {
    try {
      const r = await fetch(`https://finnhub.io/api/v1/stock/peers?symbol=${encodeURIComponent(sym)}&token=${apiKey}`);
      if (!r.ok) return null;
      const arr = await r.json();
      return Array.isArray(arr) && arr.length > 0 ? arr : null;
    } catch { return null; }
  };
  let tickers = await tryFetch(ticker);
  if (!tickers) {
    const adr = EU_TO_US_ADR[String(ticker).toUpperCase()];
    if (adr) tickers = await tryFetch(adr);
  }
  if (!tickers) return null;
  // Le 1er element est souvent le ticker lui-meme (Finnhub include input) -> exclu.
  // ENRICHISSEMENT NOM : pour chaque peer, on recupere le longName via Yahoo
  // chart endpoint (peer-name:TICKER cache 30j). Permet d'afficher 'RMS.PA -
  // Hermes International' au lieu de 'RMS.PA' seul.
  const upper = String(ticker).toUpperCase();
  const candidates = tickers
    .filter(t => t && t.toUpperCase() !== upper)
    .slice(0, 10)
    .map(t => String(t).toUpperCase());

  // Fetch noms en parallele (max 10 fetches, mais cache 30j -> typiquement ~0)
  const enriched = await Promise.all(candidates.map(async (peerTicker) => {
    const nameKey = `peer-name:${peerTicker}`;
    let name = '';
    if (env && env.CACHE) {
      try {
        const cachedName = await env.CACHE.get(nameKey, 'text');
        if (cachedName !== null) name = cachedName;
      } catch {}
    }
    if (!name) {
      try {
        const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(peerTicker)}?range=1d`, {
          headers: { 'User-Agent': YAHOO_UA },
        });
        if (r.ok) {
          const d = await r.json();
          const meta = d?.chart?.result?.[0]?.meta || {};
          name = meta.longName || meta.shortName || '';
          // Cache 30 jours (les noms ne changent pas)
          if (env && env.CACHE && name) {
            try {
              await env.CACHE.put(nameKey, name, { expirationTtl: 30 * 86400 });
            } catch {}
          }
        }
      } catch {}
    }
    return { ticker: peerTicker, name: name || '', employees: null };
  }));

  const payload = { peers: enriched, _source: 'finnhub', fetchedAt: new Date().toISOString() };
  try {
    await env.CACHE?.put(cacheKey, JSON.stringify(payload), { expirationTtl: 7 * 86400 + 3600 });
  } catch {}
  return payload;
}


// ============================================================
// AGGREGATORS : insiders depuis KV insider-transactions
// ============================================================
async function aggregateInsiders(ticker, env) {
  const result = {
    transactions: [],
    netValueEur: 0,
    netValueUsd: 0,
    buyCount: 0,
    sellCount: 0,
    uniqueInsiders: 0,
    clusterSignal: null,
    sources: {},
  };
  try {
    const data = await env.CACHE.get('insider-transactions', 'json');
    if (!data || !Array.isArray(data.transactions)) return result;

    const up = ticker.toUpperCase();
    const matches = data.transactions.filter(t => {
      const tTicker = (t.ticker || '').toUpperCase();
      return tTicker === up;
    });

    // Tri par date desc
    matches.sort((a, b) => (b.fileDate || '').localeCompare(a.fileDate || ''));

    const insiderSet = new Set();
    let totalUsd = 0, totalEur = 0, buys = 0, sells = 0;
    const sources = {};
    for (const t of matches) {
      insiderSet.add((t.insider || '').toLowerCase());
      const val = Number(t.value) || 0;
      const isBuy = (t.type === 'buy' || t.type === 'exercise');
      const isSell = (t.type === 'sell');
      const signed = isBuy ? val : (isSell ? -val : 0);
      if (t.currency === 'EUR') totalEur += signed;
      else totalUsd += signed;
      if (isBuy) buys++;
      if (isSell) sells++;
      const src = t.source || 'sec';
      sources[src] = (sources[src] || 0) + 1;
    }

    result.transactions = matches.slice(0, 50); // max 50 pour le payload
    result.netValueUsd = Math.round(totalUsd * 100) / 100;
    result.netValueEur = Math.round(totalEur * 100) / 100;
    result.buyCount = buys;
    result.sellCount = sells;
    result.uniqueInsiders = insiderSet.size;
    result.sources = sources;

    // Cluster signal : >= 3 insiders distincts sur 30j avec buys net positif
    const now = new Date();
    const cutoff30 = new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const recent = matches.filter(t => (t.fileDate || '') >= cutoff30);
    const recentInsiders = new Set(recent.filter(t => t.type === 'buy' || t.type === 'exercise').map(t => (t.insider || '').toLowerCase()));
    if (recentInsiders.size >= 3) {
      result.clusterSignal = {
        label: 'CLUSTER DETECTE',
        insiders: recentInsiders.size,
        windowDays: 30,
      };
    }
  } catch (e) {
    console.error('aggregateInsiders error:', e.message || e);
  }
  return result;
}

// ============================================================
// AGGREGATORS : Smart Money 13F
// Match par nom d'entreprise normalise (les 13F stockent CUSIP + nom, pas ticker).
// ============================================================
function normalizeCompanyName(name) {
  if (!name) return '';
  return String(name)
    .normalize('NFD')                  // Decompose accents : "MOËT" -> "MO" + "Ë" decomposed
    .replace(/[̀-ͯ]/g, '')   // Strip diacritics : "Ë" -> "E", "É" -> "E"
    .toUpperCase()
    .replace(/[.,\-]/g, ' ')           // Strip dots, commas AND DASHES
    // Retire les suffixes corporates en fin (les EU 'SOCIETE EUROPEENNE',
    // 'SOCIETE ANONYME' aussi). Repete pour gerer les double-suffixes type
    // "SE SA" qu'on voit parfois dans les filings.
    .replace(/\s+(SOCIETE EUROPEENNE|SOCIETE ANONYME|SOCIETE PAR ACTIONS SIMPLIFIEE)\b/g, '')
    .replace(/\s+(INC|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|LLC|LP|HOLDINGS|GROUP|SA|SE|AG|NV|N V|AB|OYJ|SPA|S A|KGAA|GMBH)\b/g, '')
    // Re-applique pour les double-suffixes (LVMH SE SA, etc.)
    .replace(/\s+(SOCIETE EUROPEENNE|SOCIETE ANONYME|INC|CORP|CO|LTD|PLC|LLC|LP|GROUP|SA|SE|AG|NV)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function aggregate13F(ticker, env, companyName) {
  const result = { topFunds: [], fundCount: 0, totalShares: 0, totalValue: 0, avgDeltaPct: 0 };
  try {
    const normalizedTarget = normalizeCompanyName(companyName);
    if (!normalizedTarget) return result;

    // ============================================================
    // STRATEGIE 1 : index inverse construit au pipeline time (TOUTES les positions)
    // Permet de trouver meme les small positions (hors top 50 d'un fonds).
    // Build du index : prefetch-13f.py -> KV '13f-ticker-index'
    // ============================================================
    const index = await env.CACHE.get('13f-ticker-index', 'json');
    let matches = [];
    let indexUsed = false;

    if (index && typeof index === 'object') {
      indexUsed = true;
      // Match exact d'abord
      let entries = index[normalizedTarget] || null;
      // Fallback : match par prefixe (ex. "APPLE" cherche "APPLE" dans les cles).
      // IMPORTANT EU FIX (mai 2026) : la SEC tronque les noms 13F a ~30 chars,
      // donc 'LVMH MOET HENNESSY LOUIS VUITTON' devient 'LVMH MOET HENNESSY LOUIS VUITT'
      // dans le KV. On accepte donc un match TRONQUE si :
      //   - normalizedTarget commence par les N premiers chars de k (sans exiger
      //     d'espace apres k, car k peut couper au milieu d'un mot)
      //   - ET k.length >= 20 (eviter les false positives sur des prefixes courts
      //     type 'AMAZON' qui matcherait Amazon Inc + Amazon Holdings + etc.)
      if (!entries) {
        const candidateKeys = Object.keys(index).filter(k => {
          if (k === normalizedTarget) return true;
          if (k.startsWith(normalizedTarget + ' ')) return true;
          if (normalizedTarget.startsWith(k + ' ')) return true;
          // EU fix : accepte k tronque par SEC 30-chars limit
          if (k.length >= 20 && normalizedTarget.startsWith(k)) return true;
          return false;
        });
        if (candidateKeys.length) {
          entries = [];
          for (const k of candidateKeys) {
            entries = entries.concat(index[k] || []);
          }
          // Dedup par fundName (plusieurs cles peuvent matcher LVMH = LVMH MOET... + LVMH MOET HENNESSY LOUIS = meme funds)
          const seen = new Set();
          entries = entries.filter(h => {
            const key = (h.n || h.fundName || '') + '|' + (h.d || h.reportDate || '');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        }
      }
      if (entries && entries.length) {
        // Index inverse ultra-compact (5 champs n/v/p/c/d) pour fit KV 25MB.
        // Mapping : n=fundName, v=value, p=pct, c=sharesChange, d=reportDate
        // shares + status sont computables cote client. Retrocompat ancien format.
        matches = entries.map(h => {
          const deltaPct = Number(h.c ?? h.sharesChange ?? h.deltaPct ?? h.change) || 0;
          // Derive status depuis deltaPct (coherent avec prefetch-13f.py)
          let status = h.t || h.status || null;
          if (!status) {
            if (deltaPct > 1) status = 'increased';
            else if (deltaPct < -1) status = 'decreased';
            else if (deltaPct === 0 && h.p > 0) status = 'unchanged';
            else status = 'new';
          }
          return {
            fundName: h.n || h.fundName || h.name || h.companyName || '',
            cik: h.k || h.cik || '',
            label: h.l || h.label,
            category: h.category,
            shares: Number(h.s ?? h.shares) || 0,
            value: Number(h.v ?? h.value) || 0,
            pctOfPortfolio: Number(h.p ?? h.pct ?? h.pctOfPortfolio ?? h.percentage) || 0,
            deltaPct,
            status,
            reportDate: h.d || h.reportDate,
          };
        });
      }
    }

    // ============================================================
    // STRATEGIE 2 (fallback) : si l'index n'est pas encore construit
    // (ex. avant le premier run du pipeline apres deploy), on retombe
    // sur le scan des topHoldings top 50 (comportement historique).
    // ============================================================
    if (!indexUsed || matches.length === 0) {
      const data = await env.CACHE.get('13f-all-funds', 'json');
      if (data) {
        const funds = Array.isArray(data) ? data : (data.funds || Object.entries(data).map(([name, f]) => ({ fundName: name, ...f })));
        for (const fund of funds) {
          const holdings = fund.topHoldings || fund.holdings || fund.positions || [];
          for (const h of holdings) {
            const hName = normalizeCompanyName(h.name || h.company || '');
            if (!hName) continue;
            const isMatch = hName === normalizedTarget
              || hName.startsWith(normalizedTarget + ' ')
              || normalizedTarget.startsWith(hName + ' ');
            if (isMatch) {
              matches.push({
                fundName: fund.fundName || fund.name || fund.manager || fund.label,
                label: fund.label,
                category: fund.category,
                shares: Number(h.shares) || 0,
                value: Number(h.value) || 0,
                pctOfPortfolio: Number(h.pct || h.pctOfPortfolio || h.percentage) || 0,
                deltaPct: Number(h.sharesChange || h.deltaPct || h.change) || 0,
                status: h.status || null,
                reportDate: fund.reportDate,
              });
              break;
            }
          }
        }
      }
    }

    matches.sort((a, b) => (b.value || 0) - (a.value || 0));
    result.topFunds = matches.slice(0, 20);
    result.fundCount = matches.length;
    result.totalShares = matches.reduce((s, m) => s + (m.shares || 0), 0);
    result.totalValue = matches.reduce((s, m) => s + (m.value || 0), 0);
    const deltas = matches.map(m => m.deltaPct).filter(d => Number.isFinite(d) && d !== 0);
    result.avgDeltaPct = deltas.length > 0 ? (deltas.reduce((s, d) => s + d, 0) / deltas.length) : 0;
    result._source = indexUsed ? 'ticker-index' : 'top-holdings-scan';
  } catch (e) {
    console.error('aggregate13F error:', e.message || e);
  }
  return result;
}

// ============================================================
// AGGREGATORS : ETF Politiciens + Gurus (NANC, GOP, GURU)
// ============================================================
async function aggregateGovEtf(ticker, env) {
  const result = { inEtfs: [], totalPct: 0 };
  // Etendu mai 2026 : avant on ne checkait que NANC/GOP/GURU. Pour les EU, ce
  // sont les ETFs convictions (MOAT, DSTL, MTUM) + international (PXF, PID) qui
  // peuvent contenir LVMH/Hermes/SAP/etc. On scan donc les 16 ETFs et on filtre
  // par categorie cote frontend si besoin.
  const keys = [
    // Politiciens
    { key: 'etf-nanc', label: 'NANC', full: 'Démocrates US (Pelosi & co)', cat: 'politics' },
    { key: 'etf-gop',  label: 'GOP',  full: 'Républicains US', cat: 'politics' },
    // Smart money
    { key: 'etf-guru', label: 'GURU', full: 'Top hedge funds 13F', cat: 'smart' },
    // Sentiment
    { key: 'etf-buzz', label: 'BUZZ', full: 'Sentiment retail Twitter/Reddit', cat: 'sentiment' },
    { key: 'etf-meme', label: 'MEME', full: 'Roundhill MEME', cat: 'sentiment' },
    // Income
    { key: 'etf-jepi', label: 'JEPI', full: 'JPMorgan Equity Premium', cat: 'income' },
    { key: 'etf-jepq', label: 'JEPQ', full: 'JPMorgan Nasdaq Premium', cat: 'income' },
    // Thematiques
    { key: 'etf-ita',  label: 'ITA',  full: 'Defense & Aerospace', cat: 'theme' },
    { key: 'etf-ura',  label: 'URA',  full: 'Uranium', cat: 'theme' },
    { key: 'etf-ufo',  label: 'UFO',  full: 'Espace', cat: 'theme' },
    { key: 'etf-mj',   label: 'MJ',   full: 'Cannabis', cat: 'theme' },
    // Convictions Wall Street (mai 2026)
    { key: 'etf-moat', label: 'MOAT', full: 'Wide Moat (Morningstar Buffett-style)', cat: 'conviction' },
    { key: 'etf-dstl', label: 'DSTL', full: 'Quality + Low Debt (Distillate)', cat: 'conviction' },
    { key: 'etf-mtum', label: 'MTUM', full: 'Momentum Factor', cat: 'conviction' },
    // International (couvre les EU)
    { key: 'etf-pxf',  label: 'PXF',  full: 'Developed ex-US (RAFI fundamental)', cat: 'international' },
    { key: 'etf-pid',  label: 'PID',  full: 'International Dividend Achievers', cat: 'international' },
  ];
  try {
    const up = ticker.toUpperCase();
    // Pour les EU, le ticker du KV ETF peut etre soit le ticker EU direct (RMS.PA),
    // soit l'ADR US (HESAY). On accepte les 2 + un fallback name match si besoin.
    const adrUp = (EU_TO_US_ADR[up] || '').toUpperCase();
    // Premier pass : match exact par ticker (US OU ADR)
    const tickerVariants = [up, adrUp].filter(Boolean);
    for (const { key, label, full, cat } of keys) {
      const data = await env.CACHE.get(key, 'json');
      if (!data) continue;
      const holdings = data.holdings || data.positions || [];
      const match = holdings.find(h => {
        const ht = (h.ticker || h.symbol || '').toUpperCase();
        return tickerVariants.includes(ht);
      });
      if (match) {
        const pct = Number(match.weight || match.pctOfPortfolio || match.percentage) || 0;
        result.inEtfs.push({
          etf: label,
          fullName: full,
          category: cat,
          weight: pct,
          shares: Number(match.shares) || 0,
        });
        result.totalPct += pct;
      }
    }
  } catch (e) {
    console.error('aggregateGovEtf error:', e.message || e);
  }
  return result;
}

// ============================================================
// GOOGLE TRENDS : interet de recherche (pre-fetche par GitHub Actions)
// Stocke dans KV sous 'google-trends-data' par un script Python quotidien.
// Retourne null si pas de donnees pour ce ticker.
// ============================================================
async function fetchGoogleTrends(ticker, env) {
  try {
    const bundle = await env.CACHE.get('google-trends-data', 'json');
    if (!bundle || !bundle.tickers) return null;
    const up = (ticker || '').toUpperCase();
    const data = bundle.tickers[up];
    if (!data) return null;
    return {
      interestNow: data.interestNow,
      interestMean: data.interestMean,
      interestMax: data.interestMax,
      spike7d: data.spike7d,
      trend: data.trend, // 'rising' | 'falling' | 'stable'
      series: data.series, // [{date, value}]
      pointsCount: data.pointsCount,
      updatedAt: bundle.updatedAt || null,
    };
  } catch (e) {
    console.error('fetchGoogleTrends error:', e.message || e);
    return null;
  }
}

// ============================================================
// KAIROS SCORE : composite 0-100 avec 8 sous-scores + poids parametrables
// ============================================================
// Les poids par defaut somment a 100 (score max = 100). Chaque axe est
// calcule en interne sur une base fixe (BASE_MAX), puis le score final
// pour l'axe = (score_brut / BASE_MAX) * poids_custom.
//
// Pour personnaliser les poids : console admin → panneau 'Ponderation
// Kairos Score' → ecrit dans KV config:score-weights.
// ============================================================
const SCORE_BASE_MAX = {
  insider: 20, smartMoney: 20, govGuru: 10, momentum: 15,
  valuation: 10, analyst: 10, health: 10, earnings: 5,
};
const SCORE_DEFAULT_WEIGHTS = { ...SCORE_BASE_MAX }; // somme = 100


// ============================================================
// SYNTHESE CONSENSUS DEPUIS ZONEBOURSE
// ============================================================
// Zonebourse fournit : note gauge (0-10), recommandation moyenne textuelle
// (ACHETER/ACCUMULER/CONSERVER/ALLEGER/VENDRE), nombre d'analystes, target.
// MAIS pas le breakdown des votes individuels.
//
// On synthetise un breakdown buy/hold/sell PLAUSIBLE pour que le frontend
// (qui attend strongBuy/buy/hold/sell/strongSell) puisse afficher quelque
// chose de coherent au lieu de "undefined".
//
// La distribution est calibree sur la note gauge :
//   9.0+   : tres haussier  -> majorite strongBuy
//   8.0-9.0: haussier fort  -> mix strongBuy + buy
//   7.0-8.0: haussier (cas LVMH 7.8) -> majorite buy + un peu strongBuy
//   6.0-7.0: legerement haussier -> mix buy + hold
//   5.0-6.0: neutre -> majorite hold
//   4.0-5.0: legerement baissier -> mix hold + sell
//   3.0-4.0: baissier -> majorite sell
//   <3.0   : tres baissier -> majorite strongSell
//
// IMPORTANT : breakdown synthetise marque _synthesized=true et _source='zonebourse'
// pour transparence. Le frontend peut afficher un badge "estime" si souhaite.
export function synthesizeConsensusFromZonebourse(zb) {
  const N = Math.max(1, parseInt(zb.analystCount, 10) || 0);
  const note = parseFloat(zb.gaugeNote) || null;

  // Distribution (% de chaque categorie)
  let dist;  // [strongBuy, buy, hold, sell, strongSell]
  if (note != null) {
    if (note >= 9.0) dist = [0.65, 0.30, 0.05, 0, 0];
    else if (note >= 8.0) dist = [0.40, 0.45, 0.15, 0, 0];
    else if (note >= 7.0) dist = [0.25, 0.50, 0.20, 0.05, 0];
    else if (note >= 6.0) dist = [0.10, 0.40, 0.40, 0.10, 0];
    else if (note >= 5.0) dist = [0, 0.20, 0.60, 0.20, 0];
    else if (note >= 4.0) dist = [0, 0.10, 0.40, 0.40, 0.10];
    else if (note >= 3.0) dist = [0, 0.05, 0.25, 0.45, 0.25];
    else dist = [0, 0, 0.15, 0.30, 0.55];
  } else {
    // Fallback sur recommendationMean si pas de note gauge
    const rec = (zb.recommendationMean || zb.consensus || '').toUpperCase();
    if (/ACHETER|FORT|STRONG\s*BUY/.test(rec)) dist = [0.55, 0.35, 0.10, 0, 0];
    else if (/ACCUMULER|ACHAT|BUY/.test(rec)) dist = [0.25, 0.50, 0.20, 0.05, 0];
    else if (/CONSERVER|HOLD|NEUTRE/.test(rec)) dist = [0, 0.20, 0.60, 0.20, 0];
    else if (/ALLEGER|REDUCE/.test(rec)) dist = [0, 0.05, 0.40, 0.40, 0.15];
    else if (/VENDRE|SELL/.test(rec)) dist = [0, 0, 0.15, 0.40, 0.45];
    else dist = [0, 0.20, 0.60, 0.20, 0];  // default neutre
  }

  // Allocation des votes : on calcule strongBuy = round(dist[0]*N), etc.
  // Puis on adjuste le dernier pour que total = N exactement.
  const counts = dist.slice(0, 4).map(p => Math.round(p * N));
  let allocated = counts.reduce((a, b) => a + b, 0);
  counts.push(Math.max(0, N - allocated));  // strongSell = reliquat

  const [strongBuy, buy, hold, sell, strongSell] = counts;
  const bullishPct = N > 0 ? Math.round(((strongBuy + buy) / N) * 100) : 0;

  return {
    // Format compatible stockanalysis.com pour rendering identique
    strongBuy, buy, hold, sell, strongSell,
    total: N,
    bullishPct,
    targetMeanPrice: zb.targetMean || null,
    targetCurrency: zb.targetCurrency || 'EUR',
    totalAnalysts: N,
    recommendationKey: (zb.recommendationMean || zb.consensus || '').toLowerCase(),
    recommendationLabel: zb.recommendationMean || zb.consensus || null,
    gaugeNote: note,
    // Markers de transparence
    _source: 'zonebourse',
    _synthesized: true,
    _synthesisBasis: note != null ? `note ${note}/10` : `recommandation ${zb.recommendationMean}`,
  };
}


function computeKairosScore({ insiders, smartMoney, govEtf, quote, fundamentals, consensus, health, earnings, euThresholds, weights }) {
  // weights custom OU defaults (meme repartition que BASE_MAX)
  const W = { ...SCORE_DEFAULT_WEIGHTS, ...(weights || {}) };

  const breakdown = {
    insider: { score: 0, max: W.insider, label: 'Signal des initiés', detail: '', dataOk: true },
    smartMoney: { score: 0, max: W.smartMoney, label: 'Hedge funds (13F)', detail: '', dataOk: true },
    govGuru: { score: 0, max: W.govGuru, label: 'Politiciens & gourous', detail: '', dataOk: true },
    momentum: { score: 0, max: W.momentum, label: 'Momentum du cours', detail: '', dataOk: true },
    valuation: { score: 0, max: W.valuation, label: 'Valorisation', detail: '', dataOk: true },
    analyst: { score: 0, max: W.analyst, label: 'Consensus analystes', detail: '', dataOk: true },
    health: { score: 0, max: W.health, label: 'Santé financière', detail: '', dataOk: true },
    earnings: { score: 0, max: W.earnings, label: 'Momentum résultats', detail: '', dataOk: true },
  };

  // Data presence check : dataOk=false signale que la source a probablement rate,
  // donc le pilier a defaut vers le score "neutre" et ne reflete pas la realite.
  // Le pipeline push-scores-to-d1.py utilisera ce flag pour faire du fallback
  // "last known good" (= ne pas ecraser une bonne valeur par un defaut neutre).
  const hasInsiderData = (insiders.buyCount || 0) > 0 || (insiders.sellCount || 0) > 0 || (insiders.uniqueInsiders || 0) > 0;
  const hasSmartMoneyData = (smartMoney.fundCount || 0) > 0;
  const hasGovGuruData = Array.isArray(govEtf.inEtfs) && govEtf.inEtfs.length > 0;
  const hasMomentumData = !!(quote && quote.price && quote.price.current && quote.price.high52w && quote.price.low52w);
  const hasValuationData = !!(fundamentals && (fundamentals.peRatio || fundamentals.forwardPE));
  const hasAnalystData = !!(consensus && consensus.total > 0) || !!(fundamentals && fundamentals.targetMeanPrice);
  const hasHealthData = !!(health && (health.altmanZ != null || health.piotroskiF != null));
  const hasEarningsData = Array.isArray(earnings && earnings.history) && earnings.history.length > 0;

  breakdown.insider.dataOk = hasInsiderData;
  breakdown.smartMoney.dataOk = hasSmartMoneyData;
  breakdown.govGuru.dataOk = hasGovGuruData;
  breakdown.momentum.dataOk = hasMomentumData;
  breakdown.valuation.dataOk = hasValuationData;
  breakdown.analyst.dataOk = hasAnalystData;
  breakdown.health.dataOk = hasHealthData;
  breakdown.earnings.dataOk = hasEarningsData;

  // Helper : applique le poids custom a un score brut calcule sur BASE_MAX.
  // Ex: insider raw=15 sur BASE_MAX=20 → normalized=0.75 → si weight=25 → score=19
  const applyWeight = (axis, rawScore) => {
    const baseMax = SCORE_BASE_MAX[axis];
    const normalized = Math.max(0, Math.min(1, rawScore / baseMax));
    return Math.round(normalized * W[axis]);
  };

  // --- INSIDER (0-20) ---
  const totalNet = (insiders.netValueUsd || 0) + (insiders.netValueEur || 0);
  const buyVsSell = insiders.buyCount - insiders.sellCount;
  let insiderScore = 10; // neutre
  if (totalNet > 0) insiderScore += Math.min(6, Math.log10(Math.abs(totalNet) + 1) * 1.5);
  else if (totalNet < 0) insiderScore -= Math.min(6, Math.log10(Math.abs(totalNet) + 1) * 1.5);
  if (buyVsSell > 0) insiderScore += Math.min(2, buyVsSell * 0.4);
  else if (buyVsSell < 0) insiderScore -= Math.min(2, Math.abs(buyVsSell) * 0.4);
  if (insiders.clusterSignal) insiderScore += 3;
  if (insiders.uniqueInsiders >= 5) insiderScore += 1;
  breakdown.insider.score = applyWeight('insider', insiderScore);
  breakdown.insider.detail = `${insiders.buyCount} achats / ${insiders.sellCount} ventes, ${insiders.uniqueInsiders} initiés uniques${insiders.clusterSignal ? ', CLUSTER DÉTECTÉ' : ''}`;

  // --- SMART MONEY (0-20) ---
  // 13F US (existing) + boost EU thresholds (BlackRock/Norges/etc. franchissant
  // un seuil sur ce ticker EU). Pour les actions EU, le 13F est souvent vide
  // mais les filings AMF/FCA/SIX/AFM/BaFin remontent les positions des grands
  // institutionnels et activists - même valeur informationnelle.
  let smScore = 10;
  if (smartMoney.fundCount >= 1) smScore += Math.min(6, smartMoney.fundCount * 0.5);
  if (smartMoney.avgDeltaPct > 5) smScore += 4;
  else if (smartMoney.avgDeltaPct > 0) smScore += 2;
  else if (smartMoney.avgDeltaPct < -5) smScore -= 4;
  else if (smartMoney.avgDeltaPct < 0) smScore -= 2;

  // EU thresholds boost
  const euData = euThresholds || {};
  const euTotal = euData.totalFilings || 0;
  const euActivists = euData.activistsCount || 0;
  const euRecent = euData.recentFilings || 0;
  if (euTotal > 0) {
    // Smart money EU detection : presence de filings + filers connus = boost
    smScore += Math.min(4, euTotal * 0.3);  // jusqu'a +4 si beaucoup de filings
    if (euActivists > 0) smScore += Math.min(3, euActivists);  // boost activists
    if (euRecent >= 3) smScore += 2;  // momentum recent
  }
  breakdown.smartMoney.score = applyWeight('smartMoney', smScore);

  // Detail enrichi : 13F US + EU filings + biggest filer
  const detailParts = [];
  if (smartMoney.fundCount > 0) {
    detailParts.push(`${smartMoney.fundCount} fonds 13F (Δ ${smartMoney.avgDeltaPct.toFixed(1)}%)`);
  }
  if (euTotal > 0) {
    const filerLabel = euData.biggestFiler
      ? ` — top: ${euData.biggestFiler.name}${euData.biggestFiler.isActivist ? ' ⚡' : ''}`
      : '';
    detailParts.push(`${euTotal} filings EU (${euActivists} activists)${filerLabel}`);
  }
  breakdown.smartMoney.detail = detailParts.length > 0
    ? detailParts.join(' · ')
    : 'Aucune position smart money détectée';
  // Mark dataOk si on a au moins une source qui a remonte des donnees
  breakdown.smartMoney.dataOk = (smartMoney.fundCount || 0) > 0 || euTotal > 0;

  // --- GOV/GURU (0-10) ---
  let ggScore = 5;
  if (govEtf.inEtfs.length > 0) ggScore += govEtf.inEtfs.length * 1.5;
  if (govEtf.totalPct > 1) ggScore += 1;
  breakdown.govGuru.score = applyWeight('govGuru', ggScore);
  breakdown.govGuru.detail = govEtf.inEtfs.length > 0
    ? `Présent dans ${govEtf.inEtfs.map(e => e.etf).join(', ')} (${govEtf.totalPct.toFixed(2)}%)`
    : 'Absent des ETF suivis';

  // --- MOMENTUM (0-15) ---
  let momScore = 7;
  const price = quote && quote.price;
  if (price && price.current && price.high52w && price.low52w) {
    const range = price.high52w - price.low52w;
    if (range > 0) {
      const positionInRange = (price.current - price.low52w) / range; // 0..1
      // Plus proche du haut = meilleur momentum
      momScore = Math.round(positionInRange * 15);
    }
  }
  if (price && price.changePct > 2) momScore = Math.min(15, momScore + 2);
  else if (price && price.changePct < -2) momScore = Math.max(0, momScore - 2);
  breakdown.momentum.score = applyWeight('momentum', momScore);
  if (price && price.high52w) {
    const distHigh = ((price.high52w - price.current) / price.high52w) * 100;
    breakdown.momentum.detail = `${distHigh.toFixed(0)}% sous le plus-haut 52 sem.`;
  } else {
    breakdown.momentum.detail = 'Données de cours insuffisantes';
  }

  // --- VALUATION (0-10) ---
  let valScore = 5;
  const stats = fundamentals || {};
  if (stats.peRatio && stats.peRatio > 0) {
    if (stats.peRatio < 15) valScore += 3;
    else if (stats.peRatio < 25) valScore += 1;
    else if (stats.peRatio > 40) valScore -= 2;
  }
  if (stats.forwardPE && stats.peRatio && stats.forwardPE < stats.peRatio) valScore += 1;
  breakdown.valuation.score = applyWeight('valuation', valScore);
  breakdown.valuation.detail = stats.peRatio
    ? `P/E ${stats.peRatio.toFixed(1)}${stats.forwardPE ? `, prév. ${stats.forwardPE.toFixed(1)}` : ''}`
    : 'P/E indisponible';

  // --- ANALYST CONSENSUS (0-10) ---
  let anaScore = 5;
  if (consensus && consensus.total > 0) {
    const bullish = consensus.bullishPct || 0;
    anaScore = Math.round(bullish / 10); // 0..10
  } else if (stats.targetMeanPrice && price && price.current) {
    // Fallback : target stockanalysis vs prix
    const upside = ((stats.targetMeanPrice - price.current) / price.current) * 100;
    if (upside > 20) anaScore = 9;
    else if (upside > 10) anaScore = 7;
    else if (upside > 0) anaScore = 6;
    else if (upside > -10) anaScore = 4;
    else anaScore = 2;
  }
  breakdown.analyst.score = applyWeight('analyst', anaScore);
  if (consensus && consensus.total > 0) {
    breakdown.analyst.detail = `${consensus.bullishPct.toFixed(0)}% haussiers (${consensus.total} analystes)`;
  } else if (stats.targetMeanPrice && price && price.current) {
    const upside = ((stats.targetMeanPrice - price.current) / price.current) * 100;
    breakdown.analyst.detail = `Objectif ${stats.targetMeanPrice.toFixed(0)} (${upside > 0 ? '+' : ''}${upside.toFixed(0)}%)`;
  } else {
    breakdown.analyst.detail = 'Pas de consensus';
  }

  // --- HEALTH (0-10) : Altman Z + Piotroski F + Debt/Equity ---
  let healthScore = 5;
  const h = health || {};
  const bits = [];
  if (h.altmanZ != null) {
    if (h.altmanZ > 2.99) { healthScore += 3; bits.push(`Z=${h.altmanZ.toFixed(1)} (sain)`); }
    else if (h.altmanZ > 1.81) { healthScore += 0; bits.push(`Z=${h.altmanZ.toFixed(1)} (gris)`); }
    else { healthScore -= 3; bits.push(`Z=${h.altmanZ.toFixed(1)} (détresse)`); }
  }
  if (h.piotroskiF != null) {
    if (h.piotroskiF >= 7) { healthScore += 3; bits.push(`F=${h.piotroskiF}/9 (solide)`); }
    else if (h.piotroskiF >= 4) { healthScore += 0; bits.push(`F=${h.piotroskiF}/9`); }
    else { healthScore -= 2; bits.push(`F=${h.piotroskiF}/9 (faible)`); }
  }
  breakdown.health.score = applyWeight('health', healthScore);
  breakdown.health.detail = bits.length > 0 ? bits.join(', ') : 'Scores indisponibles';

  // --- EARNINGS MOMENTUM (0-5) : beats consecutifs ---
  let earnScore = 2;
  const hist = (earnings && earnings.history) || [];
  const last4 = hist.slice(0, 4);
  const beats = last4.filter(x => x.beat).length;
  if (last4.length > 0) {
    earnScore = Math.round((beats / last4.length) * 5);
    breakdown.earnings.detail = `${beats}/${last4.length} dépassements sur les ${last4.length} derniers trimestres`;
  } else {
    breakdown.earnings.detail = 'Historique indisponible';
  }
  breakdown.earnings.score = applyWeight('earnings', earnScore);

  // --- Total ---
  const total = Object.values(breakdown).reduce((s, b) => s + b.score, 0);

  let signal = 'NEUTRE';
  let signalColor = 'gray';
  if (total >= 75) { signal = 'ACHAT FORT'; signalColor = 'green'; }
  else if (total >= 60) { signal = 'ACHAT'; signalColor = 'greenLight'; }
  else if (total >= 40) { signal = 'NEUTRE'; signalColor = 'gray'; }
  else if (total >= 25) { signal = 'VENTE'; signalColor = 'redLight'; }
  else { signal = 'VENTE FORTE'; signalColor = 'red'; }

  return {
    total,
    signal,
    signalColor,
    breakdown,
  };
}
