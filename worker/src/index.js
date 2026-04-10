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
  const startIdx = page * 40;
  const today = new Date().toISOString().split('T')[0];
  const cacheKey = `insider-trades:${today}:page:${page}`;

  // Vérifier le cache KV
  const cached = await env.CACHE.get(cacheKey, 'json');
  if (cached) return jsonResponse(cached, 200, origin);

  try {
    // Recherche des Form 4 récents sur SEC EDGAR (7 derniers jours)
    const now = new Date();
    const endDate = now.toISOString().split('T')[0];
    const startDate = new Date(now - 7 * 86400000).toISOString().split('T')[0];
    const edgarUrl = `https://efts.sec.gov/LATEST/search-index?q=%22&forms=4&dateRange=custom&startdt=${startDate}&enddt=${endDate}&from=${startIdx}&size=40`;
    const edgarResp = await fetch(edgarUrl, {
      headers: { 'User-Agent': SEC_USER_AGENT },
    });

    if (!edgarResp.ok) {
      return jsonResponse({ error: 'SEC EDGAR error' }, 502, origin);
    }

    const edgarData = await edgarResp.json();
    const hits = edgarData.hits?.hits || [];
    const total = edgarData.hits?.total?.value || 0;

    // Pour chaque filing, récupérer le XML détaillé (en parallèle, max 10)
    const filings = hits.slice(0, 10);
    const trades = await Promise.all(
      filings.map(hit => parseForm4Filing(hit))
    );

    const result = {
      total,
      page,
      pageSize: 10,
      trades: trades.filter(t => t !== null),
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
