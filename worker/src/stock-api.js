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

const YAHOO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
const CACHE_TTL = 900; // 15 min

// ============================================================
// ENTREE PRINCIPALE
// ============================================================
export async function handleStockAnalysis(ticker, env, options = {}) {
  const { publicView = false } = options;
  ticker = String(ticker || '').toUpperCase().trim().replace(/[^A-Z0-9.\-]/g, '');
  if (!ticker || ticker.length > 12) {
    return { error: 'Invalid ticker', code: 'INVALID_TICKER' };
  }

  // Cache : 2 variantes (public tronque / premium complet)
  const cacheKey = `stock-analysis:${ticker}:${publicView ? 'pub' : 'full'}`;
  const cached = await env.CACHE.get(cacheKey, 'json');
  if (cached && cached._cachedAt && (Date.now() - cached._cachedAt) < CACHE_TTL * 1000) {
    return cached;
  }

  // Etape 1 : insiders d'abord (pour extraire le company name fiable)
  const insiders = await aggregateInsiders(ticker, env);
  const companyNameFromInsiders = (insiders.transactions[0] && insiders.transactions[0].company) || null;

  // Etape 2 : tout le reste en parallele (avec le company name pour le 13F)
  // NB: stockanalysis.com renvoie fondamentaux + consensus analystes + description en un seul appel
  const [quote, overview, news, smartMoney, govEtf] = await Promise.all([
    fetchYahooQuote(ticker),
    fetchStockAnalysisOverview(ticker),
    fetchYahooNews(ticker),
    aggregate13F(ticker, env, companyNameFromInsiders),
    aggregateGovEtf(ticker, env),
  ]);
  const fundamentals = overview.fundamentals;
  const consensus = overview.consensus;

  const score = computeKairosScore({ insiders, smartMoney, govEtf, quote, fundamentals, consensus });

  const result = {
    ticker,
    updatedAt: new Date().toISOString(),
    _cachedAt: Date.now(),
    company: {
      name: (overview.profile && overview.profile.name) || (quote && quote.company && quote.company.name) || ticker,
      sector: (overview.profile && overview.profile.sector) || null,
      industry: (overview.profile && overview.profile.industry) || null,
      country: (overview.profile && overview.profile.country) || null,
      website: (overview.profile && overview.profile.website) || null,
      description: (overview.profile && overview.profile.description) || null,
      employees: (overview.profile && overview.profile.employees) || null,
      exchange: (overview.profile && overview.profile.exchange) || null,
    },
    price: quote.price,
    chart: quote.chart,
    fundamentals,
    score,
    insiders,
    smartMoney,
    govEtf,
    news,
    consensus,
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
// YAHOO FINANCE : prix + chart
// ============================================================
async function fetchYahooQuote(ticker) {
  const empty = { price: null, chart: null, company: { name: ticker } };
  try {
    // chart v8 : prix courant + historique 1 an (daily)
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1y&includePrePost=false`;
    const resp = await fetch(url, { headers: { 'User-Agent': YAHOO_UA, 'Accept': 'application/json' } });
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

    return {
      price: {
        current: meta.regularMarketPrice,
        previousClose: meta.chartPreviousClose || meta.previousClose,
        change: meta.regularMarketPrice != null && meta.chartPreviousClose != null
          ? meta.regularMarketPrice - meta.chartPreviousClose : null,
        changePct: meta.regularMarketPrice != null && meta.chartPreviousClose != null
          ? ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100 : null,
        currency: meta.currency || 'USD',
        exchange: meta.exchangeName || null,
        high52w: meta.fiftyTwoWeekHigh,
        low52w: meta.fiftyTwoWeekLow,
      },
      chart: {
        range: '1y',
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
      const resp = await withTimeout(fetch(url, {
        headers: { 'User-Agent': YAHOO_UA, 'Accept': 'application/json', 'Referer': 'https://stockanalysis.com/' },
      }), 7000);
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
    .toUpperCase()
    .replace(/[.,]/g, ' ')
    .replace(/\s+(INC|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|LLC|LP|HOLDINGS|GROUP|SA|SE|AG|NV|N V|AB|OYJ|SPA|S A)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function aggregate13F(ticker, env, companyName) {
  const result = { topFunds: [], fundCount: 0, totalShares: 0, totalValue: 0, avgDeltaPct: 0 };
  try {
    const data = await env.CACHE.get('13f-all-funds', 'json');
    if (!data) return result;

    // Format attendu : array de funds avec fund.topHoldings = [{ name, cusip, shares, value, pct, sharesChange, status }]
    const funds = Array.isArray(data) ? data : (data.funds || Object.entries(data).map(([name, f]) => ({ fundName: name, ...f })));
    const normalizedTarget = normalizeCompanyName(companyName);
    if (!normalizedTarget) return result;

    const matches = [];
    for (const fund of funds) {
      const holdings = fund.topHoldings || fund.holdings || fund.positions || [];
      for (const h of holdings) {
        const hName = normalizeCompanyName(h.name || h.company || '');
        if (!hName) continue;
        // Match exact OU l'un commence par l'autre (ex. "APPLE" vs "APPLE")
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

    matches.sort((a, b) => (b.value || 0) - (a.value || 0));
    result.topFunds = matches.slice(0, 20);
    result.fundCount = matches.length;
    result.totalShares = matches.reduce((s, m) => s + (m.shares || 0), 0);
    result.totalValue = matches.reduce((s, m) => s + (m.value || 0), 0);
    const deltas = matches.map(m => m.deltaPct).filter(d => Number.isFinite(d) && d !== 0);
    result.avgDeltaPct = deltas.length > 0 ? (deltas.reduce((s, d) => s + d, 0) / deltas.length) : 0;
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
  const keys = [
    { key: 'etf-nanc', label: 'NANC', full: 'Democrats' },
    { key: 'etf-gop', label: 'GOP', full: 'Republicans' },
    { key: 'etf-guru', label: 'GURU', full: 'Hedge Fund Gurus' },
  ];
  try {
    for (const { key, label, full } of keys) {
      const data = await env.CACHE.get(key, 'json');
      if (!data) continue;
      const holdings = data.holdings || data.positions || [];
      const up = ticker.toUpperCase();
      const match = holdings.find(h => (h.ticker || h.symbol || '').toUpperCase() === up);
      if (match) {
        const pct = Number(match.weight || match.pctOfPortfolio || match.percentage) || 0;
        result.inEtfs.push({
          etf: label,
          fullName: full,
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
// KAIROS SCORE : composite 0-100 avec 6 sous-scores
// ============================================================
function computeKairosScore({ insiders, smartMoney, govEtf, quote, fundamentals, consensus }) {
  const breakdown = {
    insider: { score: 0, max: 25, label: 'Signal Insider', detail: '' },
    smartMoney: { score: 0, max: 25, label: 'Smart Money 13F', detail: '' },
    govGuru: { score: 0, max: 15, label: 'Politiciens & Gurus', detail: '' },
    momentum: { score: 0, max: 15, label: 'Momentum', detail: '' },
    valuation: { score: 0, max: 10, label: 'Valorisation', detail: '' },
    analyst: { score: 0, max: 10, label: 'Analyst Consensus', detail: '' },
  };

  // --- INSIDER (0-25) ---
  // Base : net value signed + cluster bonus + unique insiders
  const totalNet = (insiders.netValueUsd || 0) + (insiders.netValueEur || 0);
  const buyVsSell = insiders.buyCount - insiders.sellCount;
  let insiderScore = 12; // neutre
  if (totalNet > 0) insiderScore += Math.min(8, Math.log10(Math.abs(totalNet) + 1) * 2);
  else if (totalNet < 0) insiderScore -= Math.min(8, Math.log10(Math.abs(totalNet) + 1) * 2);
  if (buyVsSell > 0) insiderScore += Math.min(3, buyVsSell * 0.5);
  else if (buyVsSell < 0) insiderScore -= Math.min(3, Math.abs(buyVsSell) * 0.5);
  if (insiders.clusterSignal) insiderScore += 4;
  if (insiders.uniqueInsiders >= 5) insiderScore += 2;
  breakdown.insider.score = Math.max(0, Math.min(25, Math.round(insiderScore)));
  breakdown.insider.detail = `${insiders.buyCount} achats / ${insiders.sellCount} ventes, ${insiders.uniqueInsiders} insiders uniques${insiders.clusterSignal ? ', CLUSTER DETECTE' : ''}`;

  // --- SMART MONEY (0-25) ---
  let smScore = 12; // neutre
  if (smartMoney.fundCount >= 1) smScore += Math.min(8, smartMoney.fundCount * 0.5);
  if (smartMoney.avgDeltaPct > 5) smScore += 5;
  else if (smartMoney.avgDeltaPct > 0) smScore += 2;
  else if (smartMoney.avgDeltaPct < -5) smScore -= 5;
  else if (smartMoney.avgDeltaPct < 0) smScore -= 2;
  breakdown.smartMoney.score = Math.max(0, Math.min(25, Math.round(smScore)));
  breakdown.smartMoney.detail = `${smartMoney.fundCount} fonds, evolution moyenne ${smartMoney.avgDeltaPct.toFixed(1)}%`;

  // --- GOV/GURU (0-15) ---
  let ggScore = 7;
  if (govEtf.inEtfs.length > 0) ggScore += govEtf.inEtfs.length * 2;
  if (govEtf.totalPct > 1) ggScore += 2;
  breakdown.govGuru.score = Math.max(0, Math.min(15, Math.round(ggScore)));
  breakdown.govGuru.detail = govEtf.inEtfs.length > 0
    ? `Present dans ${govEtf.inEtfs.map(e => e.etf).join(', ')} (${govEtf.totalPct.toFixed(2)}%)`
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
  breakdown.momentum.score = Math.max(0, Math.min(15, momScore));
  if (price && price.high52w) {
    const distHigh = ((price.high52w - price.current) / price.high52w) * 100;
    breakdown.momentum.detail = `${distHigh.toFixed(0)}% sous le plus-haut 52 sem.`;
  } else {
    breakdown.momentum.detail = 'Donnees prix insuffisantes';
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
  breakdown.valuation.score = Math.max(0, Math.min(10, Math.round(valScore)));
  breakdown.valuation.detail = stats.peRatio
    ? `P/E ${stats.peRatio.toFixed(1)}${stats.forwardPE ? `, Fwd ${stats.forwardPE.toFixed(1)}` : ''}`
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
  breakdown.analyst.score = Math.max(0, Math.min(10, anaScore));
  if (consensus && consensus.total > 0) {
    breakdown.analyst.detail = `${consensus.bullishPct.toFixed(0)}% haussiers (${consensus.total} analystes)`;
  } else if (stats.targetMeanPrice && price && price.current) {
    const upside = ((stats.targetMeanPrice - price.current) / price.current) * 100;
    breakdown.analyst.detail = `Target ${stats.targetMeanPrice.toFixed(0)} (${upside > 0 ? '+' : ''}${upside.toFixed(0)}%)`;
  } else {
    breakdown.analyst.detail = 'Pas de consensus';
  }

  // --- Total ---
  const total = Object.values(breakdown).reduce((s, b) => s + b.score, 0);

  let signal = 'NEUTRE';
  let signalColor = 'gray';
  if (total >= 75) { signal = 'STRONG BUY'; signalColor = 'green'; }
  else if (total >= 60) { signal = 'BUY'; signalColor = 'greenLight'; }
  else if (total >= 40) { signal = 'NEUTRE'; signalColor = 'gray'; }
  else if (total >= 25) { signal = 'SELL'; signalColor = 'redLight'; }
  else { signal = 'STRONG SELL'; signalColor = 'red'; }

  return {
    total,
    signal,
    signalColor,
    breakdown,
  };
}
