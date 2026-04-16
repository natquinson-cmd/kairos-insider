/**
 * Kairos Insider — Cloudflare Worker
 * 1. Proxy Brevo (emails waitlist) — public
 * 2. Auth Firebase (JWT verification) — comptes utilisateurs
 * 3. Stripe (checkout, webhook, subscription status) — abonnements
 * 4. Proxy SEC EDGAR + KV data — données dashboard
 *
 * Modèle freemium :
 *   - Public : POST /send-welcome
 *   - Gratuit (auth) : /api/feargreed, /api/shorts
 *   - Premium (auth + abo) : /api/all-transactions, /api/clusters, /api/13f-*, /api/etf-*
 */

import { handleStockAnalysis } from './stock-api.js';

const SEC_USER_AGENT = 'KairosInsider contact@kairosinsider.fr';

// Routes gratuites (auth requise mais pas d'abonnement)
const FREE_ROUTES = ['/api/feargreed', '/api/shorts', '/api/trends-hot'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    // --- CORS Preflight ---
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin || env.ALLOWED_ORIGIN) });
    }

    // --- Vérification de l'origine (sauf webhook Stripe) ---
    const path = url.pathname;
    if (path !== '/stripe/webhook' && !isAllowedOrigin(origin, env.ALLOWED_ORIGIN)) {
      return jsonResponse({ error: 'Origin not allowed' }, 403, env.ALLOWED_ORIGIN);
    }

    // ==========================================
    // ROUTES PUBLIQUES (pas d'auth)
    // ==========================================
    if (request.method === 'POST' && path === '/send-welcome') {
      return handleSendWelcome(request, env, origin);
    }

    // Stripe webhook (pas d'auth Firebase, vérifié par signature Stripe)
    if (request.method === 'POST' && path === '/stripe/webhook') {
      return handleStripeWebhook(request, env);
    }

    // Analyse action — version publique SEO (donnees tronquees)
    // Format : GET /public/stock/:ticker
    if (request.method === 'GET' && path.startsWith('/public/stock/')) {
      const ticker = decodeURIComponent(path.slice('/public/stock/'.length));
      const data = await handleStockAnalysis(ticker, env, { publicView: true });
      return jsonResponse(data, data.error ? 400 : 200, origin);
    }

    // Liste des tickers suivis (pour l'autocomplete de la barre de recherche)
    if (request.method === 'GET' && path === '/public/tickers') {
      return handlePublicTickersList(env, origin);
    }

    // Sitemap XML dynamique (SEO - Googlebot)
    if (request.method === 'GET' && path === '/sitemap.xml') {
      return handleSitemap(env);
    }

    // robots.txt (SEO)
    if (request.method === 'GET' && path === '/robots.txt') {
      return handleRobotsTxt(env);
    }

    // SSR HTML pour bots sociaux + Googlebot (Facebook, Twitter, LinkedIn, ChatGPT...)
    // Format : GET /a/:ticker -> HTML complet pre-rendu (meta tags + contenu indexable)
    if (request.method === 'GET' && path.startsWith('/a/')) {
      const ticker = decodeURIComponent(path.slice('/a/'.length));
      return handleActionSSR(ticker, env);
    }

    // ==========================================
    // ROUTES AUTHENTIFIÉES (Firebase JWT requis)
    // ==========================================
    if (path.startsWith('/api/') || path.startsWith('/stripe/')) {
      // Vérifier le token Firebase
      const authHeader = request.headers.get('Authorization') || '';
      const idToken = authHeader.replace('Bearer ', '');

      if (!idToken) {
        return jsonResponse({ error: 'No token provided' }, 401, origin);
      }

      const user = await verifyFirebaseToken(idToken, env);
      if (!user) {
        return jsonResponse({ error: 'Invalid or expired token' }, 401, origin);
      }

      // --- Routes Stripe (auth requise) ---
      if (request.method === 'POST' && path === '/stripe/create-checkout') {
        return handleCreateCheckout(request, env, user, origin);
      }
      if (request.method === 'GET' && path === '/stripe/status') {
        return handleSubscriptionStatus(env, user, origin);
      }
      if (request.method === 'POST' && path === '/stripe/portal') {
        return handleCustomerPortal(request, env, user, origin);
      }

      // --- Routes API ---
      if (request.method === 'GET' && path.startsWith('/api/')) {
        // Routes gratuites (pas besoin d'abonnement)
        const isFree = FREE_ROUTES.includes(path);

        if (!isFree) {
          // Vérifier l'abonnement premium
          const subData = await env.CACHE.get(`sub:${user.uid}`, 'json');
          const isActive = subData && subData.status === 'active';
          const isPastDue = subData && subData.status === 'past_due';

          if (!isActive && !isPastDue) {
            return jsonResponse({ error: 'Premium subscription required', code: 'PREMIUM_REQUIRED' }, 403, origin);
          }
        }

        return handleApiRoute(path, url, env, origin);
      }
    }

    return jsonResponse({ error: 'Not found' }, 404, env.ALLOWED_ORIGIN);
  },
};

// ============================================================
// AUTH : Vérification Firebase ID Token (via REST API)
// ============================================================
async function verifyFirebaseToken(idToken, env) {
  try {
    const resp = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      }
    );

    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.users || data.users.length === 0) return null;

    return {
      uid: data.users[0].localId,
      email: data.users[0].email,
      emailVerified: data.users[0].emailVerified,
    };
  } catch (err) {
    console.error('Firebase token verification error:', err);
    return null;
  }
}

// ============================================================
// API ROUTER (données dashboard)
// ============================================================
async function handleApiRoute(path, url, env, origin) {
  // KV-served routes
  if (path === '/api/all-transactions') {
    const data = await env.CACHE.get('insider-transactions', 'json');
    if (!data) return jsonResponse({ error: 'Data not loaded' }, 503, origin);
    return jsonResponse(data, 200, origin);
  }
  if (path === '/api/clusters') {
    const data = await env.CACHE.get('insider-clusters', 'json');
    if (!data) return jsonResponse({ error: 'Data not loaded' }, 503, origin);
    return jsonResponse(data, 200, origin);
  }
  if (path === '/api/13f-funds') {
    const data = await env.CACHE.get('13f-all-funds', 'json');
    if (!data) return jsonResponse({ error: 'Data not loaded' }, 503, origin);
    return jsonResponse(data, 200, origin);
  }
  if (path === '/api/13f-consensus') {
    return handleSmartMoneyConsensus(env, origin);
  }
  if (path === '/api/13f-activity') {
    return handleQuarterActivity(env, origin);
  }
  if (path === '/api/etf-ark') {
    return handleEtfArk(url, env, origin);
  }
  if (path === '/api/etf-congress') {
    return handleEtfCongress(url, env, origin);
  }
  if (path === '/api/etf-guru') {
    const data = await env.CACHE.get('etf-guru', 'json');
    if (!data) return jsonResponse({ error: 'Data not loaded' }, 503, origin);
    return jsonResponse(data, 200, origin);
  }

  // Google Trends : top risers + hot tickers (pour la section Hot Stocks)
  if (path === '/api/trends-hot') {
    const data = await env.CACHE.get('google-trends-hot', 'json');
    if (!data) return jsonResponse({ error: 'Trends data not loaded yet' }, 503, origin);
    return jsonResponse(data, 200, origin);
  }

  // Analyse action — premium (donnees completes)
  // Format : GET /api/stock/:ticker
  if (path.startsWith('/api/stock/')) {
    const ticker = decodeURIComponent(path.slice('/api/stock/'.length));
    const data = await handleStockAnalysis(ticker, env, { publicView: false });
    return jsonResponse(data, data.error ? 400 : 200, origin);
  }

  // Free routes
  if (path === '/api/feargreed' || path === '/api/shorts') {
    // Ces données sont dans le frontend, pas besoin de backend
    return jsonResponse({ ok: true }, 200, origin);
  }

  return jsonResponse({ error: 'Unknown API route' }, 404, origin);
}

// ============================================================
// LISTE DES TICKERS SUIVIS (pour autocomplete, public)
// ============================================================
async function handlePublicTickersList(env, origin) {
  try {
    // Cache dedie 1h
    const cached = await env.CACHE.get('public-tickers-list', 'json');
    if (cached && cached._cachedAt && (Date.now() - cached._cachedAt) < 3600 * 1000) {
      return jsonResponse(cached, 200, origin);
    }

    const tx = await env.CACHE.get('insider-transactions', 'json');
    const set = new Map(); // ticker -> { name, region, market }
    if (tx && Array.isArray(tx.transactions)) {
      for (const t of tx.transactions) {
        const ticker = (t.ticker || '').trim().toUpperCase();
        // Filtre : garder que les tickers bien formes (A-Z, 0-9, ., -, 1-6 chars)
        if (!ticker || !/^[A-Z0-9.\-]{1,6}$/.test(ticker)) continue;
        if (!set.has(ticker)) {
          set.set(ticker, {
            ticker,
            name: t.company || '',
            region: t.region || 'US',
            market: t.market || 'US',
          });
        }
      }
    }
    const tickers = Array.from(set.values()).sort((a, b) => a.ticker.localeCompare(b.ticker));
    const payload = {
      _cachedAt: Date.now(),
      count: tickers.length,
      tickers,
    };
    await env.CACHE.put('public-tickers-list', JSON.stringify(payload), { expirationTtl: 3600 });
    return jsonResponse(payload, 200, origin);
  } catch (e) {
    return jsonResponse({ error: 'Failed to build tickers list', detail: String(e && e.message || e) }, 500, origin);
  }
}

// ============================================================
// 13F : Smart Money Consensus
// Aggrege les top holdings de tous les fonds suivis et compte combien
// de fonds detiennent chaque action. C'est le "consensus" du smart money.
// ============================================================
async function handleSmartMoneyConsensus(env, origin) {
  try {
    const funds = await env.CACHE.get('13f-all-funds', 'json');
    if (!funds || !Array.isArray(funds)) {
      return jsonResponse({ error: 'No 13F data available' }, 503, origin);
    }

    // Mapping CUSIP / name -> ticker (depuis le cache des transactions)
    // On utilise le name normalise comme cle d'agregation principale.
    const tickerByName = new Map();
    try {
      const tx = await env.CACHE.get('insider-transactions', 'json');
      if (tx && Array.isArray(tx.transactions)) {
        for (const t of tx.transactions) {
          const tk = (t.ticker || '').trim().toUpperCase();
          const cn = normalizeForMatch(t.company);
          if (tk && cn && !tickerByName.has(cn)) tickerByName.set(cn, tk);
        }
      }
    } catch (_) {}

    // Aggregation : pour chaque holding (par name normalise), on compile
    // le nb de fonds, la value totale, la liste des fonds qui detiennent.
    const consensus = new Map(); // name -> { name, ticker, fundCount, totalValue, totalShares, fundsHolding[] }

    for (const fund of funds) {
      if (!Array.isArray(fund.topHoldings)) continue;
      for (const h of fund.topHoldings) {
        if (!h.name) continue;
        const key = normalizeForMatch(h.name);
        if (!key) continue;

        if (!consensus.has(key)) {
          consensus.set(key, {
            name: h.name,
            ticker: tickerByName.get(key) || null,
            cusip: h.cusip || null,
            fundCount: 0,
            totalValue: 0,
            totalShares: 0,
            avgPctOfPortfolio: 0,
            fundsHolding: [],
          });
        }
        const entry = consensus.get(key);
        entry.fundCount += 1;
        entry.totalValue += Number(h.value) || 0;
        entry.totalShares += Number(h.shares) || 0;
        entry.fundsHolding.push({
          fundName: fund.fundName,
          label: fund.label || null,
          category: fund.category || null,
          cik: fund.cik,
          shares: Number(h.shares) || 0,
          value: Number(h.value) || 0,
          pct: Number(h.pct) || 0,            // % du portefeuille du fonds
          sharesChange: h.sharesChange != null ? Number(h.sharesChange) : null,
          status: h.status || null,            // 'new' / 'increased' / 'decreased' / 'sold'
        });
      }
    }

    // Calcul moyenne pct + tri par fundCount desc, puis totalValue desc
    const list = Array.from(consensus.values()).map(c => {
      const pcts = c.fundsHolding.map(f => f.pct).filter(p => p > 0);
      c.avgPctOfPortfolio = pcts.length ? +(pcts.reduce((a, b) => a + b, 0) / pcts.length).toFixed(2) : 0;
      // Trier les fundsHolding par value desc
      c.fundsHolding.sort((a, b) => b.value - a.value);
      return c;
    });
    list.sort((a, b) => (b.fundCount - a.fundCount) || (b.totalValue - a.totalValue));

    return jsonResponse({
      updatedAt: new Date().toISOString(),
      totalFunds: funds.length,
      totalUniqueStocks: list.length,
      consensus: list.slice(0, 200),  // top 200
    }, 200, origin);
  } catch (e) {
    return jsonResponse({ error: 'Consensus computation failed', detail: String(e && e.message || e) }, 500, origin);
  }
}

// ============================================================
// 13F : Activite du dernier trimestre (mouvements significatifs)
// Liste les nouvelles positions, sorties completes, augmentations, reductions
// par fond (basee sur le champ "status" et "sharesChange" deja calcules par
// prefetch-13f.py).
// ============================================================
async function handleQuarterActivity(env, origin) {
  try {
    const funds = await env.CACHE.get('13f-all-funds', 'json');
    if (!funds || !Array.isArray(funds)) {
      return jsonResponse({ error: 'No 13F data available' }, 503, origin);
    }

    const tickerByName = new Map();
    try {
      const tx = await env.CACHE.get('insider-transactions', 'json');
      if (tx && Array.isArray(tx.transactions)) {
        for (const t of tx.transactions) {
          const tk = (t.ticker || '').trim().toUpperCase();
          const cn = normalizeForMatch(t.company);
          if (tk && cn && !tickerByName.has(cn)) tickerByName.set(cn, tk);
        }
      }
    } catch (_) {}

    const newPositions = [];
    const soldPositions = [];
    const increased = [];   // sharesChange >= +20%
    const decreased = [];   // sharesChange <= -20%

    for (const fund of funds) {
      if (!Array.isArray(fund.topHoldings)) continue;
      const fundMeta = {
        fundName: fund.fundName,
        label: fund.label || null,
        category: fund.category || null,
        cik: fund.cik,
        reportDate: fund.reportDate || null,
        prevReportDate: fund.prevReportDate || null,
      };

      for (const h of fund.topHoldings) {
        if (!h.name) continue;
        const key = normalizeForMatch(h.name);
        const entry = {
          ...fundMeta,
          name: h.name,
          ticker: tickerByName.get(key) || null,
          cusip: h.cusip || null,
          shares: Number(h.shares) || 0,
          value: Number(h.value) || 0,
          pct: Number(h.pct) || 0,
          sharesChange: h.sharesChange != null ? Number(h.sharesChange) : null,
          status: h.status || null,
        };

        if (h.status === 'new') {
          newPositions.push(entry);
        } else if (h.status === 'sold' || h.status === 'closed') {
          soldPositions.push(entry);
        } else if (h.sharesChange != null && h.sharesChange >= 20) {
          increased.push(entry);
        } else if (h.sharesChange != null && h.sharesChange <= -20) {
          decreased.push(entry);
        }
      }
    }

    // Tri : par valeur descendante (les plus gros mouvements en haut)
    newPositions.sort((a, b) => b.value - a.value);
    soldPositions.sort((a, b) => b.value - a.value);
    increased.sort((a, b) => b.value - a.value);
    decreased.sort((a, b) => b.value - a.value);

    return jsonResponse({
      updatedAt: new Date().toISOString(),
      summary: {
        newCount: newPositions.length,
        soldCount: soldPositions.length,
        increasedCount: increased.length,
        decreasedCount: decreased.length,
      },
      newPositions: newPositions.slice(0, 50),
      soldPositions: soldPositions.slice(0, 50),
      increased: increased.slice(0, 50),
      decreased: decreased.slice(0, 50),
    }, 200, origin);
  } catch (e) {
    return jsonResponse({ error: 'Activity computation failed', detail: String(e && e.message || e) }, 500, origin);
  }
}

// Normalisation pour matcher des noms (suppression suffixes corp/inc/sa, espaces, casse)
function normalizeForMatch(s) {
  if (!s) return '';
  return String(s)
    .toUpperCase()
    .replace(/[.,'"`]/g, '')
    .replace(/\s+(INC|CORP|CORPORATION|COMPANY|CO|LTD|LIMITED|SA|SE|AG|NV|PLC|HOLDINGS?|GROUP|TRUST|LP|LLC)$/gi, '')
    .replace(/\s+CL\s*[A-Z]$/i, '')   // "Class A" suffix
    .replace(/\s+/g, ' ')
    .trim();
}

// ============================================================
// SITEMAP XML dynamique (SEO - listes les analyses publiques)
// ============================================================
async function handleSitemap(env) {
  try {
    const today = new Date().toISOString().slice(0, 10);

    // Recupere la liste des tickers depuis le cache KV
    let tickers = [];
    try {
      const cached = await env.CACHE.get('public-tickers-list', 'json');
      if (cached && Array.isArray(cached.tickers)) {
        tickers = cached.tickers;
      } else {
        // Reconstruit a la volee si le cache est vide
        const tx = await env.CACHE.get('insider-transactions', 'json');
        const set = new Map();
        if (tx && Array.isArray(tx.transactions)) {
          for (const t of tx.transactions) {
            const tk = (t.ticker || '').trim().toUpperCase();
            if (!tk || !/^[A-Z0-9.\-]{1,6}$/.test(tk)) continue;
            if (!set.has(tk)) set.set(tk, { ticker: tk });
          }
        }
        tickers = Array.from(set.values());
      }
    } catch (_) { tickers = []; }

    // Limite raisonnable pour Googlebot
    tickers = tickers.slice(0, 1000);

    // URL de base branded (worker monte sur kairosinsider.fr via routes)
    const SITE = 'https://kairosinsider.fr';

    const urls = [];
    // Pages principales (home + liste tickers visible dans action.html)
    urls.push(`<url><loc>${SITE}/</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>`);

    // Une URL SSR par ticker (pre-rendu par le Worker = indexable sans JS)
    for (const t of tickers) {
      const tk = encodeURIComponent(t.ticker);
      urls.push(`<url><loc>${SITE}/a/${tk}</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>`);
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`;

    return new Response(xml, {
      status: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`, {
      status: 200,
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    });
  }
}

// ============================================================
// SSR : HTML complet pre-rendu pour bots sociaux + SEO
// Endpoint : GET /a/:ticker
// Googlebot rend le JS mais c'est 2e vague ; Facebook/Twitter/LinkedIn/
// ChatGPT/Slack ne rendent PAS le JS. Ce endpoint retourne du HTML deja
// rempli -> previews sociaux nickel + indexation Google en 1ere vague.
// ============================================================
function escHtmlSsr(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function fmtCurrSsr(n, cur) {
  if (n == null) return '—';
  try { return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: cur || 'USD', maximumFractionDigits: 2 }).format(n); }
  catch { return String(n); }
}
function fmtPctSsr(n) {
  if (n == null) return '—';
  return (n > 0 ? '+' : '') + Number(n).toFixed(2) + '%';
}
function fmtIntSsr(n) {
  if (n == null) return '—';
  try { return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(n); }
  catch { return String(n); }
}
function signalFromScoreSsr(total) {
  if (total >= 75) return { label: 'ACHAT FORT', color: '#10B981' };
  if (total >= 60) return { label: 'ACHAT', color: '#34D399' };
  if (total >= 40) return { label: 'NEUTRE', color: '#9CA3AF' };
  if (total >= 25) return { label: 'VENTE', color: '#F87171' };
  return { label: 'VENTE FORTE', color: '#EF4444' };
}

async function handleActionSSR(rawTicker, env) {
  const ticker = String(rawTicker || '').toUpperCase().trim().replace(/[^A-Z0-9.\-]/g, '');
  if (!ticker || ticker.length > 12) {
    return new Response('Invalid ticker', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  let data;
  try {
    data = await handleStockAnalysis(ticker, env, { publicView: true });
  } catch (e) {
    data = { error: 'Failed to load', detail: String(e && e.message || e) };
  }

  // Page d'erreur SSR (reste indexable)
  if (!data || data.error) {
    const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Ticker introuvable — Kairos Insider</title><meta name="robots" content="noindex,follow"><style>body{font-family:system-ui;background:#0A0F1E;color:#F9FAFB;text-align:center;padding:80px 20px}a{color:#3B82F6}</style></head><body><h1>Ticker ${escHtmlSsr(ticker)} introuvable</h1><p>Cette action n'est pas couverte par Kairos Insider.</p><p><a href="https://kairosinsider.fr/dashboard.html">Retour au dashboard</a></p></body></html>`;
    return new Response(html, {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
    });
  }

  const name = data.company?.name || ticker;
  const sector = data.company?.sector || '';
  const score = data.score?.total || 0;
  const sig = signalFromScoreSsr(score);
  const price = data.price?.current;
  const currency = data.price?.currency || 'USD';
  const changePct = data.price?.changePct;
  const changeYtd = data.price?.changeYtdPct;
  const change1y = data.price?.change1yPct;

  const totalInsiderTx = data.insiders?._totalTransactions ?? (data.insiders?.transactions?.length ?? 0);
  const insiderBuyCount = (data.insiders?.transactions || []).filter(t => (t.adType === 'A' || t.type === 'P')).length;
  const totalFunds = data.smartMoney?._totalFunds ?? (data.smartMoney?.topFunds?.length ?? 0);
  const totalNews = data._totalNews ?? (data.news?.length ?? 0);
  const trends = data.googleTrends;

  const marketCap = data.fundamentals?.marketCap;
  const pe = data.fundamentals?.peRatio;
  const dividendYield = data.fundamentals?.dividendYield;

  const title = `${name} (${ticker}) — Kairos Score ${score}/100 · ${sig.label} | Kairos Insider`;
  const desc = `Analyse smart money de ${name} (${ticker})${sector ? ' — ' + sector : ''}. Kairos Score : ${score}/100 (${sig.label}). ${totalInsiderTx} transactions insiders, ${totalFunds} hedge funds 13F. Cours : ${fmtCurrSsr(price, currency)}.`;
  // URL du dashboard (pour les CTA "Voir l'analyse complete")
  const dashboardUrl = `https://kairosinsider.fr/action.html?ticker=${encodeURIComponent(ticker)}`;
  // Canonical = URL brande (Worker route sur kairosinsider.fr/a/*)
  const canonical = `https://kairosinsider.fr/a/${encodeURIComponent(ticker)}`;

  // Schema.org JSON-LD
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: `${name} (${ticker}) — Analyse Kairos Insider`,
    description: desc,
    datePublished: data.updatedAt || new Date().toISOString(),
    dateModified: data.updatedAt || new Date().toISOString(),
    image: 'https://kairosinsider.fr/assets/logo.png',
    url: canonical,
    author: { '@type': 'Organization', name: 'Kairos Insider', url: 'https://kairosinsider.fr' },
    publisher: {
      '@type': 'Organization',
      name: 'Kairos Insider',
      url: 'https://kairosinsider.fr',
      logo: { '@type': 'ImageObject', url: 'https://kairosinsider.fr/assets/logo.png' },
    },
    about: {
      '@type': 'Corporation',
      name: name,
      tickerSymbol: ticker,
      ...(data.company?.exchange && { exchange: data.company.exchange }),
      ...(data.company?.website && { url: data.company.website }),
      ...(data.company?.industry && { industry: data.company.industry }),
    },
    aggregateRating: {
      '@type': 'AggregateRating',
      ratingValue: (score / 20).toFixed(1),
      bestRating: '5',
      worstRating: '0',
      ratingCount: '1',
      reviewAspect: 'Kairos Score composite smart money',
    },
  };

  const insiderTeaser = (data.insiders?.transactions || []).slice(0, 3).map(t => {
    const action = (t.type === 'P' || t.adType === 'A') ? 'Achat' : 'Vente';
    const who = escHtmlSsr(t.insider || 'Dirigeant');
    return `<li>${who} — <strong>${action}</strong>${t.date ? ' · ' + escHtmlSsr(t.date) : ''}</li>`;
  }).join('');

  const fundsTeaser = (data.smartMoney?.topFunds || []).slice(0, 5).map(f => {
    return `<li>${escHtmlSsr(f.fundName || f.cik || 'Fonds 13F')}</li>`;
  }).join('');

  const newsTeaser = (data.news || []).slice(0, 3).map(n => {
    return `<li><strong>${escHtmlSsr(n.title || '')}</strong>${n.source ? ' <span style="opacity:0.6">· ' + escHtmlSsr(n.source) + '</span>' : ''}</li>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlSsr(title)}</title>
<meta name="description" content="${escHtmlSsr(desc)}">
<meta name="robots" content="index,follow">
<meta name="theme-color" content="#0A0F1E">
<link rel="canonical" href="${canonical}">
<link rel="icon" type="image/png" href="https://kairosinsider.fr/assets/logo.png">

<meta property="og:type" content="article">
<meta property="og:locale" content="fr_FR">
<meta property="og:site_name" content="Kairos Insider">
<meta property="og:title" content="${escHtmlSsr(title)}">
<meta property="og:description" content="${escHtmlSsr(desc)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="https://kairosinsider.fr/assets/logo.png">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escHtmlSsr(title)}">
<meta name="twitter:description" content="${escHtmlSsr(desc)}">
<meta name="twitter:image" content="https://kairosinsider.fr/assets/logo.png">

<!-- Google Analytics 4 (RGPD-friendly) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-7YPCWL035M"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-7YPCWL035M', { anonymize_ip: true, allow_google_signals: false, allow_ad_personalization_signals: false });
  gtag('event', 'ssr_ticker_viewed', { event_category: 'seo_ssr', event_label: ${JSON.stringify(ticker)} });
</script>

<script type="application/ld+json">${JSON.stringify(schema)}</script>

<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;background:#0A0F1E;color:#F9FAFB;line-height:1.6;min-height:100vh;-webkit-font-smoothing:antialiased}
.container{max-width:880px;margin:0 auto;padding:40px 24px}
.nav{display:flex;justify-content:space-between;align-items:center;margin-bottom:40px}
.logo{font-weight:700;font-size:20px;background:linear-gradient(135deg,#F9FAFB,#9CA3AF);-webkit-background-clip:text;color:transparent}
.cta{padding:10px 20px;background:linear-gradient(135deg,#3B82F6,#8B5CF6);border-radius:8px;color:#fff;text-decoration:none;font-weight:600;font-size:14px}
.ticker-header{display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:20px;padding:32px;background:linear-gradient(135deg,rgba(59,130,246,0.1),rgba(139,92,246,0.05));border:1px solid rgba(255,255,255,0.08);border-radius:16px;margin-bottom:24px}
.ticker-symbol{font-size:42px;font-weight:700;letter-spacing:-1px}
.ticker-name{font-size:18px;color:#9CA3AF;margin-top:4px}
.badges{margin-top:12px;display:flex;gap:8px;flex-wrap:wrap}
.badge{font-size:12px;padding:4px 10px;background:rgba(255,255,255,0.06);border-radius:6px;color:#9CA3AF}
.price-box{text-align:right}
.price{font-size:32px;font-weight:600}
.change-up{color:#10B981}.change-down{color:#EF4444}
.score-card{display:flex;gap:24px;align-items:center;flex-wrap:wrap;padding:32px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.08);border-radius:16px;margin-bottom:24px}
.score-gauge{width:140px;height:140px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:36px;font-weight:700;flex-shrink:0}
.score-info h1{font-size:26px;margin-bottom:10px}
.signal{display:inline-block;padding:6px 14px;border-radius:20px;font-size:13px;font-weight:600;margin-bottom:10px}
.section{padding:24px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.08);border-radius:14px;margin-bottom:20px}
.section h2{font-size:18px;margin-bottom:12px}
.section p{color:#9CA3AF;font-size:14px}
.section ul{list-style:none;margin-top:12px}
.section li{padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:14px;color:#D1D5DB}
.info-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-top:16px}
.info-item{padding:12px;background:rgba(255,255,255,0.03);border-radius:8px}
.info-label{font-size:11px;color:#6B7280;text-transform:uppercase;letter-spacing:0.5px}
.info-value{font-size:15px;font-weight:600;margin-top:4px}
.paywall{padding:32px;background:linear-gradient(135deg,rgba(59,130,246,0.15),rgba(139,92,246,0.1));border:1px solid rgba(59,130,246,0.3);border-radius:16px;text-align:center;margin-top:32px}
.paywall h2{font-size:22px;margin-bottom:12px}
.paywall p{color:#D1D5DB;margin-bottom:20px}
.paywall .cta{display:inline-block;padding:14px 28px;font-size:15px}
.features{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;margin:24px 0;text-align:left}
.feature{padding:10px 14px;background:rgba(255,255,255,0.04);border-radius:8px;font-size:13px;color:#D1D5DB}
footer{margin-top:60px;padding-top:30px;border-top:1px solid rgba(255,255,255,0.05);font-size:12px;color:#6B7280;text-align:center}
footer a{color:#9CA3AF;text-decoration:none}
</style>
</head>
<body>
<div class="container">
  <nav class="nav">
    <a href="https://kairosinsider.fr/" class="logo">Kairos Insider</a>
    <a href="https://kairosinsider.fr/dashboard.html" class="cta">Ouvrir l'analyse complète →</a>
  </nav>

  <div class="ticker-header">
    <div>
      <div class="ticker-symbol">${escHtmlSsr(ticker)}</div>
      <div class="ticker-name">${escHtmlSsr(name)}</div>
      <div class="badges">
        ${data.company?.exchange ? `<span class="badge">${escHtmlSsr(data.company.exchange)}</span>` : ''}
        ${sector ? `<span class="badge">${escHtmlSsr(sector)}</span>` : ''}
        ${data.company?.country ? `<span class="badge">${escHtmlSsr(data.company.country)}</span>` : ''}
      </div>
    </div>
    <div class="price-box">
      <div class="price">${fmtCurrSsr(price, currency)}</div>
      ${changePct != null ? `<div class="${changePct >= 0 ? 'change-up' : 'change-down'}" style="margin-top:4px">${fmtPctSsr(changePct)} sur la séance</div>` : ''}
      ${changeYtd != null ? `<div style="font-size:12px;color:#6B7280;margin-top:6px">${fmtPctSsr(changeYtd)} depuis le 1er janvier · ${fmtPctSsr(change1y)} sur 1 an</div>` : ''}
    </div>
  </div>

  <div class="score-card">
    <div class="score-gauge" style="background:conic-gradient(${sig.color} ${score * 3.6}deg, rgba(255,255,255,0.08) 0deg);position:relative">
      <div style="position:absolute;inset:8px;background:#0A0F1E;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-direction:column">
        <div style="color:${sig.color}">${score}</div>
        <div style="font-size:11px;color:#9CA3AF;font-weight:400">/100</div>
      </div>
    </div>
    <div class="score-info">
      <h1>Kairos Score : ${score}/100</h1>
      <div class="signal" style="background:${sig.color}22;color:${sig.color};border:1px solid ${sig.color}44">${sig.label}</div>
      <p>Score composite qui agrège 8 dimensions du smart money : insiders (SEC/AMF/BaFin), hedge funds 13F, politiciens et gourous (NANC/GURU), momentum, valorisation, consensus analystes, santé financière et earnings.</p>
    </div>
  </div>

  ${data.company?.description ? `
    <div class="section">
      <h2>À propos de ${escHtmlSsr(name)}</h2>
      <p>${escHtmlSsr(data.company.description)}</p>
    </div>
  ` : ''}

  <div class="section">
    <h2>Informations clés</h2>
    <div class="info-grid">
      ${data.company?.ceo ? `<div class="info-item"><div class="info-label">PDG</div><div class="info-value">${escHtmlSsr(data.company.ceo)}</div></div>` : ''}
      ${data.company?.founded ? `<div class="info-item"><div class="info-label">Fondée en</div><div class="info-value">${escHtmlSsr(data.company.founded)}</div></div>` : ''}
      ${data.company?.headquarters ? `<div class="info-item"><div class="info-label">Siège</div><div class="info-value">${escHtmlSsr(data.company.headquarters)}</div></div>` : ''}
      ${data.company?.employees ? `<div class="info-item"><div class="info-label">Employés</div><div class="info-value">${fmtIntSsr(data.company.employees)}</div></div>` : ''}
      ${marketCap ? `<div class="info-item"><div class="info-label">Capitalisation</div><div class="info-value">${fmtCurrSsr(marketCap, currency)}</div></div>` : ''}
      ${pe ? `<div class="info-item"><div class="info-label">PER</div><div class="info-value">${typeof pe === 'number' ? pe.toFixed(1) : escHtmlSsr(pe)}</div></div>` : ''}
      ${dividendYield ? `<div class="info-item"><div class="info-label">Rendement div.</div><div class="info-value">${typeof dividendYield === 'number' ? dividendYield.toFixed(2) + '%' : escHtmlSsr(dividendYield)}</div></div>` : ''}
      ${data.company?.ipoDate ? `<div class="info-item"><div class="info-label">IPO</div><div class="info-value">${escHtmlSsr(data.company.ipoDate)}</div></div>` : ''}
    </div>
  </div>

  <div class="section">
    <h2>🕴️ Activité des initiés (90 jours)</h2>
    <p><strong>${totalInsiderTx}</strong> transactions — dont <strong>${insiderBuyCount}</strong> achats déclarés par les dirigeants de ${escHtmlSsr(name)} auprès de la SEC / AMF / BaFin.</p>
    ${insiderTeaser ? `<ul>${insiderTeaser}</ul>` : ''}
  </div>

  <div class="section">
    <h2>🏦 Hedge funds (13F)</h2>
    <p><strong>${totalFunds}</strong> fonds institutionnels déclarent une position sur ${escHtmlSsr(ticker)} dans leur dernier dépôt 13F SEC.</p>
    ${fundsTeaser ? `<ul>${fundsTeaser}</ul>` : ''}
  </div>

  ${totalNews > 0 ? `
    <div class="section">
      <h2>📰 Actualités récentes</h2>
      <p><strong>${totalNews}</strong> articles récents sur ${escHtmlSsr(ticker)}.</p>
      ${newsTeaser ? `<ul>${newsTeaser}</ul>` : ''}
    </div>
  ` : ''}

  ${trends && trends.interestMax >= 8 ? `
    <div class="section">
      <h2>🔎 Intérêt de recherche Google</h2>
      <p>
        <strong>${trends.interestNow}/100</strong> — intérêt actuel
        ${trends.interestNow >= 8 ? (
          trends.spike7d > 5 ? ` · <span style="color:#10B981">+${trends.spike7d}% vs semaine dernière 📈</span>` :
          trends.spike7d < -5 ? ` · <span style="color:#EF4444">${trends.spike7d}% vs semaine dernière 📉</span>` :
          ` · stable`
        ) : ''}
        ${trends.interestNow >= 8 ? ` · Tendance : <strong>${trends.trend === 'rising' ? '↗️ en hausse' : trends.trend === 'falling' ? '↘️ en baisse' : '→ stable'}</strong>` : ''}
      </p>
      <p style="font-size:12px;color:#6B7280;margin-top:8px">
        Volume de recherche Google pour "${escHtmlSsr(ticker)}" sur 90 jours (échelle 0-100, 100 = pic de la période).
        Moyenne 90j : ${trends.interestMean}/100, pic max : ${trends.interestMax}/100.
      </p>
    </div>
  ` : ''}

  <div class="paywall">
    <h2>🔓 Débloquez l'analyse complète</h2>
    <p>Cette page publique ne montre qu'un extrait. L'analyse complète de <strong>${escHtmlSsr(ticker)}</strong> sur le dashboard Kairos Insider inclut :</p>
    <div class="features">
      <div class="feature">✅ Historique complet des ${totalInsiderTx} transactions insiders</div>
      <div class="feature">✅ Tous les ${totalFunds} hedge funds 13F détaillés</div>
      <div class="feature">✅ Positions NANC, GOP et GURU</div>
      <div class="feature">✅ Fondamentaux (P/E, PEG, EV/EBITDA, ROE…)</div>
      <div class="feature">✅ Santé financière (Altman Z, Piotroski F)</div>
      <div class="feature">✅ Earnings 6 trimestres + prochaine date</div>
      <div class="feature">✅ Concurrents sectoriels (peers)</div>
      <div class="feature">✅ Breakdown du Kairos Score (8 dimensions)</div>
    </div>
    <a href="${dashboardUrl}" class="cta">Voir l'analyse complète →</a>
    <p style="margin-top:14px;font-size:12px;color:#6B7280">Inscription gratuite · Premium 29€/mois sans engagement</p>
  </div>

  <footer>
    <p><a href="https://kairosinsider.fr/">kairosinsider.fr</a> · La plateforme francophone du smart money</p>
    <p style="margin-top:6px">Données SEC EDGAR, AMF, BaFin, Yahoo Finance — mises à jour quotidiennement</p>
  </footer>
</div>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=900, s-maxage=1800',
      'X-Robots-Tag': 'index, follow',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// ============================================================
// ROBOTS.TXT (SEO)
// ============================================================
async function handleRobotsTxt(env) {
  const body = [
    '# robots.txt - Kairos Insider',
    '# Servi par Cloudflare Worker (route kairosinsider.fr/robots.txt)',
    '',
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    'Disallow: /stripe/',
    'Disallow: /dashboard.html',
    'Disallow: /merci.html',
    '',
    '# Bots IA explicitement autorises (on veut apparaitre dans leurs reponses)',
    'User-agent: GPTBot',
    'Allow: /',
    '',
    'User-agent: ClaudeBot',
    'Allow: /',
    '',
    'User-agent: CCBot',
    'Allow: /',
    '',
    'User-agent: PerplexityBot',
    'Allow: /',
    '',
    'User-agent: Google-Extended',
    'Allow: /',
    '',
    'User-agent: Applebot-Extended',
    'Allow: /',
    '',
    'Sitemap: https://kairosinsider.fr/sitemap.xml',
    '',
  ].join('\n');
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// ============================================================
// STRIPE : Création de Checkout Session
// ============================================================
async function handleCreateCheckout(request, env, user, origin) {
  try {
    const body = await request.json();

    const params = new URLSearchParams({
      'payment_method_types[]': 'card',
      'mode': 'subscription',
      'client_reference_id': user.uid,
      'customer_email': user.email,
      'line_items[0][price]': env.STRIPE_PRICE_ID,
      'line_items[0][quantity]': '1',
      'success_url': body.successUrl || `${env.ALLOWED_ORIGIN}/merci.html?session_id={CHECKOUT_SESSION_ID}`,
      'cancel_url': body.cancelUrl || `${env.ALLOWED_ORIGIN}/dashboard.html?checkout=cancelled`,
      'subscription_data[metadata][firebase_uid]': user.uid,
    });

    const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });

    const session = await resp.json();
    if (!resp.ok) {
      console.error('Stripe checkout error:', session);
      return jsonResponse({ error: 'Checkout creation failed' }, 500, origin);
    }

    return jsonResponse({ sessionId: session.id }, 200, origin);
  } catch (err) {
    console.error('handleCreateCheckout error:', err);
    return jsonResponse({ error: 'Internal error' }, 500, origin);
  }
}

// ============================================================
// STRIPE : Webhook (events de subscription)
// ============================================================
async function handleStripeWebhook(request, env) {
  try {
    const body = await request.text();
    // Note: Pour le MVP on ne vérifie pas la signature du webhook
    // En production, il faudrait vérifier avec STRIPE_WEBHOOK_SECRET
    const event = JSON.parse(body);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const uid = session.client_reference_id || session.subscription_data?.metadata?.firebase_uid;
      if (uid && session.subscription) {
        // Récupérer les détails de la subscription
        const subResp = await fetch(`https://api.stripe.com/v1/subscriptions/${session.subscription}`, {
          headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
        });
        const sub = await subResp.json();

        await env.CACHE.put(`sub:${uid}`, JSON.stringify({
          status: sub.status,
          subscriptionId: sub.id,
          customerId: sub.customer,
          currentPeriodEnd: sub.current_period_end,
          priceId: env.STRIPE_PRICE_ID,
        }));
        console.log(`Subscription created for uid: ${uid}, status: ${sub.status}`);

        // Email de bienvenue Premium via Brevo (one-shot, best-effort)
        const recipientEmail = session.customer_details?.email || session.customer_email;
        if (recipientEmail) {
          sendPremiumWelcomeEmail(recipientEmail, env).catch(e =>
            console.error('Welcome email failed:', e)
          );
        }
      }
    }

    if (event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      const uid = sub.metadata?.firebase_uid;
      if (uid) {
        await env.CACHE.put(`sub:${uid}`, JSON.stringify({
          status: sub.status,
          subscriptionId: sub.id,
          customerId: sub.customer,
          currentPeriodEnd: sub.current_period_end,
          priceId: env.STRIPE_PRICE_ID,
        }));
        console.log(`Subscription updated for uid: ${uid}, status: ${sub.status}`);
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const uid = sub.metadata?.firebase_uid;
      if (uid) {
        await env.CACHE.put(`sub:${uid}`, JSON.stringify({
          status: 'canceled',
          subscriptionId: sub.id,
          customerId: sub.customer,
          currentPeriodEnd: sub.current_period_end,
        }));
        console.log(`Subscription canceled for uid: ${uid}`);
      }
    }

    return new Response(JSON.stringify({ received: true }), { status: 200 });
  } catch (err) {
    console.error('Stripe webhook error:', err);
    return new Response(JSON.stringify({ error: 'Webhook error' }), { status: 400 });
  }
}

// ============================================================
// STRIPE : Statut d'abonnement
// ============================================================
async function handleSubscriptionStatus(env, user, origin) {
  const subData = await env.CACHE.get(`sub:${user.uid}`, 'json');

  return jsonResponse({
    uid: user.uid,
    email: user.email,
    hasSubscription: subData && (subData.status === 'active' || subData.status === 'past_due'),
    subscriptionStatus: subData?.status || null,
    currentPeriodEnd: subData?.currentPeriodEnd || null,
  }, 200, origin);
}

// ============================================================
// STRIPE : Portail client (gérer l'abonnement)
// ============================================================
async function handleCustomerPortal(request, env, user, origin) {
  try {
    const subData = await env.CACHE.get(`sub:${user.uid}`, 'json');
    if (!subData?.customerId) {
      return jsonResponse({ error: 'No subscription found' }, 404, origin);
    }

    const params = new URLSearchParams({
      'customer': subData.customerId,
      'return_url': `${env.ALLOWED_ORIGIN}/dashboard.html`,
    });

    const resp = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });

    const session = await resp.json();
    if (!resp.ok) {
      return jsonResponse({ error: 'Portal creation failed' }, 500, origin);
    }

    return jsonResponse({ url: session.url }, 200, origin);
  } catch (err) {
    return jsonResponse({ error: 'Internal error' }, 500, origin);
  }
}

// ============================================================
// BREVO : Email de bienvenue (route publique)
// ============================================================
// ============================================================
// BREVO : Email de bienvenue Premium (apres checkout Stripe)
// Envoye en inline HTML pour ne pas dependre d'un template Brevo
//
// [SYNC:FEATURES] La liste de features ci-dessous est aussi dans:
// - merci.html (page de confirmation post-paiement)
// - index.html (section #features de la landing)
// -> quand on ajoute/modifie une feature premium, mettre a jour les 3 endroits
// ============================================================
async function sendPremiumWelcomeEmail(email, env) {
  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; background:#0A0F1E; margin:0; padding:0; color:#F9FAFB; }
.wrap { max-width:580px; margin:0 auto; padding:32px 20px; }
.card { background:#111827; border:1px solid rgba(255,255,255,0.08); border-radius:16px; padding:40px 32px; }
.logo { font-family:'Space Grotesk', Arial, sans-serif; font-size:22px; font-weight:700; background:linear-gradient(135deg,#3B82F6 0%,#8B5CF6 100%); -webkit-background-clip:text; color:transparent; margin-bottom:24px; }
h1 { font-size:28px; margin:0 0 16px; color:#F9FAFB; line-height:1.2; font-weight:700; }
p { font-size:15px; line-height:1.6; color:#9CA3AF; margin:0 0 16px; }
.btn { display:inline-block; background:linear-gradient(135deg,#3B82F6 0%,#8B5CF6 100%); color:#fff !important; padding:14px 28px; border-radius:10px; text-decoration:none; font-weight:600; font-size:15px; margin:16px 0; }
.features { background:rgba(59,130,246,0.05); border:1px solid rgba(59,130,246,0.15); border-radius:12px; padding:20px; margin:24px 0; }
.features li { margin:8px 0; color:#9CA3AF; font-size:14px; }
.footer { text-align:center; color:#6B7280; font-size:12px; margin-top:32px; padding-top:24px; border-top:1px solid rgba(255,255,255,0.05); }
.footer a { color:#6B7280; text-decoration:none; margin:0 8px; }
</style></head>
<body><div class="wrap"><div class="card">
<div class="logo">Kairos Insider</div>
<h1>Bienvenue dans Kairos Insider Premium 🎉</h1>
<p>Votre abonnement est actif. Vous avez maintenant acces a l'ensemble du Smart Money Dashboard :</p>
<div class="features"><ul>
  <li>✓ Transactions d'inities US (SEC Form 4) &amp; Europe (BaFin MAR art.19) en quasi-temps reel</li>
  <li>✓ Signaux de clusters d'insiders sur 90 jours</li>
  <li>✓ Portefeuilles 13F des plus grands hedge funds</li>
  <li>✓ Suivi des ETF Smart Money (NANC, GOP, GURU)</li>
  <li>✓ Import multi-plateforme de votre portefeuille personnel</li>
</ul></div>
<p style="text-align:center"><a href="https://kairosinsider.fr/dashboard.html" class="btn">Acceder au Dashboard →</a></p>
<p>Votre facture est disponible dans votre portail Stripe, et vous pouvez annuler votre abonnement a tout moment. Une question ? Repondez simplement a cet email.</p>
<p>Bonnes analyses,<br/><strong style="color:#F9FAFB">L'equipe Kairos Insider</strong></p>
<div class="footer">
  <p style="margin:0">Kairos Insider — Voyez ce que les pros voient.</p>
  <p style="margin:8px 0 0"><a href="https://kairosinsider.fr/cgv.html">CGV</a>·<a href="https://kairosinsider.fr/privacy.html">Confidentialite</a>·<a href="https://kairosinsider.fr/legal.html">Mentions legales</a></p>
</div>
</div></div></body></html>`;

  const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': env.BREVO_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      sender: { name: env.BREVO_SENDER_NAME || 'Kairos Insider', email: env.BREVO_SENDER_EMAIL || 'contact@kairosinsider.fr' },
      to: [{ email }],
      subject: 'Bienvenue dans Kairos Insider Premium 🎉',
      htmlContent: html,
      replyTo: { email: env.BREVO_SENDER_EMAIL || 'contact@kairosinsider.fr', name: 'Kairos Insider' },
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Brevo ${resp.status}: ${errText}`);
  }
  console.log(`Welcome email sent to ${email}`);
}

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
      console.error('Brevo error:', brevoResponse.status);
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
// ETF : ARK API proxy
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
    const prevKey = `ark-prev:${symbol}`;
    const prevData = await env.CACHE.get(prevKey, 'json') || {};
    const prevMap = {};
    if (prevData.holdings) {
      for (const h of prevData.holdings) prevMap[h.ticker] = { weight: h.weight, shares: h.shares };
    }

    const holdings = (data.holdings || []).map(h => {
      const ticker = h.ticker || '';
      const weight = h.weight || 0;
      const shares = h.shares || 0;
      let sharesChange = null, status = 'unchanged';
      const prev = prevMap[ticker];
      if (prev) {
        if (prev.shares > 0) sharesChange = Math.round(((shares - prev.shares) / prev.shares) * 1000) / 10;
        if (sharesChange !== null && sharesChange > 0.5) status = 'increased';
        else if (sharesChange !== null && sharesChange < -0.5) status = 'decreased';
      } else if (Object.keys(prevMap).length > 0) {
        status = 'new';
      }
      return { ticker, company: h.company || '', shares, value: h.market_value || 0, price: h.share_price || 0, weight, rank: h.weight_rank || 0, sharesChange, status };
    });

    const result = { symbol, date: data.date_from || today, prevDate: prevData.date || null, label: 'Cathie Wood', category: 'Innovation', holdingsCount: holdings.length, totalValue: holdings.reduce((s, h) => s + h.value, 0), holdings };

    await env.CACHE.put(prevKey, JSON.stringify({ date: result.date, holdings: holdings.map(h => ({ ticker: h.ticker, weight: h.weight, shares: h.shares })) }), { expirationTtl: 172800 });
    await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 14400 });
    return jsonResponse(result, 200, origin);
  } catch (err) {
    console.error('handleEtfArk error:', err);
    return jsonResponse({ error: 'Failed to fetch ARK data' }, 500, origin);
  }
}

// ============================================================
// ETF : Congress (NANC/GOP) proxy
// ============================================================
async function handleEtfCongress(url, env, origin) {
  const symbol = (url.searchParams.get('symbol') || 'NANC').toUpperCase();
  if (symbol !== 'NANC' && symbol !== 'GOP') {
    return jsonResponse({ error: 'Invalid symbol' }, 400, origin);
  }
  // Serve from KV (pre-fetched by GitHub Action)
  const data = await env.CACHE.get(`etf-${symbol.toLowerCase()}`, 'json');
  if (!data) return jsonResponse({ error: 'Data not loaded' }, 503, origin);
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
    !origin
  );
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Dashboard-Key',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}
