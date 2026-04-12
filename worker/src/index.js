/**
 * Kairos Insider — Cloudflare Worker
 * 1. Proxy sécurisé Brevo (envoi emails waitlist)
 * 2. Proxy SEC EDGAR (Form 4 insider trades) avec cache KV
 * 3. Auth par mot de passe pour les routes /api/*
 */

const SEC_USER_AGENT = 'KairosInsider contact@kairosinsider.fr';
const CACHE_TTL_INSIDER = 14400;  // 4 heures
const CACHE_TTL_DETAIL  = 86400;  // 24 heures

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    // --- CORS Preflight ---
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin || env.ALLOWED_ORIGIN) });
    }

    // --- Vérification de l'origine ---
    if (!isAllowedOrigin(origin, env.ALLOWED_ORIGIN)) {
      return jsonResponse({ error: 'Origin not allowed' }, 403, env.ALLOWED_ORIGIN);
    }

    // --- Router ---
    const path = url.pathname;

    // Email waitlist (existant)
    if (request.method === 'POST' && path === '/send-welcome') {
      return handleSendWelcome(request, env, origin);
    }

    // API routes (protégées par mot de passe)
    if (request.method === 'GET' && path.startsWith('/api/')) {
      const key = request.headers.get('X-Dashboard-Key') || '';
      if (key !== env.DASHBOARD_PASSWORD) {
        return jsonResponse({ error: 'Unauthorized' }, 401, origin);
      }

      if (path === '/api/insider-trades') {
        return handleInsiderTrades(url, env, origin);
      }
      if (path === '/api/insider-detail') {
        return handleInsiderDetail(url, env, origin);
      }
      if (path === '/api/13f-search') {
        return handle13FSearch(url, env, origin);
      }
      if (path === '/api/13f-fund') {
        return handle13FFund(url, env, origin);
      }
      if (path === '/api/clusters') {
        const data = await env.CACHE.get('insider-clusters', 'json');
        if (!data) return jsonResponse({ error: 'Clusters not loaded' }, 503, origin);
        return jsonResponse(data, 200, origin);
      }
      if (path === '/api/13f-funds') {
        return handle13FFunds(env, origin);
      }
      if (path === '/api/etf-ark') {
        return handleEtfArk(url, env, origin);
      }
      if (path === '/api/etf-congress') {
        return handleEtfCongress(url, env, origin);
      }
      if (path === '/api/etf-guru') {
        return handleEtfGuru(env, origin);
      }
    }

    return jsonResponse({ error: 'Not found' }, 404, env.ALLOWED_ORIGIN);
  },
};

// ============================================================
// ROUTE: POST /send-welcome (existant — email Brevo)
// ============================================================
async function handleSendWelcome(request, env, origin) {
  try {
    const body = await request.json();
    const email = (body.email || '').trim().toLowerCase();
    const emailRegex = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
    if (!email || !emailRegex.test(email) || email.length > 200) {
      return jsonResponse({ error: 'Invalid email' }, 400, origin);
    }

    const brevoResponse = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        templateId: parseInt(env.BREVO_TEMPLATE_ID),
        to: [{ email }],
      }),
    });

    if (!brevoResponse.ok) {
      console.error('Brevo error:', brevoResponse.status, await brevoResponse.text());
      return jsonResponse({ error: 'Email service error' }, 500, origin);
    }

    const data = await brevoResponse.json();
    return jsonResponse({ ok: true, messageId: data.messageId }, 200, origin);
  } catch (err) {
    console.error('handleSendWelcome error:', err);
    return jsonResponse({ error: 'Internal error' }, 500, origin);
  }
}

// ============================================================
// ROUTE: GET /api/insider-trades — liste des Form 4 récents
// Params: ?page=0 (défaut 0)
// ============================================================
async function handleInsiderTrades(url, env, origin) {
  const page = parseInt(url.searchParams.get('page') || '0');
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '30'), 1), 90);
  const startIdx = page * 40;
  const today = new Date().toISOString().split('T')[0];
  const cacheKey = `v3:insider-trades:${today}:d${days}:page:${page}`;

  // Vérifier le cache KV
  const cached = await env.CACHE.get(cacheKey, 'json');
  if (cached) return jsonResponse(cached, 200, origin);

  try {
    // Recherche des Form 4 récents sur SEC EDGAR
    const now = new Date();
    const endDate = now.toISOString().split('T')[0];
    const startDate = new Date(now - days * 86400000).toISOString().split('T')[0];
    // Stratégie : chercher jour par jour en partant d'aujourd'hui
    // pour garantir l'ordre chronologique décroissant
    const skipCount = page * 10;
    let allHits = [];
    let total = 0;
    let skipped = 0;

    // Parcourir les jours du plus récent au plus ancien
    for (let d = 0; d < days && allHits.length < 10; d++) {
      const dayDate = new Date(now - d * 86400000).toISOString().split('T')[0];
      const edgarUrl = `https://efts.sec.gov/LATEST/search-index?q=&forms=4&dateRange=custom&startdt=${dayDate}&enddt=${dayDate}&from=0&size=100`;

      const edgarResp = await fetch(edgarUrl, {
        headers: { 'User-Agent': SEC_USER_AGENT },
      });

      if (!edgarResp.ok) continue;

      const edgarData = await edgarResp.json();
      const dayHits = edgarData.hits?.hits || [];
      const dayTotal = edgarData.hits?.total?.value || 0;
      total += dayTotal;

      // Gérer la pagination : sauter les résultats des pages précédentes
      for (const hit of dayHits) {
        if (skipped < skipCount) {
          skipped++;
          continue;
        }
        allHits.push(hit);
        if (allHits.length >= 10) break;
      }

      // Optimisation : si on a déjà assez de résultats, on arrête
      if (allHits.length >= 10) break;
    }

    // Parser le XML de chaque filing (en parallèle)
    const trades = await Promise.all(
      allHits.map(hit => parseForm4Filing(hit))
    );

    const validTrades = trades.filter(t => t !== null);

    const result = {
      total,
      page,
      pageSize: 10,
      trades: validTrades,
    };

    // Mettre en cache
    await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL_INSIDER });

    return jsonResponse(result, 200, origin);
  } catch (err) {
    console.error('handleInsiderTrades error:', err);
    return jsonResponse({ error: 'Failed to fetch insider trades' }, 500, origin);
  }
}

// ============================================================
// ROUTE: GET /api/insider-detail — détail XML d'un Form 4
// Params: ?adsh=0001225208-26-004129&file=doc4.xml
// ============================================================
async function handleInsiderDetail(url, env, origin) {
  const adsh = url.searchParams.get('adsh') || '';
  const file = url.searchParams.get('file') || '';
  if (!adsh || !file) {
    return jsonResponse({ error: 'Missing adsh or file param' }, 400, origin);
  }

  const cacheKey = `insider-detail:${adsh}`;
  const cached = await env.CACHE.get(cacheKey, 'json');
  if (cached) return jsonResponse(cached, 200, origin);

  try {
    const cik = adsh.split('-')[0].replace(/^0+/, '');
    const xmlUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${adsh.replace(/-/g, '')}/${file}`;
    const xmlResp = await fetch(xmlUrl, {
      headers: { 'User-Agent': SEC_USER_AGENT },
    });

    if (!xmlResp.ok) {
      return jsonResponse({ error: 'Filing not found' }, 404, origin);
    }

    const xmlText = await xmlResp.text();
    const parsed = parseForm4Xml(xmlText);

    await env.CACHE.put(cacheKey, JSON.stringify(parsed), { expirationTtl: CACHE_TTL_DETAIL });

    return jsonResponse(parsed, 200, origin);
  } catch (err) {
    console.error('handleInsiderDetail error:', err);
    return jsonResponse({ error: 'Failed to parse filing' }, 500, origin);
  }
}

// ============================================================
// PARSERS
// ============================================================

/**
 * Extraire les infos de base d'un hit EDGAR search
 */
async function parseForm4Filing(hit) {
  try {
    const src = hit._source;
    const id = hit._id; // "adsh:filename"
    const [adsh, fileName] = id.split(':');
    const names = src.display_names || [];

    // Le premier CIK est l'insider, le second est la société
    const insiderName = names[0] ? names[0].replace(/\s*\(CIK \d+\)/, '') : 'Inconnu';
    const companyName = names[1] ? names[1].replace(/\s*\(CIK \d+\)/, '') : 'Inconnu';

    // Tenter de récupérer le XML pour les détails de transaction
    const cik = (src.ciks && src.ciks[1]) || '';
    const adshClean = adsh.replace(/-/g, '');
    const xmlUrl = `https://www.sec.gov/Archives/edgar/data/${cik.replace(/^0+/, '')}/${adshClean}/${fileName}`;

    let transactions = [];
    let ticker = '';
    let ownerTitle = '';

    try {
      const xmlResp = await fetch(xmlUrl, {
        headers: { 'User-Agent': SEC_USER_AGENT },
      });
      if (xmlResp.ok) {
        const xmlText = await xmlResp.text();
        const parsed = parseForm4Xml(xmlText);
        transactions = parsed.transactions || [];
        ticker = parsed.ticker || '';
        ownerTitle = parsed.ownerTitle || '';
      }
    } catch (_) {
      // Si le XML ne charge pas, on renvoie les infos de base
    }

    return {
      adsh,
      fileName,
      fileDate: src.file_date,
      periodEnding: src.period_ending,
      insiderName: insiderName.trim(),
      companyName: companyName.trim(),
      ticker,
      ownerTitle,
      transactions,
    };
  } catch (err) {
    console.error('parseForm4Filing error:', err);
    return null;
  }
}

/**
 * Parser le XML d'un Form 4 pour extraire les transactions
 */
function parseForm4Xml(xml) {
  const getText = (tag) => {
    const match = xml.match(new RegExp(`<${tag}>\\s*<value>([^<]*)</value>`, 's'));
    return match ? match[1].trim() : '';
  };

  const getSimple = (tag) => {
    const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
    return match ? match[1].trim() : '';
  };

  const ticker = getSimple('issuerTradingSymbol');
  const companyName = getSimple('issuerName');
  const ownerName = getSimple('rptOwnerName');
  const ownerTitle = getSimple('officerTitle');

  // Parser les transactions non-dérivées
  const transactions = [];
  const txRegex = /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g;
  let txMatch;

  while ((txMatch = txRegex.exec(xml)) !== null) {
    const block = txMatch[1];

    const getVal = (tag) => {
      const m = block.match(new RegExp(`<${tag}>\\s*<value>([^<]*)</value>`, 's'));
      return m ? m[1].trim() : '';
    };

    const txDate = getVal('transactionDate');
    const txCode = getVal('transactionCode');
    const shares = parseFloat(getVal('transactionShares')) || 0;
    const price = parseFloat(getVal('transactionPricePerShare')) || 0;
    const acquiredDisposed = getVal('transactionAcquiredDisposedCode');
    const sharesAfter = parseFloat(getVal('sharesOwnedFollowingTransaction')) || 0;

    transactions.push({
      date: txDate,
      code: txCode,
      shares,
      price,
      value: Math.round(shares * price * 100) / 100,
      acquiredDisposed,
      sharesAfter,
    });
  }

  return {
    ticker,
    companyName,
    ownerName,
    ownerTitle,
    transactions,
  };
}

// ============================================================
// ROUTE: GET /api/13f-search — recherche de dépôts 13F-HR par ticker
// Params: ?symbol=AAPL
// ============================================================
async function handle13FSearch(url, env, origin) {
  const symbol = (url.searchParams.get('symbol') || '').toUpperCase();
  if (!symbol) {
    return jsonResponse({ error: 'Missing symbol param' }, 400, origin);
  }

  const cacheKey = `13f-search:${symbol}`;
  const cached = await env.CACHE.get(cacheKey, 'json');
  if (cached) return jsonResponse(cached, 200, origin);

  try {
    // Recherche des 13F-HR mentionnant ce ticker sur les 90 derniers jours
    const now = new Date();
    const endDate = now.toISOString().split('T')[0];
    const startDate = new Date(now - 90 * 86400000).toISOString().split('T')[0];
    const edgarUrl = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent('"' + symbol + '"')}&forms=13F-HR&dateRange=custom&startdt=${startDate}&enddt=${endDate}&from=0&size=20`;

    const edgarResp = await fetch(edgarUrl, {
      headers: { 'User-Agent': SEC_USER_AGENT },
    });

    if (!edgarResp.ok) {
      return jsonResponse({ error: 'SEC EDGAR error' }, 502, origin);
    }

    const edgarData = await edgarResp.json();
    const hits = edgarData.hits?.hits || [];
    const total = edgarData.hits?.total?.value || 0;

    const filings = hits.map(hit => {
      const src = hit._source;
      const names = src.display_names || [];
      const filerName = names[0] ? names[0].replace(/\s*\(CIK \d+\)/, '').trim() : 'Inconnu';
      const filerCik = (src.ciks && src.ciks[0]) || '';
      return {
        filerName,
        filerCik,
        fileDate: src.file_date,
        periodEnding: src.period_ending,
      };
    });

    const result = { total, symbol, filings };
    await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 86400 });

    return jsonResponse(result, 200, origin);
  } catch (err) {
    console.error('handle13FSearch error:', err);
    return jsonResponse({ error: 'Failed to search 13F filings' }, 500, origin);
  }
}

// ============================================================
// ROUTE: GET /api/13f-funds — liste pré-chargée de tous les fonds
// ============================================================
async function handle13FFunds(env, origin) {
  const data = await env.CACHE.get('13f-all-funds', 'json');
  if (!data) {
    return jsonResponse({ error: 'Fund data not loaded yet' }, 503, origin);
  }
  return jsonResponse(data, 200, origin);
}

// ============================================================
// ROUTE: GET /api/13f-fund — positions d'un fonds via son CIK
// Params: ?cik=0001067983
// ============================================================
async function handle13FFund(url, env, origin) {
  const cik = (url.searchParams.get('cik') || '').replace(/^0+/, '');
  if (!cik) {
    return jsonResponse({ error: 'Missing cik param' }, 400, origin);
  }

  const cikPadded = cik.padStart(10, '0');
  const cacheKey = `v1:13f-fund:${cikPadded}`;
  const cached = await env.CACHE.get(cacheKey, 'json');
  if (cached) return jsonResponse(cached, 200, origin);

  try {
    // 1. Récupérer les submissions du fonds
    const subResp = await fetch(`https://data.sec.gov/submissions/CIK${cikPadded}.json`, {
      headers: { 'User-Agent': SEC_USER_AGENT },
    });
    if (!subResp.ok) return jsonResponse({ error: 'Fund not found' }, 404, origin);

    const subData = await subResp.json();
    const fundName = subData.name || 'Unknown';
    const recent = subData.filings?.recent || {};
    const forms = recent.form || [];

    // 2. Trouver le dernier 13F-HR
    let filingIdx = -1;
    for (let i = 0; i < forms.length; i++) {
      if (forms[i] === '13F-HR') { filingIdx = i; break; }
    }

    if (filingIdx === -1) {
      return jsonResponse({ error: 'No 13F filing found', fundName }, 404, origin);
    }

    const accession = recent.accessionNumber[filingIdx];
    const filingDate = recent.filingDate[filingIdx];
    const reportDate = recent.reportDate[filingIdx];
    const accessionClean = accession.replace(/-/g, '');

    // 3. Lister les fichiers du filing pour trouver l'info table XML
    const indexUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${accessionClean}/`;
    const indexResp = await fetch(indexUrl, {
      headers: { 'User-Agent': SEC_USER_AGENT },
    });

    if (!indexResp.ok) {
      return jsonResponse({ error: 'Filing index not accessible' }, 502, origin);
    }

    const indexHtml = await indexResp.text();
    // Trouver tous les fichiers .xml sauf primary_doc.xml et xsl*
    const xmlMatches = indexHtml.match(/href="([^"]*\.xml)"/gi) || [];
    const xmlFiles = xmlMatches
      .map(m => m.match(/href="([^"]*)"/i)?.[1])
      .filter(f => f && !f.includes('primary_doc') && !f.includes('xsl'));

    if (xmlFiles.length === 0) {
      return jsonResponse({ error: 'Info table not found', fundName, filingDate, reportDate }, 404, origin);
    }

    // 4. Télécharger l'info table XML
    const infoTableUrl = `${indexUrl}${xmlFiles[0]}`;
    const xmlResp = await fetch(infoTableUrl, {
      headers: { 'User-Agent': SEC_USER_AGENT },
    });

    if (!xmlResp.ok) {
      return jsonResponse({ error: 'Info table not accessible' }, 502, origin);
    }

    const xmlText = await xmlResp.text();

    // 5. Parser les positions
    const holdings = [];
    const entryRegex = /<infoTable>([\s\S]*?)<\/infoTable>/g;
    let match;

    while ((match = entryRegex.exec(xmlText)) !== null) {
      const block = match[1];
      const getTag = (tag) => {
        const m = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
        return m ? m[1].trim() : '';
      };

      const name = getTag('nameOfIssuer');
      const cusip = getTag('cusip');
      const value = parseInt(getTag('value')) || 0; // en milliers de $
      const shares = parseInt(getTag('sshPrnamt')) || 0;
      const shareType = getTag('sshPrnamtType');
      const putCall = getTag('putCall');

      // Ignorer les entrées de type PUT/CALL ou non-SH
      if (putCall || shareType !== 'SH') continue;

      // Agréger si même CUSIP (certains fonds déclarent en plusieurs lignes)
      const existing = holdings.find(h => h.cusip === cusip);
      if (existing) {
        existing.value += value;
        existing.shares += shares;
      } else {
        holdings.push({ name, cusip, value, shares });
      }
    }

    // 6. Trier par valeur décroissante
    holdings.sort((a, b) => b.value - a.value);

    // Valeur totale (en $, pas en milliers)
    const totalValue = holdings.reduce((sum, h) => sum + h.value, 0) * 1000;

    // Top 15 positions avec % du portefeuille
    const topHoldings = holdings.slice(0, 15).map(h => ({
      name: h.name,
      cusip: h.cusip,
      shares: h.shares,
      value: h.value * 1000, // Convertir en $
      pct: totalValue > 0 ? Math.round((h.value * 1000 / totalValue) * 1000) / 10 : 0,
    }));

    const result = {
      fundName,
      cik: cikPadded,
      filingDate,
      reportDate,
      totalValue,
      holdingsCount: holdings.length,
      topHoldings,
    };

    // 7. Cache 7 jours (les 13F ne changent que trimestriellement)
    await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 604800 });

    return jsonResponse(result, 200, origin);
  } catch (err) {
    console.error('handle13FFund error:', err);
    return jsonResponse({ error: 'Failed to fetch fund data' }, 500, origin);
  }
}

// ============================================================
// ROUTE: GET /api/etf-ark — positions quotidiennes ARK ETFs
// Params: ?symbol=ARKK (ARKK, ARKW, ARKG, ARKF, ARKQ)
// ============================================================
async function handleEtfArk(url, env, origin) {
  const symbol = (url.searchParams.get('symbol') || 'ARKK').toUpperCase();
  const allowed = ['ARKK', 'ARKW', 'ARKG', 'ARKF', 'ARKQ'];
  if (!allowed.includes(symbol)) {
    return jsonResponse({ error: 'Invalid ARK symbol' }, 400, origin);
  }

  const today = new Date().toISOString().split('T')[0];
  const cacheKey = `v2:etf-ark:${symbol}:${today}`;
  const cached = await env.CACHE.get(cacheKey, 'json');
  if (cached) return jsonResponse(cached, 200, origin);

  try {
    const resp = await fetch(`https://arkfunds.io/api/v2/etf/holdings?symbol=${symbol}`);
    if (!resp.ok) return jsonResponse({ error: 'ARK API error' }, 502, origin);

    const data = await resp.json();

    // Charger les positions de la veille (snapshot precedent) pour comparaison
    const prevKey = `ark-prev:${symbol}`;
    const prevData = await env.CACHE.get(prevKey, 'json') || {};
    const prevMap = {};
    if (prevData.holdings) {
      for (const h of prevData.holdings) {
        prevMap[h.ticker] = { weight: h.weight, shares: h.shares };
      }
    }

    const holdings = (data.holdings || []).map(h => {
      const ticker = h.ticker || '';
      const weight = h.weight || 0;
      const shares = h.shares || 0;

      // Calcul de l'evolution vs veille
      let weightChange = null;
      let sharesChange = null;
      let status = 'unchanged';
      const prev = prevMap[ticker];
      if (prev) {
        weightChange = Math.round((weight - prev.weight) * 100) / 100;
        if (prev.shares > 0) {
          sharesChange = Math.round(((shares - prev.shares) / prev.shares) * 1000) / 10;
        }
        if (sharesChange !== null && sharesChange > 0.5) status = 'increased';
        else if (sharesChange !== null && sharesChange < -0.5) status = 'decreased';
        else status = 'unchanged';
      } else if (Object.keys(prevMap).length > 0) {
        status = 'new';
      }

      return {
        ticker,
        company: h.company || '',
        shares,
        value: h.market_value || 0,
        price: h.share_price || 0,
        weight,
        rank: h.weight_rank || 0,
        weightChange,
        sharesChange,
        status,
      };
    });

    const result = {
      symbol,
      date: data.date_from || today,
      prevDate: prevData.date || null,
      label: 'Cathie Wood',
      category: 'Innovation',
      holdingsCount: holdings.length,
      totalValue: holdings.reduce((s, h) => s + h.value, 0),
      holdings,
    };

    // Sauvegarder les positions d'aujourd'hui comme "previous" pour demain
    await env.CACHE.put(prevKey, JSON.stringify({
      date: result.date,
      holdings: holdings.map(h => ({ ticker: h.ticker, weight: h.weight, shares: h.shares })),
    }), { expirationTtl: 172800 }); // 48h TTL

    await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 14400 });
    return jsonResponse(result, 200, origin);
  } catch (err) {
    console.error('handleEtfArk error:', err);
    return jsonResponse({ error: 'Failed to fetch ARK data' }, 500, origin);
  }
}

// ============================================================
// ROUTE: GET /api/etf-congress — positions NANC ou GOP
// Params: ?symbol=NANC ou ?symbol=GOP
// ============================================================
async function handleEtfCongress(url, env, origin) {
  const symbol = (url.searchParams.get('symbol') || 'NANC').toUpperCase();
  if (symbol !== 'NANC' && symbol !== 'GOP') {
    return jsonResponse({ error: 'Invalid symbol (NANC or GOP)' }, 400, origin);
  }
  // Données pré-chargées dans KV (mises à jour via GitHub Action)
  const data = await env.CACHE.get(`etf-${symbol.toLowerCase()}`, 'json');
  if (!data) return jsonResponse({ error: 'Congress ETF data not loaded' }, 503, origin);
  return jsonResponse(data, 200, origin);
}

// ============================================================
// ROUTE: GET /api/etf-guru — positions GURU ETF (top hedge fund picks)
// ============================================================
async function handleEtfGuru(env, origin) {
  // Données pré-chargées dans KV (mises à jour via GitHub Action)
  const data = await env.CACHE.get('etf-guru', 'json');
  if (!data) return jsonResponse({ error: 'GURU ETF data not loaded' }, 503, origin);
  return jsonResponse(data, 200, origin);
}

// ============================================================
// HELPERS
// ============================================================

function isAllowedOrigin(origin, allowed) {
  return (
    origin === allowed ||
    origin === 'http://localhost:8093' ||
    origin === 'http://127.0.0.1:8093' ||
    !origin // Allow no-origin (curl, server-side)
  );
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Dashboard-Key',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}
