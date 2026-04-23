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

// ============================================================
// STRUCTURED LOGGING (Priorité 3.3)
// ============================================================
// Schéma JSON unifié pour tous les logs. Cloudflare ingère les console.log
// tels quels ; en JSON ils deviennent facilement parsable par Logpush →
// R2/BigQuery/Datadog sans refonte ultérieure.
//
// Usage :
//   log.info('cron.watchlist.start', { uidCount: 42 });
//   log.warn('stripe.signature.invalid', { ip });
//   log.error('ga4.token.failed', { detail: err.message });
//
// Format émis : {"lvl":"info","evt":"cron.watchlist.start","ts":"2026-04-21T…","uidCount":42}
const log = {
  _emit(level, event, context) {
    const entry = { lvl: level, evt: event, ts: new Date().toISOString() };
    if (context && typeof context === 'object') {
      // Serialise les Error en {message, stack}
      for (const [k, v] of Object.entries(context)) {
        if (v instanceof Error) entry[k] = { message: v.message, stack: (v.stack || '').split('\n').slice(0, 4).join('\n') };
        else entry[k] = v;
      }
    }
    const line = JSON.stringify(entry);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  },
  info(event, context) { this._emit('info', event, context); },
  warn(event, context) { this._emit('warn', event, context); },
  error(event, context) { this._emit('error', event, context); },
};

// ============================================================
// ERROR TRACKING — Sentry-like minimaliste stocké dans KV
// ============================================================
// Format KV :
//   err:list → JSON array des 100 dernières erreurs (rotation FIFO)
//   err:count:{YYYY-MM-DD} → compteur par jour (incrémenté atomiquement)
// Chaque entrée : { ts, iso, path, method, user, level, message, stack, ctx }
const ERROR_LOG_MAX = 100;

async function logError(env, err, context = {}) {
  try {
    const now = Date.now();
    const entry = {
      ts: now,
      iso: new Date(now).toISOString(),
      message: err?.message || String(err),
      stack: (err?.stack || '').split('\n').slice(0, 6).join('\n'), // 6 lignes max
      level: context.level || 'error',
      path: context.path || '',
      method: context.method || '',
      user: context.user || '',
      ctx: context.extra || null,
    };
    // Lit la liste actuelle, ajoute en tête, trim à ERROR_LOG_MAX
    let list = await env.CACHE.get('err:list', 'json').catch(() => []);
    if (!Array.isArray(list)) list = [];
    list.unshift(entry);
    list = list.slice(0, ERROR_LOG_MAX);
    await env.CACHE.put('err:list', JSON.stringify(list), { expirationTtl: 30 * 86400 });

    // Compteur quotidien pour le dashboard
    const day = entry.iso.slice(0, 10);
    const countKey = `err:count:${day}`;
    const current = parseInt(await env.CACHE.get(countKey) || '0', 10);
    await env.CACHE.put(countKey, String(current + 1), { expirationTtl: 90 * 86400 });
  } catch (e) {
    // Si le log échoue, on ne peut rien faire — on écrit dans la console standard
    console.error('[logError] failed:', e, 'original error:', err);
  }
}

// Wrapper pour handlers async : catch + log + rethrow (ou return erreur)
function wrapHandler(handler, name) {
  return async function(request, env, ...args) {
    try {
      return await handler(request, env, ...args);
    } catch (err) {
      // Extract contexte de la requête si dispo
      const url = request && request.url ? new URL(request.url) : null;
      await logError(env, err, {
        path: url?.pathname || name,
        method: request?.method,
        extra: { handler: name },
      });
      throw err; // propagate pour que le caller puisse retourner 500
    }
  };
}

// ============================================================
// RATE LIMITING — KV-based, sliding window approximation par buckets
// ============================================================
// Limites par défaut (override via env vars si besoin) :
//  - Public anon (par IP) : 60 req/min
//  - Authentifié (par uid) : 180 req/min
// Le bucket est par minute calendaire → max possible ~ 2x la limite si requête en bordure de minute (acceptable).
// Coût KV : 1 read + 1 write par requête. À 10k req/jour = 10k writes (gratuit jusqu'à 100k/j).
async function checkRateLimit(env, key, limit, windowSec = 60) {
  const bucket = Math.floor(Date.now() / 1000 / windowSec);
  const fullKey = `rl:${key}:${bucket}`;
  try {
    const current = parseInt(await env.CACHE.get(fullKey) || '0', 10);
    if (current >= limit) {
      return { allowed: false, remaining: 0, retryAfter: windowSec - (Math.floor(Date.now() / 1000) % windowSec) };
    }
    // Awaited write : KV est éventuellement cohérent mais l'await garantit la propagation locale
    await env.CACHE.put(fullKey, String(current + 1), { expirationTtl: Math.max(60, windowSec * 2) });
    return { allowed: true, remaining: limit - current - 1, retryAfter: 0 };
  } catch (e) {
    // Si KV down, on laisse passer (ouvert) — préfère disponibilité à la stricte limite
    console.warn('Rate limit check failed:', e);
    return { allowed: true, remaining: limit, retryAfter: 0 };
  }
}

function rateLimitResponse(retryAfter, origin) {
  const headers = corsHeaders(origin);
  headers['Content-Type'] = 'application/json';
  headers['Retry-After'] = String(retryAfter);
  return new Response(
    JSON.stringify({ error: 'Trop de requêtes. Patientez quelques secondes.', code: 'RATE_LIMITED', retryAfter }),
    { status: 429, headers }
  );
}

// Récupère l'IP du client (Cloudflare la fournit dans CF-Connecting-IP)
function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    || 'unknown';
}

// Routes exemptées du rate-limit IP (Stripe envoie depuis ses propres IPs)
const RATE_LIMIT_EXEMPT_PATHS = new Set(['/stripe/webhook']);

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      // Global catch : toute exception non-catchée finit ici + est loggée pour observabilité
      const url = request && request.url ? new URL(request.url) : null;
      await logError(env, err, {
        path: url?.pathname || 'unknown',
        method: request?.method,
        extra: { source: 'global-catch' },
      }).catch(() => {}); // best-effort
      console.error('[global]', err);
      return jsonResponse({
        error: 'Internal server error',
        requestId: request.headers.get('cf-ray') || '—',
      }, 500, env.ALLOWED_ORIGIN);
    }
  },

  // ============================================================
  // SCHEDULED : Cron trigger (digest watchlist quotidien + health check)
  // Tire chaque jour a 6h15 UTC (voir wrangler.toml [triggers])
  // ============================================================
  async scheduled(event, env, ctx) {
    log.info('cron.scheduled.fired', { cronTime: event.cron });
    ctx.waitUntil(runDailyWatchlistDigest(env).catch(err => {
      log.error('cron.watchlist.failed', { err });
      return logError(env, err, { path: 'cron:watchlist-digest' });
    }));
    ctx.waitUntil(runHealthCheck(env).catch(err => {
      log.error('cron.health.failed', { err });
      return logError(env, err, { path: 'cron:health-check' });
    }));
  },
};

// ============================================================
// Handler principal : toute la logique de routing
// (Extrait de fetch() pour permettre le wrap try/catch + logError global)
// ============================================================
async function handleRequest(request, env) {
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

    // --- Rate limit par IP pour les routes publiques uniquement (60 req/min) ---
    // Bypass si header X-Internal-Secret correspond (pour GitHub Actions / pipeline batch)
    const internalSecret = request.headers.get('X-Internal-Secret');
    const isTrustedInternal = internalSecret && env.INTERNAL_SECRET && internalSecret === env.INTERNAL_SECRET;
    const isPublicRoute = !path.startsWith('/api/') && !path.startsWith('/stripe/')
      && !path.startsWith('/account/') && !path.startsWith('/support/');
    if (isPublicRoute && !RATE_LIMIT_EXEMPT_PATHS.has(path) && !isTrustedInternal) {
      const ip = getClientIP(request);
      const limitAnon = parseInt(env.RATE_LIMIT_ANON || '60', 10);
      const rl = await checkRateLimit(env, `ip:${ip}`, limitAnon, 60);
      if (!rl.allowed) {
        return rateLimitResponse(rl.retryAfter, origin || env.ALLOWED_ORIGIN);
      }
    }

    // ==========================================
    // ROUTES PUBLIQUES (pas d'auth)
    // ==========================================
    if (request.method === 'POST' && path === '/send-welcome') {
      return handleSendWelcome(request, env, origin);
    }

    // Watchlist : confirmation double opt-in (via lien email, pas de Firebase token)
    // Format : GET /watchlist/confirm?uid=...&token=...
    if (request.method === 'GET' && path === '/watchlist/confirm') {
      return handleWatchlistConfirmOptin(url, env, origin);
    }

    // Watchlist : desabonnement 1 clic (via lien email)
    // Format : GET /watchlist/unsubscribe?uid=...&token=...
    if (request.method === 'GET' && path === '/watchlist/unsubscribe') {
      return handleWatchlistUnsubscribe(url, env, origin);
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
    // Format : GET /a/:ticker[?lang=fr|en] -> HTML complet pre-rendu (meta tags + contenu indexable)
    if (request.method === 'GET' && path.startsWith('/a/')) {
      const ticker = decodeURIComponent(path.slice('/a/'.length));
      const lang = (url.searchParams.get('lang') || '').toLowerCase() === 'en' ? 'en' : 'fr';
      return handleActionSSR(ticker, env, lang);
    }

    // ==========================================
    // ROUTES AUTHENTIFIÉES (Firebase JWT requis)
    // ==========================================
    if (path.startsWith('/api/') || path.startsWith('/stripe/') || path.startsWith('/account/') || path.startsWith('/support/')) {
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

      // --- Rate limit par uid DÉSACTIVÉ pour économiser les writes KV free tier ---
      // Les users authentifiés sont déjà limités par le coût de verif JWT Firebase.
      // Si abus (bot avec 1000 comptes), réactivable via RATE_LIMIT_AUTH_ENABLE=1.
      if (env.RATE_LIMIT_AUTH_ENABLE === '1' && !isAdmin(user)) {
        const limitAuth = parseInt(env.RATE_LIMIT_AUTH || '180', 10);
        const rl = await checkRateLimit(env, `uid:${user.uid}`, limitAuth, 60);
        if (!rl.allowed) {
          return rateLimitResponse(rl.retryAfter, origin);
        }
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

      // --- Suppression de compte (RGPD) : purge KV + watchlist (Firebase Auth géré côté client) ---
      if (request.method === 'POST' && path === '/account/delete') {
        return handleAccountDelete(env, user, origin);
      }

      // --- Support : formulaire de contact (envoie un email au support via Brevo) ---
      if (request.method === 'POST' && path === '/support/contact') {
        return handleSupportContact(request, env, user, origin);
      }

      // --- Routes Watchlist (auth requise, check premium integre dans la route) ---
      if (path.startsWith('/api/watchlist/')) {
        const subData = await env.CACHE.get(`sub:${user.uid}`, 'json');
        const isPremium = !!(subData && (subData.status === 'active' || subData.status === 'past_due'));

        if (request.method === 'POST' && path === '/api/watchlist/sync') {
          return handleWatchlistSync(request, env, user, isPremium, origin);
        }
        if (request.method === 'GET' && path === '/api/watchlist/get') {
          return handleWatchlistGet(env, user, origin);
        }
        if (request.method === 'POST' && path === '/api/watchlist/test-now') {
          // Genere un email immediatement pour debug (utile pour premium uniquement)
          if (!isPremium) {
            return jsonResponse({ error: 'Premium subscription required', code: 'PREMIUM_REQUIRED' }, 403, origin);
          }
          return handleWatchlistTestNow(env, user, origin);
        }
        return jsonResponse({ error: 'Not found' }, 404, origin);
      }

      // --- Routes Admin (reserve aux emails de ADMIN_EMAILS) ---
      if (path.startsWith('/api/admin/')) {
        if (!isAdmin(user)) {
          return jsonResponse({ error: 'Forbidden — admin access required', code: 'ADMIN_ONLY' }, 403, origin);
        }
        if (path === '/api/admin/whoami') {
          return jsonResponse({
            isAdmin: true,
            uid: user.uid,
            email: user.email,
            emailVerified: user.emailVerified,
          }, 200, origin);
        }
        if (path === '/api/admin/users') {
          return handleAdminUsers(env, origin);
        }
        if (path === '/api/admin/subs-stats') {
          return handleAdminSubsStats(env, origin);
        }
        if (path === '/api/admin/traffic') {
          return handleAdminTraffic(url, env, origin);
        }
        if (path === '/api/admin/ga4-stats') {
          return handleAdminGA4Stats(url, env, origin);
        }
        // Trigger manuel du cron watchlist-digest
        if (request.method === 'POST' && path === '/api/admin/run-watchlist-cron') {
          return handleAdminRunWatchlistCron(env, origin);
        }
        // Health check : lance + retourne le statut
        if (request.method === 'POST' && path === '/api/admin/run-health-check') {
          return handleAdminRunHealthCheck(env, origin);
        }
        if (path === '/api/admin/health-status') {
          return handleAdminHealthStatus(env, origin);
        }
        if (path === '/api/admin/backup-status') {
          return handleAdminBackupStatus(env, origin);
        }
        if (path === '/api/admin/score-weights' && request.method === 'GET') {
          return handleAdminScoreWeightsGet(env, origin);
        }
        if (path === '/api/admin/score-weights' && request.method === 'PUT') {
          return handleAdminScoreWeightsPut(request, env, origin);
        }
        // Error log : liste + clear
        if (path === '/api/admin/errors') {
          return handleAdminErrors(env, origin);
        }
        if (request.method === 'POST' && path === '/api/admin/errors-clear') {
          return handleAdminErrorsClear(env, origin);
        }
        if (path === '/api/admin/db-stats') {
          return handleAdminDbStats(env, origin);
        }
        if (path === '/api/admin/jobs') {
          return handleAdminJobs(env, origin);
        }
        return jsonResponse({ error: 'Unknown admin route' }, 404, origin);
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
}

// ============================================================
// AUTH : Vérification Firebase ID Token (via REST API)
// ============================================================
// ============================================================
// ADMIN : allowlist d'emails autorises a acceder a /api/admin/*
// Le check est fait via le JWT Firebase (email verifie), pas de password supplementaire.
// Pour ajouter un admin, mettre son email ici (lowercase).
// ============================================================
const ADMIN_EMAILS = ['natquinson@gmail.com'];

function isAdmin(user) {
  if (!user || !user.email) return false;
  return ADMIN_EMAILS.includes(user.email.toLowerCase());
}

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
  // Route generique ETF (symbol=BUZZ -> KV etf-buzz)
  // Couvre les nouveaux ETF Zacks : BUZZ, MEME, JEPI, JEPQ, ITA, URA, UFO, MJ
  if (path === '/api/etf') {
    const symbol = (url.searchParams.get('symbol') || '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
    if (!symbol || symbol.length > 10) {
      return jsonResponse({ error: 'Invalid symbol' }, 400, origin);
    }
    const data = await env.CACHE.get(`etf-${symbol.toLowerCase()}`, 'json');
    if (!data) return jsonResponse({ error: 'ETF not loaded', symbol }, 404, origin);
    return jsonResponse(data, 200, origin);
  }
  // Liste des ETF disponibles (groupes par categorie pour l'UI)
  if (path === '/api/etf-list') {
    return jsonResponse({
      categories: [
        { name: 'Politique US', etfs: [
          { symbol: 'NANC', label: 'Démocrates US (Pelosi & co)' },
          { symbol: 'GOP',  label: 'Républicains US' },
        ]},
        { name: 'Smart Money / Hedge Funds', etfs: [
          { symbol: 'GURU', label: 'Top 60 hedge funds' },
        ]},
        { name: 'Innovation (ARK)', etfs: [
          { symbol: 'ARKK', label: 'ARK Innovation' },
          { symbol: 'ARKW', label: 'ARK Internet' },
          { symbol: 'ARKG', label: 'ARK Genomics' },
          { symbol: 'ARKF', label: 'ARK Fintech' },
          { symbol: 'ARKQ', label: 'ARK Robotique' },
        ]},
        { name: 'Sentiment retail', etfs: [
          { symbol: 'BUZZ', label: 'Social Sentiment (VanEck)' },
          { symbol: 'MEME', label: 'Roundhill MEME' },
        ]},
        { name: 'Income (Covered call)', etfs: [
          { symbol: 'JEPI', label: 'JPMorgan Equity Premium' },
          { symbol: 'JEPQ', label: 'JPMorgan Nasdaq Premium' },
        ]},
        { name: 'Thématiques', etfs: [
          { symbol: 'ITA', label: 'Defense & Aerospace' },
          { symbol: 'URA', label: 'Uranium' },
          { symbol: 'UFO', label: 'Espace' },
          { symbol: 'MJ',  label: 'Cannabis' },
        ]},
      ],
    }, 200, origin);
  }

  // ============================================================
  // HISTORIQUE D1 (Cloudflare D1 SQLite serverless)
  // - /api/history/score?ticker=AAPL  -> evolution Kairos Score 90j
  // - /api/history/etf?ticker=NVDA    -> evolution dans les ETF (qui detient quand)
  // - /api/history/fund?cik=0001067983&ticker=AAPL -> evolution position d'un fonds
  // - /api/history/insider?ticker=AAPL&days=365  -> transactions insider long-terme
  // - /api/history/insider-top?period=1y&role=CEO -> classement insiders par ROI (Phase 2)
  // - /api/history/insider-stats?ticker=AAPL -> stats agregees (nb tx, volume buy/sell)
  // ============================================================
  if (path === '/api/history/score') {
    return handleHistoryScore(url, env, origin);
  }
  if (path === '/api/history/etf') {
    return handleHistoryEtfTicker(url, env, origin);
  }
  if (path === '/api/history/fund') {
    return handleHistoryFund(url, env, origin);
  }
  if (path === '/api/history/etf-rotations') {
    return handleEtfRotations(url, env, origin);
  }
  // Widget "Activité récente" : agrège les événements des N derniers jours pour un ticker
  if (path === '/api/history/ticker-activity') {
    return handleTickerActivity(url, env, origin);
  }
  // Home dashboard : top signaux du jour (score movers + insider clusters + ETF rotations)
  if (path === '/api/home/top-signals') {
    return handleHomeTopSignals(url, env, origin);
  }
  // Écrans détaillés des signaux (accessibles depuis la home)
  if (path === '/api/signals/insider-clusters') {
    return handleSignalsInsiderClusters(url, env, origin);
  }
  if (path === '/api/signals/insider-netflow') {
    return handleSignalsInsiderNetFlow(url, env, origin);
  }
  if (path === '/api/signals/insider-crossticker') {
    return handleSignalsInsiderCrossTicker(url, env, origin);
  }
  if (path === '/api/signals/insider-cluster-detail') {
    return handleSignalsInsiderClusterDetail(url, env, origin);
  }
  if (path === '/api/signals/score-movers') {
    return handleSignalsScoreMovers(url, env, origin);
  }
  if (path === '/api/signals/etf-rotations') {
    return handleSignalsEtfRotations(url, env, origin);
  }
  if (path === '/api/history/insider') {
    return handleHistoryInsider(url, env, origin);
  }
  if (path === '/api/history/insider-stats') {
    return handleHistoryInsiderStats(url, env, origin);
  }
  if (path === '/api/history/insider-top') {
    return handleHistoryInsiderTop(url, env, origin);
  }

  // 13D/G Schedule filings (activists + large shareholders >5%)
  // - /api/13dg/recent          -> tous les filings recents (30j)
  // - /api/13dg/ticker?ticker=X -> filings sur un ticker specifique
  // - /api/13dg/activists       -> filings activists uniquement (filtres)
  if (path === '/api/13dg/recent') {
    return handleScheduleDGRecent(url, env, origin);
  }
  if (path === '/api/13dg/ticker') {
    return handleScheduleDGTicker(url, env, origin);
  }
  if (path === '/api/13dg/activists') {
    return handleScheduleDGActivists(url, env, origin);
  }

  // Google Trends : top risers + hot tickers (pour la section Hot Stocks)
  if (path === '/api/trends-hot') {
    const data = await env.CACHE.get('google-trends-hot', 'json');
    if (!data) return jsonResponse({ error: 'Trends data not loaded yet' }, 503, origin);
    return jsonResponse(data, 200, origin);
  }

  // Analyse action — premium (donnees completes)
  // Format : GET /api/stock/:ticker[?range=1y|5y|max...]
  if (path.startsWith('/api/stock/')) {
    const ticker = decodeURIComponent(path.slice('/api/stock/'.length));
    const chartRange = url.searchParams.get('range') || '1y';
    const data = await handleStockAnalysis(ticker, env, { publicView: false, chartRange });
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

    const tickerByName = await buildTickerByName(env);

    // Aggregation : pour chaque holding (par name normalise), on compile
    // le nb TOTAL de fonds qui detiennent + un sous-compte "conviction"
    // (positions >= CONVICTION_THRESHOLD % du portefeuille).
    //
    // Rationale : les mega passifs (BlackRock, Vanguard) detiennent techniquement
    // des milliers de titres avec des pourcentages tres dilues. On NE veut pas
    // les exclure totalement (c'est rassurant de voir qu'AAPL est detenu par
    // Vanguard meme si c'est 0.1%), mais on ajoute un score "conviction"
    // pour faire ressortir les vrais signaux smart money sans polluer.
    const CONVICTION_THRESHOLD = 0.3;  // % du portefeuille du fonds
    const consensus = new Map(); // name -> { ..., fundCount, convictionCount, fundsHolding[] }

    for (const fund of funds) {
      if (!Array.isArray(fund.topHoldings)) continue;

      // ETAPE 1 : pre-aggreger les holdings DU FOND par key normalisee.
      // Un meme fond peut avoir plusieurs lignes pour la meme entreprise
      // (ex. ALPHABET CL A + ALPHABET CL C, ou plusieurs ETF iShares
      // qui se normalisent en "ISHARES TR"). On les fusionne d'abord.
      const fundAgg = new Map();  // key -> { name, cusip, shares, value, pct, sharesChange, status }
      for (const h of fund.topHoldings) {
        if (!h.name) continue;
        const key = normalizeForMatch(h.name);
        if (!key) continue;
        if (!fundAgg.has(key)) {
          fundAgg.set(key, {
            name: h.name,
            cusip: h.cusip || null,
            shares: 0,
            value: 0,
            pct: 0,
            sharesChange: null,
            status: null,
            count: 0,
          });
        }
        const a = fundAgg.get(key);
        a.shares += Number(h.shares) || 0;
        a.value += Number(h.value) || 0;
        a.pct += Number(h.pct) || 0;          // % cumule (ex. 1.2% + 0.8% sur GOOGL+GOOG = 2%)
        a.count += 1;
        // Pour sharesChange et status : on prend le plus gros mouvement (en valeur absolue)
        const sc = h.sharesChange != null ? Number(h.sharesChange) : null;
        if (sc != null && (a.sharesChange == null || Math.abs(sc) > Math.abs(a.sharesChange))) {
          a.sharesChange = sc;
        }
        if (h.status === 'new' && !a.status) a.status = 'new';
        else if (h.status === 'sold' && a.status !== 'new') a.status = 'sold';
        else if (h.status && !a.status) a.status = h.status;
      }

      // ETAPE 2 : agreger dans le consensus inter-fonds
      for (const [key, h] of fundAgg) {
        const pct = h.pct;
        if (!consensus.has(key)) {
          consensus.set(key, {
            name: h.name,
            ticker: tickerByName.get(key) || null,
            cusip: h.cusip || null,
            fundCount: 0,
            convictionCount: 0,
            totalValue: 0,
            totalShares: 0,
            avgPctOfPortfolio: 0,
            fundsHolding: [],
          });
        }
        const entry = consensus.get(key);
        entry.fundCount += 1;
        if (pct >= CONVICTION_THRESHOLD) entry.convictionCount += 1;
        entry.totalValue += h.value;
        entry.totalShares += h.shares;
        entry.fundsHolding.push({
          fundName: fund.fundName,
          label: fund.label || null,
          category: fund.category || null,
          cik: fund.cik,
          shares: h.shares,
          value: h.value,
          pct: pct,
          isConviction: pct >= CONVICTION_THRESHOLD,
          sharesChange: h.sharesChange,
          status: h.status,
        });
      }
    }

    // Calcul moyenne pct + tri par convictionCount desc (vrai smart money signal),
    // puis fundCount desc, puis totalValue desc. Cela fait remonter les actions
    // ou plusieurs fonds ont une position significative, meme si d'autres
    // passifs les detiennent aussi.
    const list = Array.from(consensus.values()).map(c => {
      const pcts = c.fundsHolding.map(f => f.pct).filter(p => p > 0);
      c.avgPctOfPortfolio = pcts.length ? +(pcts.reduce((a, b) => a + b, 0) / pcts.length).toFixed(2) : 0;
      // Trier les fundsHolding : conviction en premier, puis par value desc
      c.fundsHolding.sort((a, b) => (b.isConviction - a.isConviction) || (b.value - a.value));
      return c;
    });
    list.sort((a, b) => (b.convictionCount - a.convictionCount) || (b.fundCount - a.fundCount) || (b.totalValue - a.totalValue));

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

    const tickerByName = await buildTickerByName(env);

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

// ============================================================
// HISTORIQUE D1 : evolution Kairos Score d'un ticker
// GET /api/history/score?ticker=AAPL[&days=90]
// Retourne : { ticker, series: [{date, total, insider, smart_money, ...}, ...] }
// ============================================================
async function handleHistoryScore(url, env, origin) {
  const ticker = (url.searchParams.get('ticker') || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '');
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '90', 10), 7), 365);
  if (!ticker) return jsonResponse({ error: 'Missing ticker' }, 400, origin);
  if (!env.HISTORY) return jsonResponse({ error: 'D1 binding not configured' }, 503, origin);

  try {
    const result = await env.HISTORY.prepare(
      `SELECT date, total, insider, smart_money, gov_guru, momentum, valuation, analyst, health, earnings
       FROM score_history
       WHERE ticker = ?
         AND date >= date('now', ?)
       ORDER BY date ASC`
    ).bind(ticker, `-${days} days`).all();

    return jsonResponse({
      ticker,
      days,
      pointsCount: result.results?.length || 0,
      series: result.results || [],
    }, 200, origin);
  } catch (e) {
    return jsonResponse({ error: 'D1 query failed', detail: String(e && e.message || e) }, 500, origin);
  }
}

// ============================================================
// HISTORIQUE D1 : presence d'un ticker dans les ETF au fil du temps
// GET /api/history/etf?ticker=NVDA[&days=90]
// Retourne : { ticker, series: [{date, etf_symbol, weight, rank}, ...] }
// Permet de voir : "NVDA est passe du #5 au #1 dans BUZZ en 30 jours"
// ============================================================
async function handleHistoryEtfTicker(url, env, origin) {
  const ticker = (url.searchParams.get('ticker') || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '');
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '90', 10), 7), 365);
  if (!ticker) return jsonResponse({ error: 'Missing ticker' }, 400, origin);
  if (!env.HISTORY) return jsonResponse({ error: 'D1 binding not configured' }, 503, origin);

  try {
    const result = await env.HISTORY.prepare(
      `SELECT date, etf_symbol, weight, rank
       FROM etf_snapshots
       WHERE ticker = ?
         AND date >= date('now', ?)
       ORDER BY date ASC, etf_symbol ASC`
    ).bind(ticker, `-${days} days`).all();

    // Grouper par ETF pour faciliter le rendu cote client
    const byEtf = {};
    for (const r of (result.results || [])) {
      if (!byEtf[r.etf_symbol]) byEtf[r.etf_symbol] = [];
      byEtf[r.etf_symbol].push({ date: r.date, weight: r.weight, rank: r.rank });
    }
    const etfs = Object.keys(byEtf).sort();

    return jsonResponse({
      ticker,
      days,
      etfsCount: etfs.length,
      etfs: etfs.map(sym => ({
        symbol: sym,
        firstSeen: byEtf[sym][0].date,
        lastSeen: byEtf[sym][byEtf[sym].length - 1].date,
        currentWeight: byEtf[sym][byEtf[sym].length - 1].weight,
        currentRank: byEtf[sym][byEtf[sym].length - 1].rank,
        series: byEtf[sym],
      })),
    }, 200, origin);
  } catch (e) {
    return jsonResponse({ error: 'D1 query failed', detail: String(e && e.message || e) }, 500, origin);
  }
}

// ============================================================
// HISTORIQUE D1 : evolution position d'un fonds sur un ticker
// GET /api/history/fund?cik=0001067983&ticker=AAPL
// Retourne : { cik, ticker, quarters: [{report_date, shares, value, pct}, ...] }
// Ex : "Buffett a divise par 3 sa position AAPL en 6 trimestres"
// ============================================================
async function handleHistoryFund(url, env, origin) {
  const cik = (url.searchParams.get('cik') || '').replace(/[^0-9]/g, '').padStart(10, '0');
  const ticker = (url.searchParams.get('ticker') || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '');
  if (!cik || cik === '0000000000') return jsonResponse({ error: 'Missing cik' }, 400, origin);
  if (!env.HISTORY) return jsonResponse({ error: 'D1 binding not configured' }, 503, origin);

  try {
    let query, args;
    if (ticker) {
      // Evolution d'un ticker dans le portefeuille d'un fond
      query = `SELECT report_date, ticker, name, shares, value, pct
               FROM fund_holdings_history
               WHERE cik = ? AND ticker = ?
               ORDER BY report_date ASC`;
      args = [cik, ticker];
    } else {
      // Liste des positions d'un fond a chaque trimestre (top 50 par trim)
      query = `SELECT report_date, ticker, name, shares, value, pct
               FROM fund_holdings_history
               WHERE cik = ?
               ORDER BY report_date DESC, value DESC
               LIMIT 500`;
      args = [cik];
    }
    const result = await env.HISTORY.prepare(query).bind(...args).all();
    return jsonResponse({
      cik,
      ticker: ticker || null,
      quarters: result.results || [],
    }, 200, origin);
  } catch (e) {
    return jsonResponse({ error: 'D1 query failed', detail: String(e && e.message || e) }, 500, origin);
  }
}

// ============================================================
// HISTORIQUE D1 : rotations recentes des ETF (entrees/sorties)
// GET /api/history/etf-rotations[?etf=BUZZ][&days=7]
// Compare le dernier snapshot vs un snapshot N jours avant pour
// detecter les nouveaux holdings (entrees) et les disparus (sorties).
// ============================================================
async function handleEtfRotations(url, env, origin) {
  const etfFilter = (url.searchParams.get('etf') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '7', 10), 1), 60);
  if (!env.HISTORY) return jsonResponse({ error: 'D1 binding not configured' }, 503, origin);

  try {
    // 1. Trouve la derniere date snapshot par ETF
    const sql = etfFilter
      ? `SELECT etf_symbol, MAX(date) as last_date FROM etf_snapshots WHERE etf_symbol = ? GROUP BY etf_symbol`
      : `SELECT etf_symbol, MAX(date) as last_date FROM etf_snapshots GROUP BY etf_symbol`;
    const lastDates = etfFilter
      ? await env.HISTORY.prepare(sql).bind(etfFilter).all()
      : await env.HISTORY.prepare(sql).all();

    const rotations = [];
    for (const row of (lastDates.results || [])) {
      const sym = row.etf_symbol;
      const lastDate = row.last_date;

      // 2. Trouve le snapshot le plus proche de "lastDate - days"
      const prev = await env.HISTORY.prepare(
        `SELECT date FROM etf_snapshots
         WHERE etf_symbol = ? AND date <= date(?, ?)
         ORDER BY date DESC LIMIT 1`
      ).bind(sym, lastDate, `-${days} days`).all();
      const prevDate = prev.results?.[0]?.date;
      if (!prevDate || prevDate === lastDate) {
        // Pas assez d'historique pour ce ETF
        continue;
      }

      // 3. Holdings actuels et anciens
      const currentRes = await env.HISTORY.prepare(
        `SELECT ticker, weight, rank FROM etf_snapshots WHERE etf_symbol = ? AND date = ?`
      ).bind(sym, lastDate).all();
      const previousRes = await env.HISTORY.prepare(
        `SELECT ticker, weight, rank FROM etf_snapshots WHERE etf_symbol = ? AND date = ?`
      ).bind(sym, prevDate).all();

      const current = new Map((currentRes.results || []).map(h => [h.ticker, h]));
      const previous = new Map((previousRes.results || []).map(h => [h.ticker, h]));

      const entries = []; // nouveaux
      const exits = [];   // sortis
      const movers = [];  // changement de poids significatif

      for (const [t, h] of current) {
        if (!previous.has(t)) {
          entries.push({ ticker: t, weight: h.weight, rank: h.rank });
        } else {
          const old = previous.get(t);
          const delta = h.weight - old.weight;
          if (Math.abs(delta) >= 0.5) {
            movers.push({
              ticker: t,
              currentWeight: h.weight,
              previousWeight: old.weight,
              delta,
              currentRank: h.rank,
              previousRank: old.rank,
            });
          }
        }
      }
      for (const [t, h] of previous) {
        if (!current.has(t)) {
          exits.push({ ticker: t, previousWeight: h.weight, previousRank: h.rank });
        }
      }

      // Tri : entrees par poids desc, sorties par poids desc, movers par |delta| desc
      entries.sort((a, b) => b.weight - a.weight);
      exits.sort((a, b) => b.previousWeight - a.previousWeight);
      movers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

      if (entries.length || exits.length || movers.length) {
        rotations.push({
          etf: sym,
          fromDate: prevDate,
          toDate: lastDate,
          entries: entries.slice(0, 10),
          exits: exits.slice(0, 10),
          movers: movers.slice(0, 5),
          summary: {
            entriesCount: entries.length,
            exitsCount: exits.length,
            moversCount: movers.length,
          },
        });
      }
    }

    // Tri global : ETF avec le plus de mouvements en haut
    rotations.sort((a, b) => (b.summary.entriesCount + b.summary.exitsCount) - (a.summary.entriesCount + a.summary.exitsCount));

    return jsonResponse({
      days,
      rotations,
    }, 200, origin);
  } catch (e) {
    return jsonResponse({ error: 'D1 rotations query failed', detail: String(e && e.message || e) }, 500, origin);
  }
}

// ============================================================
// WIDGET "Activité récente" — agrège les événements des N derniers jours pour un ticker
// GET /api/history/ticker-activity?ticker=AAPL[&days=7]
// Retourne :
//   {
//     ticker, days,
//     score: { now, previous, delta, dateNow, datePrevious },
//     etfChanges: [{etf, prevWeight, currWeight, delta, status: 'new'|'exit'|'increased'|'decreased'}],
//     insiderTrades: [{date, filer, role, type, shares, value}]
//   }
// ============================================================
async function handleTickerActivity(url, env, origin) {
  const ticker = (url.searchParams.get('ticker') || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '');
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '7', 10), 1), 90);
  if (!ticker) return jsonResponse({ error: 'Missing ticker' }, 400, origin);
  if (!env.HISTORY) return jsonResponse({ error: 'D1 binding not configured' }, 503, origin);

  try {
    // 1) Kairos Score : valeur la plus récente + valeur au +/- days avant
    let scoreInfo = null;
    try {
      const scoreRes = await env.HISTORY.prepare(
        `SELECT date, total FROM score_history WHERE ticker = ? ORDER BY date DESC LIMIT 20`
      ).bind(ticker).all();
      const rows = scoreRes.results || [];
      if (rows.length >= 1) {
        const now = rows[0];
        // Cherche la valeur la plus proche de "il y a N jours" (basé sur date, pas index)
        const cutoff = new Date(now.date);
        cutoff.setDate(cutoff.getDate() - days);
        const cutoffStr = cutoff.toISOString().slice(0, 10);
        const prev = rows.find(r => r.date <= cutoffStr) || rows[rows.length - 1];
        scoreInfo = {
          now: now.total,
          previous: prev && prev.date !== now.date ? prev.total : null,
          delta: prev && prev.date !== now.date ? (now.total - prev.total) : null,
          dateNow: now.date,
          datePrevious: prev && prev.date !== now.date ? prev.date : null,
        };
      }
    } catch (e) { console.warn('score lookup failed:', e); }

    // 2) ETF changes : comparer les poids actuels vs N jours avant
    const etfChanges = [];
    try {
      // Dernière date disponible en etf_snapshots
      const latestRes = await env.HISTORY.prepare(
        `SELECT MAX(date) as max_d FROM etf_snapshots`
      ).all();
      const latestDate = latestRes.results?.[0]?.max_d;
      if (latestDate) {
        const cutoff = new Date(latestDate);
        cutoff.setDate(cutoff.getDate() - days);
        const cutoffStr = cutoff.toISOString().slice(0, 10);

        // Poids du ticker aujourd'hui, pour chaque ETF
        const todayRes = await env.HISTORY.prepare(
          `SELECT etf_symbol, weight, rank FROM etf_snapshots WHERE ticker = ? AND date = ?`
        ).bind(ticker, latestDate).all();
        const todayByEtf = {};
        (todayRes.results || []).forEach(r => { todayByEtf[r.etf_symbol] = { weight: r.weight, rank: r.rank }; });

        // Poids du ticker il y a N jours, pour chaque ETF (snapshot le plus proche)
        const prevRes = await env.HISTORY.prepare(
          `SELECT e.etf_symbol, e.weight, e.rank
           FROM etf_snapshots e
           INNER JOIN (
             SELECT etf_symbol, MAX(date) as d
             FROM etf_snapshots WHERE ticker = ? AND date <= ?
             GROUP BY etf_symbol
           ) p ON e.etf_symbol = p.etf_symbol AND e.date = p.d
           WHERE e.ticker = ?`
        ).bind(ticker, cutoffStr, ticker).all();
        const prevByEtf = {};
        (prevRes.results || []).forEach(r => { prevByEtf[r.etf_symbol] = { weight: r.weight, rank: r.rank }; });

        // Dates de transition pour chaque (etf, ticker) sur la fenetre :
        // permet d'afficher la vraie date d'entree / sortie dans le front,
        // pas juste latestDate (moins informatif quand 4 mouvements apparaissent
        // tous "au 22 avr." alors qu'ils se sont faits a des jours differents).
        const transitionRes = await env.HISTORY.prepare(
          `SELECT etf_symbol, MIN(date) AS first_date, MAX(date) AS last_date
           FROM etf_snapshots
           WHERE ticker = ? AND date >= ? AND date <= ?
           GROUP BY etf_symbol`
        ).bind(ticker, cutoffStr, latestDate).all();
        const windowByEtf = {};
        (transitionRes.results || []).forEach(r => { windowByEtf[r.etf_symbol] = { firstDate: r.first_date, lastDate: r.last_date }; });

        // Union des ETFs (pour détecter entrées et sorties)
        const allEtfs = new Set([...Object.keys(todayByEtf), ...Object.keys(prevByEtf)]);
        for (const etf of allEtfs) {
          const cur = todayByEtf[etf];
          const prev = prevByEtf[etf];
          const win = windowByEtf[etf] || {};
          if (cur && !prev) {
            // Entree : date = premier snapshot dans la fenetre (= date d'apparition)
            etfChanges.push({ etf, prevWeight: null, currWeight: cur.weight, delta: cur.weight, status: 'new', eventDate: win.firstDate || latestDate });
          } else if (!cur && prev) {
            // Sortie : date = dernier snapshot ou le ticker etait encore present
            etfChanges.push({ etf, prevWeight: prev.weight, currWeight: null, delta: -prev.weight, status: 'exit', eventDate: win.lastDate || cutoffStr });
          } else if (cur && prev) {
            const delta = (cur.weight || 0) - (prev.weight || 0);
            if (Math.abs(delta) >= 0.01) { // seuil 0.01% pour filtrer le bruit
              etfChanges.push({
                etf, prevWeight: prev.weight, currWeight: cur.weight, delta,
                status: delta > 0 ? 'increased' : 'decreased',
                eventDate: latestDate, // pour increased/decreased on n'a pas de date precise de transition, on prend latestDate
              });
            }
          }
        }
        // Tri par magnitude du delta
        etfChanges.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
      }
    } catch (e) { console.warn('etf changes failed:', e); }

    // 3) Insider trades récents sur ce ticker
    const insiderTrades = [];
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      const insRes = await env.HISTORY.prepare(
        `SELECT trans_date, insider, title, trans_type, shares, value, ticker
         FROM insider_transactions_history
         WHERE ticker = ? AND trans_date >= ?
         ORDER BY trans_date DESC, value DESC
         LIMIT 25`
      ).bind(ticker, cutoffStr).all();
      for (const r of (insRes.results || [])) {
        insiderTrades.push({
          date: r.trans_date,
          filer: r.insider,
          role: r.title,
          type: r.trans_type, // 'buy' | 'sell' | 'other' | 'option-exercise'
          shares: r.shares,
          value: r.value,
        });
      }
    } catch (e) { console.warn('insider trades failed:', e); }

    return jsonResponse({
      ticker,
      days,
      score: scoreInfo,
      etfChanges: etfChanges.slice(0, 10), // top 10 mouvements
      insiderTrades,
      summary: {
        scoreChanged: !!(scoreInfo && scoreInfo.delta !== null && Math.abs(scoreInfo.delta) >= 1),
        etfChangesCount: etfChanges.length,
        insiderTradesCount: insiderTrades.length,
      },
      generatedAt: new Date().toISOString(),
    }, 200, origin);
  } catch (e) {
    return jsonResponse({ error: 'ticker-activity query failed', detail: String(e && e.message || e) }, 500, origin);
  }
}

// ============================================================
// HOME DASHBOARD : top signaux du jour (feed agrégé)
// GET /api/home/top-signals
// Retourne :
//   {
//     date,
//     scoreMovers: [{ticker, scoreNow, scorePrev, delta}],  // top 6 par |delta|
//     insiderClusters: [{ticker, buyCount, sellCount, totalValue, topNames}],  // top 5 clusters
//     etfMovers: [{etf, ticker, prevWeight, currWeight, delta, status}],  // top 6 mouvements
//     activistsFresh: [{filer, ticker, date, form}],  // top 5 récents 13D/G
//     generatedAt
//   }
// ============================================================
async function handleHomeTopSignals(url, env, origin) {
  if (!env.HISTORY) return jsonResponse({ error: 'D1 binding not configured' }, 503, origin);

  // Cache 10 min en KV pour éviter de recalculer à chaque chargement de home
  const cacheKey = 'home:top-signals';
  try {
    const cached = await env.CACHE.get(cacheKey, 'json');
    if (cached && cached._cachedAt && (Date.now() - cached._cachedAt) < 600000) {
      return jsonResponse(cached, 200, origin);
    }
  } catch (e) {}

  try {
    const result = {
      date: new Date().toISOString().slice(0, 10),
      scoreMovers: [],
      insiderClusters: [],
      etfMovers: [],
      activistsFresh: [],
    };

    // 1) Score Movers : top deltas entre 2 dates les plus récentes par ticker
    try {
      const scoreQuery = `
        WITH latest_two AS (
          SELECT ticker, date, total,
                 ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS rn
          FROM score_history
        )
        SELECT
          a.ticker,
          a.total AS scoreNow,
          b.total AS scorePrev,
          a.date AS dateNow,
          b.date AS datePrev,
          (a.total - b.total) AS delta
        FROM latest_two a
        LEFT JOIN latest_two b ON a.ticker = b.ticker AND b.rn = 2
        WHERE a.rn = 1 AND b.total IS NOT NULL
          AND ABS(a.total - b.total) >= 3
        ORDER BY ABS(a.total - b.total) DESC
        LIMIT 12
      `;
      const rows = (await env.HISTORY.prepare(scoreQuery).all()).results || [];
      result.scoreMovers = rows.map(r => ({
        ticker: r.ticker,
        scoreNow: r.scoreNow,
        scorePrev: r.scorePrev,
        delta: r.delta,
        dateNow: r.dateNow,
        datePrev: r.datePrev,
      }));
    } catch (e) { console.warn('scoreMovers failed:', e); }

    // 2) Insider Clusters : tickers avec multiple transactions même jour
    try {
      const since = new Date();
      since.setDate(since.getDate() - 7);
      const sinceStr = since.toISOString().slice(0, 10);
      const clusterQuery = `
        SELECT
          ticker,
          COUNT(*) AS cnt,
          SUM(CASE WHEN trans_type = 'buy' THEN 1 ELSE 0 END) AS buyCount,
          SUM(CASE WHEN trans_type = 'sell' THEN 1 ELSE 0 END) AS sellCount,
          SUM(CASE WHEN trans_type = 'buy' THEN COALESCE(value, 0) ELSE 0 END) AS buyValue,
          SUM(CASE WHEN trans_type = 'sell' THEN COALESCE(value, 0) ELSE 0 END) AS sellValue,
          GROUP_CONCAT(DISTINCT insider) AS insiders,
          MAX(trans_date) AS lastDate
        FROM insider_transactions_history
        WHERE trans_date >= ? AND ticker IS NOT NULL AND ticker != ''
        GROUP BY ticker
        HAVING cnt >= 3
        ORDER BY cnt DESC, (buyValue + sellValue) DESC
        LIMIT 10
      `;
      const rows = (await env.HISTORY.prepare(clusterQuery).bind(sinceStr).all()).results || [];
      result.insiderClusters = rows.map(r => ({
        ticker: r.ticker,
        buyCount: r.buyCount || 0,
        sellCount: r.sellCount || 0,
        totalValue: (r.buyValue || 0) + (r.sellValue || 0),
        netValue: (r.buyValue || 0) - (r.sellValue || 0),
        topNames: (r.insiders || '').split(',').slice(0, 3),
        lastDate: r.lastDate,
      }));
    } catch (e) { console.warn('insiderClusters failed:', e); }

    // 3) ETF Movers : plus gros changements de poids entre les 2 dernières dates par ETF
    try {
      const etfQuery = `
        WITH latest_two AS (
          SELECT etf_symbol, ticker, date, weight,
                 ROW_NUMBER() OVER (PARTITION BY etf_symbol, ticker ORDER BY date DESC) AS rn
          FROM etf_snapshots
        )
        SELECT
          a.etf_symbol AS etf,
          a.ticker,
          a.weight AS currWeight,
          b.weight AS prevWeight,
          a.date AS dateNow,
          b.date AS datePrev,
          (a.weight - COALESCE(b.weight, 0)) AS delta
        FROM latest_two a
        LEFT JOIN latest_two b ON a.etf_symbol = b.etf_symbol AND a.ticker = b.ticker AND b.rn = 2
        WHERE a.rn = 1 AND b.weight IS NOT NULL
          AND ABS(a.weight - b.weight) >= 0.3
        ORDER BY ABS(a.weight - b.weight) DESC
        LIMIT 12
      `;
      const rows = (await env.HISTORY.prepare(etfQuery).all()).results || [];
      result.etfMovers = rows.map(r => ({
        etf: r.etf,
        ticker: r.ticker,
        prevWeight: r.prevWeight,
        currWeight: r.currWeight,
        delta: r.delta,
        status: r.delta > 0 ? 'increased' : 'decreased',
      }));
    } catch (e) { console.warn('etfMovers failed:', e); }

    // 4) Activists Fresh : derniers 13D/G filings depuis le KV
    try {
      const data13dg = await env.CACHE.get('13dg-recent', 'json');
      if (data13dg && Array.isArray(data13dg)) {
        result.activistsFresh = data13dg
          .filter(f => f.ticker)
          .slice(0, 5)
          .map(f => ({
            filer: f.filerName || 'Investisseur non résolu',
            ticker: f.ticker,
            date: f.filingDate || f.date,
            form: f.form,
            isActivist: !!f.isActivist,
          }));
      } else if (data13dg && data13dg.filings) {
        result.activistsFresh = (data13dg.filings || [])
          .filter(f => f.ticker)
          .slice(0, 5)
          .map(f => ({
            filer: f.filerName || 'Investisseur non résolu',
            ticker: f.ticker,
            date: f.filingDate || f.date,
            form: f.form,
            isActivist: !!f.isActivist,
          }));
      }
    } catch (e) { console.warn('activistsFresh failed:', e); }

    result.generatedAt = new Date().toISOString();
    result._cachedAt = Date.now();

    // Cache 10 min (la plupart des signaux sont quotidiens donc pas besoin de refresher souvent)
    try {
      await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 900 });
    } catch (e) {}

    return jsonResponse(result, 200, origin);
  } catch (e) {
    return jsonResponse({ error: 'top-signals query failed', detail: String(e && e.message || e) }, 500, origin);
  }
}

// ============================================================
// SIGNAL DETAIL : Clusters insiders (écran d'analyse dédié, Lot 1)
// GET /api/signals/insider-clusters?days=7&minTx=3&direction=all&minValue=0&roles=all&sort=value
// Retourne : { total, items: [{ticker, buyCount, sellCount, buyValue, sellValue, netValue, totalValue, insiders, topRoles, lastDate, company}] }
// ============================================================
async function handleSignalsInsiderClusters(url, env, origin) {
  if (!env.HISTORY) return jsonResponse({ error: 'D1 not configured' }, 503, origin);
  try {
    const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '7', 10), 1), 90);
    const minTx = Math.max(parseInt(url.searchParams.get('minTx') || '3', 10), 1);
    const direction = (url.searchParams.get('direction') || 'all').toLowerCase(); // all|bullish|bearish|mixed
    const minValue = Math.max(parseInt(url.searchParams.get('minValue') || '0', 10), 0);
    const roles = (url.searchParams.get('roles') || 'all').toLowerCase(); // all|csuite|directors|owners
    const sort = (url.searchParams.get('sort') || 'value').toLowerCase();   // value|count|net|recent

    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceStr = since.toISOString().slice(0, 10);

    // Filtre roles via LIKE SQL
    let roleFilter = '';
    if (roles === 'csuite') roleFilter = `AND (title LIKE '%CEO%' OR title LIKE '%CFO%' OR title LIKE '%COO%' OR title LIKE '%President%' OR title LIKE '%Chief%')`;
    else if (roles === 'directors') roleFilter = `AND (title LIKE '%Director%')`;
    else if (roles === 'owners') roleFilter = `AND (title LIKE '%10%%' OR title LIKE '%owner%')`;

    const query = `
      SELECT
        ticker,
        company,
        COUNT(*) AS cnt,
        SUM(CASE WHEN trans_type = 'buy' THEN 1 ELSE 0 END) AS buyCount,
        SUM(CASE WHEN trans_type = 'sell' THEN 1 ELSE 0 END) AS sellCount,
        SUM(CASE WHEN trans_type = 'buy' THEN COALESCE(value, 0) ELSE 0 END) AS buyValue,
        SUM(CASE WHEN trans_type = 'sell' THEN COALESCE(value, 0) ELSE 0 END) AS sellValue,
        GROUP_CONCAT(DISTINCT insider) AS insiders,
        GROUP_CONCAT(DISTINCT title) AS roles,
        MAX(trans_date) AS lastDate
      FROM insider_transactions_history
      WHERE trans_date >= ? AND ticker IS NOT NULL AND ticker != ''
      ${roleFilter}
      GROUP BY ticker
      HAVING cnt >= ?
      LIMIT 500
    `;
    const rows = (await env.HISTORY.prepare(query).bind(sinceStr, minTx).all()).results || [];

    // Post-filtre direction + minValue + tri (SQL + JS hybride)
    let items = rows.map(r => {
      const totalValue = (r.buyValue || 0) + (r.sellValue || 0);
      const netValue = (r.buyValue || 0) - (r.sellValue || 0);
      return {
        ticker: r.ticker,
        company: r.company,
        count: r.cnt,
        buyCount: r.buyCount || 0,
        sellCount: r.sellCount || 0,
        buyValue: r.buyValue || 0,
        sellValue: r.sellValue || 0,
        totalValue,
        netValue,
        insiders: (r.insiders || '').split(',').filter(Boolean).slice(0, 10),
        roles: (r.roles || '').split(',').filter(Boolean).slice(0, 6),
        lastDate: r.lastDate,
        direction: netValue > 0 ? 'bullish' : netValue < 0 ? 'bearish' : 'mixed',
      };
    });

    if (direction === 'bullish') items = items.filter(i => i.direction === 'bullish' && i.buyCount > 0);
    else if (direction === 'bearish') items = items.filter(i => i.direction === 'bearish' && i.sellCount > 0);
    else if (direction === 'mixed') items = items.filter(i => i.buyCount > 0 && i.sellCount > 0);

    if (minValue > 0) items = items.filter(i => i.totalValue >= minValue);

    // Tri
    if (sort === 'count') items.sort((a, b) => b.count - a.count);
    else if (sort === 'net') items.sort((a, b) => Math.abs(b.netValue) - Math.abs(a.netValue));
    else if (sort === 'recent') items.sort((a, b) => (b.lastDate || '').localeCompare(a.lastDate || ''));
    else items.sort((a, b) => b.totalValue - a.totalValue); // défaut : value

    return jsonResponse({
      total: items.length,
      items: items.slice(0, 200),
      filters: { days, minTx, direction, minValue, roles, sort },
      generatedAt: new Date().toISOString(),
    }, 200, origin);
  } catch (e) {
    return jsonResponse({ error: 'insider-clusters query failed', detail: String(e && e.message || e) }, 500, origin);
  }
}

// ============================================================
// SIGNAL DETAIL : Flux net insider par ticker (Signaux Insiders / onglet "Flux net")
// GET /api/signals/insider-netflow?days=30&direction=all&minValue=0&limit=20
// Retourne les tickers ordonnes par net (sum buy $ − sum sell $) sur la fenetre.
// ============================================================
async function handleSignalsInsiderNetFlow(url, env, origin) {
  if (!env.HISTORY) return jsonResponse({ error: 'D1 not configured' }, 503, origin);
  try {
    const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '30', 10), 1), 365);
    const direction = (url.searchParams.get('direction') || 'all').toLowerCase(); // all|bullish|bearish
    const minValue = Math.max(parseInt(url.searchParams.get('minValue') || '0', 10), 0);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '20', 10), 1), 200);

    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceStr = since.toISOString().slice(0, 10);

    const cacheKey = `netflow:${days}:${direction}:${minValue}:${limit}`;
    try {
      const cached = await env.CACHE?.get(cacheKey, 'json');
      if (cached) return jsonResponse(cached, 200, origin);
    } catch {}

    // SQL : groupe par ticker, calcule buys $ / sells $ / net $ / tx count / insiders uniques / derniere date.
    const query = `
      SELECT
        ticker,
        MAX(company) AS company,
        SUM(CASE WHEN trans_type = 'buy'  THEN COALESCE(value, 0) ELSE 0 END) AS buyValue,
        SUM(CASE WHEN trans_type = 'sell' THEN COALESCE(value, 0) ELSE 0 END) AS sellValue,
        COUNT(*) AS txCount,
        COUNT(DISTINCT insider) AS insiderCount,
        MAX(trans_date) AS lastDate
      FROM insider_transactions_history
      WHERE trans_date >= ?
        AND ticker IS NOT NULL AND ticker != ''
        AND trans_type IN ('buy', 'sell')
      GROUP BY ticker
      HAVING (buyValue + sellValue) > 0
      LIMIT 2000
    `;
    const rows = (await env.HISTORY.prepare(query).bind(sinceStr).all()).results || [];

    let items = rows.map(r => {
      const buyValue = r.buyValue || 0;
      const sellValue = r.sellValue || 0;
      const netValue = buyValue - sellValue;
      return {
        ticker: r.ticker,
        company: r.company || '',
        buyValue,
        sellValue,
        netValue,
        txCount: r.txCount || 0,
        insiderCount: r.insiderCount || 0,
        lastDate: r.lastDate,
      };
    });

    if (direction === 'bullish') items = items.filter(i => i.netValue > 0);
    else if (direction === 'bearish') items = items.filter(i => i.netValue < 0);

    if (minValue > 0) items = items.filter(i => Math.abs(i.netValue) >= minValue);

    items.sort((a, b) => {
      if (direction === 'bearish') return a.netValue - b.netValue; // plus negatif d'abord
      if (direction === 'bullish') return b.netValue - a.netValue; // plus positif d'abord
      return Math.abs(b.netValue) - Math.abs(a.netValue);          // magnitude decroissante
    });

    const result = {
      total: items.length,
      items: items.slice(0, limit),
      filters: { days, direction, minValue, limit },
      generatedAt: new Date().toISOString(),
    };

    try { await env.CACHE?.put(cacheKey, JSON.stringify(result), { expirationTtl: 900 }); } catch {}
    return jsonResponse(result, 200, origin);
  } catch (e) {
    return jsonResponse({ error: 'insider-netflow query failed', detail: String(e && e.message || e) }, 500, origin);
  }
}

// ============================================================
// SIGNAL DETAIL : Insiders transversaux (multi-tickers)
// GET /api/signals/insider-crossticker?days=90&minTickers=3&role=all&limit=30
// Retourne les insiders actifs sur ≥ N tickers differents sur la fenetre — vision transversale.
// ============================================================
async function handleSignalsInsiderCrossTicker(url, env, origin) {
  if (!env.HISTORY) return jsonResponse({ error: 'D1 not configured' }, 503, origin);
  try {
    const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '90', 10), 1), 730);
    const minTickers = Math.min(Math.max(parseInt(url.searchParams.get('minTickers') || '3', 10), 2), 50);
    const role = (url.searchParams.get('role') || 'all').toLowerCase(); // all|csuite|directors|owners
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '30', 10), 1), 200);

    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceStr = since.toISOString().slice(0, 10);

    let roleFilter = '';
    if (role === 'csuite') roleFilter = `AND (title LIKE '%CEO%' OR title LIKE '%CFO%' OR title LIKE '%COO%' OR title LIKE '%President%' OR title LIKE '%Chief%')`;
    else if (role === 'directors') roleFilter = `AND (title LIKE '%Director%')`;
    else if (role === 'owners') roleFilter = `AND (title LIKE '%10%%' OR title LIKE '%owner%')`;

    const cacheKey = `crossticker:${days}:${minTickers}:${role}:${limit}`;
    try {
      const cached = await env.CACHE?.get(cacheKey, 'json');
      if (cached) return jsonResponse(cached, 200, origin);
    } catch {}

    const query = `
      SELECT
        insider,
        MAX(title) AS title,
        COUNT(DISTINCT ticker) AS tickerCount,
        GROUP_CONCAT(DISTINCT ticker) AS tickersCsv,
        COUNT(*) AS txCount,
        SUM(CASE WHEN trans_type = 'buy'  THEN COALESCE(value, 0) ELSE 0 END) AS buyValue,
        SUM(CASE WHEN trans_type = 'sell' THEN COALESCE(value, 0) ELSE 0 END) AS sellValue,
        MAX(trans_date) AS lastDate
      FROM insider_transactions_history
      WHERE trans_date >= ?
        AND insider IS NOT NULL AND insider != ''
        AND ticker IS NOT NULL AND ticker != ''
        AND trans_type IN ('buy', 'sell')
        ${roleFilter}
      GROUP BY insider
      HAVING tickerCount >= ?
      LIMIT 500
    `;
    const rows = (await env.HISTORY.prepare(query).bind(sinceStr, minTickers).all()).results || [];

    const items = rows.map(r => {
      const buyValue = r.buyValue || 0;
      const sellValue = r.sellValue || 0;
      return {
        insider: r.insider,
        title: r.title || '',
        tickerCount: r.tickerCount || 0,
        tickers: (r.tickersCsv || '').split(',').filter(Boolean),
        txCount: r.txCount || 0,
        buyValue,
        sellValue,
        netValue: buyValue - sellValue,
        lastDate: r.lastDate,
      };
    });

    // Tri : nb tickers DESC puis volume total DESC
    items.sort((a, b) => {
      if (b.tickerCount !== a.tickerCount) return b.tickerCount - a.tickerCount;
      return (Math.abs(b.buyValue) + Math.abs(b.sellValue)) - (Math.abs(a.buyValue) + Math.abs(a.sellValue));
    });

    const result = {
      total: items.length,
      items: items.slice(0, limit),
      filters: { days, minTickers, role, limit },
      generatedAt: new Date().toISOString(),
    };

    try { await env.CACHE?.put(cacheKey, JSON.stringify(result), { expirationTtl: 900 }); } catch {}
    return jsonResponse(result, 200, origin);
  } catch (e) {
    return jsonResponse({ error: 'insider-crossticker query failed', detail: String(e && e.message || e) }, 500, origin);
  }
}

// ============================================================
// SIGNAL DETAIL : Transactions individuelles d'un cluster
// GET /api/signals/insider-cluster-detail?ticker=AEHR&days=90
// Retourne TOUTES les transactions insider pour ce ticker sur la fenetre,
// triees par date DESC (une ligne par transaction, pas agrege par insider).
// Utilise pour l'ecran deplie d'un cluster.
// ============================================================
async function handleSignalsInsiderClusterDetail(url, env, origin) {
  if (!env.HISTORY) return jsonResponse({ error: 'D1 not configured' }, 503, origin);
  try {
    const ticker = (url.searchParams.get('ticker') || '').toUpperCase().trim();
    if (!ticker) return jsonResponse({ error: 'missing ticker parameter' }, 400, origin);
    const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '90', 10), 1), 365);

    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceStr = since.toISOString().slice(0, 10);

    const cacheKey = `clusterdetail:${ticker}:${days}`;
    try {
      const cached = await env.CACHE?.get(cacheKey, 'json');
      if (cached) return jsonResponse(cached, 200, origin);
    } catch {}

    const query = `
      SELECT
        trans_date, filing_date, insider, title, trans_type,
        shares, price, value, source, accession
      FROM insider_transactions_history
      WHERE ticker = ?
        AND trans_date >= ?
        AND insider IS NOT NULL AND insider != ''
      ORDER BY trans_date DESC, filing_date DESC
      LIMIT 500
    `;
    const rows = (await env.HISTORY.prepare(query).bind(ticker, sinceStr).all()).results || [];

    const transactions = rows.map(r => ({
      transDate: r.trans_date,
      filingDate: r.filing_date,
      insider: r.insider,
      title: r.title || '',
      transType: r.trans_type || 'other',
      shares: r.shares || 0,
      price: r.price || 0,
      value: r.value || 0,
      source: r.source || '',
      accession: r.accession || '',
    }));

    const result = {
      ticker,
      days,
      total: transactions.length,
      transactions,
      generatedAt: new Date().toISOString(),
    };

    try { await env.CACHE?.put(cacheKey, JSON.stringify(result), { expirationTtl: 900 }); } catch {}
    return jsonResponse(result, 200, origin);
  } catch (e) {
    return jsonResponse({ error: 'insider-cluster-detail query failed', detail: String(e && e.message || e) }, 500, origin);
  }
}

// ============================================================
// SIGNAL DETAIL : Score movers (Lot 2 — stub pour route, implémenté plus tard)
// ============================================================
async function handleSignalsScoreMovers(url, env, origin) {
  if (!env.HISTORY) return jsonResponse({ error: 'D1 not configured' }, 503, origin);
  try {
    const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '7', 10), 1), 90);
    const direction = (url.searchParams.get('direction') || 'all').toLowerCase(); // all|up|down
    const minDelta = Math.max(parseInt(url.searchParams.get('minDelta') || '3', 10), 1);
    const sort = (url.searchParams.get('sort') || 'delta').toLowerCase();

    // Prend les 2 plus récentes entrées de chaque ticker dans la fenêtre days
    const query = `
      WITH ranked AS (
        SELECT ticker, date, total,
               ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS rn
        FROM score_history
        WHERE date >= date('now', ?)
      )
      SELECT
        a.ticker,
        a.total AS scoreNow,
        b.total AS scorePrev,
        a.date AS dateNow,
        b.date AS datePrev,
        (a.total - b.total) AS delta
      FROM ranked a
      LEFT JOIN ranked b ON a.ticker = b.ticker AND b.rn = 2
      WHERE a.rn = 1 AND b.total IS NOT NULL
        AND ABS(a.total - b.total) >= ?
      LIMIT 500
    `;
    const rows = (await env.HISTORY.prepare(query).bind(`-${days + 1} days`, minDelta).all()).results || [];

    let items = rows.map(r => ({
      ticker: r.ticker,
      scoreNow: r.scoreNow,
      scorePrev: r.scorePrev,
      delta: r.delta,
      dateNow: r.dateNow,
      datePrev: r.datePrev,
    }));

    if (direction === 'up') items = items.filter(i => i.delta > 0);
    else if (direction === 'down') items = items.filter(i => i.delta < 0);

    if (sort === 'abs') items.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    else if (sort === 'score') items.sort((a, b) => b.scoreNow - a.scoreNow);
    else items.sort((a, b) => (b.delta || 0) - (a.delta || 0)); // defaut : delta desc

    return jsonResponse({
      total: items.length,
      items: items.slice(0, 200),
      filters: { days, direction, minDelta, sort },
      generatedAt: new Date().toISOString(),
    }, 200, origin);
  } catch (e) {
    return jsonResponse({ error: 'score-movers query failed', detail: String(e && e.message || e) }, 500, origin);
  }
}

// ============================================================
// SIGNAL DETAIL : ETF rotations (Lot 3 — stub pour route, implémenté plus tard)
// ============================================================
async function handleSignalsEtfRotations(url, env, origin) {
  if (!env.HISTORY) return jsonResponse({ error: 'D1 not configured' }, 503, origin);
  try {
    const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '7', 10), 1), 90);
    const etfFilter = (url.searchParams.get('etf') || '').toUpperCase();
    const typeFilter = (url.searchParams.get('type') || 'all').toLowerCase();
    const minDelta = parseFloat(url.searchParams.get('minDelta') || '0.3');

    const query = `
      WITH latest_two AS (
        SELECT etf_symbol, ticker, date, weight,
               ROW_NUMBER() OVER (PARTITION BY etf_symbol, ticker ORDER BY date DESC) AS rn
        FROM etf_snapshots
      )
      SELECT
        a.etf_symbol AS etf,
        a.ticker,
        a.weight AS currWeight,
        b.weight AS prevWeight,
        a.date AS dateNow,
        b.date AS datePrev,
        (a.weight - COALESCE(b.weight, 0)) AS delta
      FROM latest_two a
      LEFT JOIN latest_two b ON a.etf_symbol = b.etf_symbol AND a.ticker = b.ticker AND b.rn = 2
      WHERE a.rn = 1 AND b.weight IS NOT NULL
        AND ABS(a.weight - b.weight) >= ?
        ${etfFilter ? "AND a.etf_symbol = ?" : ""}
      LIMIT 500
    `;
    const prep = etfFilter
      ? env.HISTORY.prepare(query).bind(minDelta, etfFilter)
      : env.HISTORY.prepare(query).bind(minDelta);
    const rows = (await prep.all()).results || [];

    let items = rows.map(r => ({
      etf: r.etf,
      ticker: r.ticker,
      currWeight: r.currWeight,
      prevWeight: r.prevWeight,
      delta: r.delta,
      dateNow: r.dateNow,
      datePrev: r.datePrev,
      status: r.prevWeight === 0 ? 'new' : r.currWeight === 0 ? 'exit' : r.delta > 0 ? 'increased' : 'decreased',
    }));

    if (typeFilter !== 'all') items = items.filter(i => i.status === typeFilter);
    items.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    return jsonResponse({
      total: items.length,
      items: items.slice(0, 200),
      filters: { days, etf: etfFilter || 'all', type: typeFilter, minDelta },
      generatedAt: new Date().toISOString(),
    }, 200, origin);
  } catch (e) {
    return jsonResponse({ error: 'etf-rotations query failed', detail: String(e && e.message || e) }, 500, origin);
  }
}

// ============================================================
// HISTORIQUE D1 : transactions insider long-terme (depasse la fenetre 90j du KV)
// GET /api/history/insider?ticker=AAPL[&days=365][&type=buy|sell][&insider=nom][&role=CEO][&limit=500]
// Retourne : { ticker, days, count, transactions: [...] }
// ============================================================
async function handleHistoryInsider(url, env, origin) {
  const tickerRaw = (url.searchParams.get('ticker') || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '');
  // Le client peut envoyer ticker=ANY comme sentinelle pour "pas de filtre ticker" ;
  // on le traite comme absent.
  const ticker = (tickerRaw === 'ANY' || tickerRaw === 'ALL') ? '' : tickerRaw;
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '365', 10), 7), 3650);
  const typeFilter = (url.searchParams.get('type') || '').toLowerCase();
  const insiderFilter = (url.searchParams.get('insider') || '').trim();
  const roleFilter = (url.searchParams.get('role') || '').trim();
  const source = (url.searchParams.get('source') || '').toUpperCase();
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '500', 10), 1), 5000);
  if (!env.HISTORY) return jsonResponse({ error: 'D1 binding not configured' }, 503, origin);
  // Exige au moins UN filtre pour eviter les requetes "return everything"
  if (!ticker && !insiderFilter && !typeFilter && !roleFilter && !source) {
    return jsonResponse({ error: 'Au moins un filtre requis (ticker, insider, type, role, ou source)' }, 400, origin);
  }

  try {
    const conditions = ["filing_date >= date('now', ?)"];
    const args = [`-${days} days`];
    if (ticker) { conditions.push('ticker = ?'); args.push(ticker); }
    if (typeFilter && ['buy', 'sell', 'other', 'option-exercise'].includes(typeFilter)) {
      conditions.push('trans_type = ?'); args.push(typeFilter);
    }
    if (insiderFilter) {
      conditions.push('insider LIKE ?');
      args.push(`%${insiderFilter}%`);
    }
    if (roleFilter) {
      conditions.push('title LIKE ?');
      args.push(`%${roleFilter}%`);
    }
    if (source && ['SEC', 'BAFIN', 'AMF', 'FCA', 'SEDI'].includes(source)) {
      conditions.push('source = ?'); args.push(source);
    }
    args.push(limit);

    const sql = `SELECT filing_date, trans_date, source, ticker, company, insider, title,
                        trans_type, shares, price, value, shares_after
                 FROM insider_transactions_history
                 WHERE ${conditions.join(' AND ')}
                 ORDER BY filing_date DESC, trans_date DESC
                 LIMIT ?`;
    const result = await env.HISTORY.prepare(sql).bind(...args).all();
    const rows = result.results || [];

    return jsonResponse({
      ticker: ticker || null,
      days,
      filters: {
        type: typeFilter || null,
        insider: insiderFilter || null,
        role: roleFilter || null,
        source: source || null,
      },
      count: rows.length,
      limit,
      transactions: rows,
    }, 200, origin);
  } catch (e) {
    return jsonResponse({ error: 'D1 insider history query failed', detail: String(e && e.message || e) }, 500, origin);
  }
}

// ============================================================
// HISTORIQUE D1 : stats agregees pour un ticker
// GET /api/history/insider-stats?ticker=AAPL[&days=365]
// Retourne : nb tx, volume buy/sell, nb insiders uniques, top 10 insiders par volume
// ============================================================
async function handleHistoryInsiderStats(url, env, origin) {
  const ticker = (url.searchParams.get('ticker') || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '');
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '365', 10), 7), 3650);
  if (!ticker) return jsonResponse({ error: 'Missing ticker' }, 400, origin);
  if (!env.HISTORY) return jsonResponse({ error: 'D1 binding not configured' }, 503, origin);

  try {
    // Stats globales par type
    const statsRes = await env.HISTORY.prepare(
      `SELECT trans_type, COUNT(*) as cnt, SUM(value) as total_value, SUM(shares) as total_shares
       FROM insider_transactions_history
       WHERE ticker = ? AND filing_date >= date('now', ?)
       GROUP BY trans_type`
    ).bind(ticker, `-${days} days`).all();

    const byType = {};
    for (const r of (statsRes.results || [])) {
      byType[r.trans_type] = {
        count: r.cnt,
        totalValue: r.total_value || 0,
        totalShares: r.total_shares || 0,
      };
    }

    // Insiders uniques
    const uniqueRes = await env.HISTORY.prepare(
      `SELECT COUNT(DISTINCT insider) as cnt
       FROM insider_transactions_history
       WHERE ticker = ? AND filing_date >= date('now', ?)`
    ).bind(ticker, `-${days} days`).first();

    // Top 10 insiders par volume (buy + sell)
    const topRes = await env.HISTORY.prepare(
      `SELECT insider, title,
              SUM(CASE WHEN trans_type='buy' THEN value ELSE 0 END) as buy_value,
              SUM(CASE WHEN trans_type='sell' THEN value ELSE 0 END) as sell_value,
              COUNT(*) as tx_count
       FROM insider_transactions_history
       WHERE ticker = ? AND filing_date >= date('now', ?)
         AND trans_type IN ('buy','sell')
       GROUP BY insider
       ORDER BY (buy_value + sell_value) DESC
       LIMIT 10`
    ).bind(ticker, `-${days} days`).all();

    return jsonResponse({
      ticker,
      days,
      buy: byType.buy || { count: 0, totalValue: 0, totalShares: 0 },
      sell: byType.sell || { count: 0, totalValue: 0, totalShares: 0 },
      other: byType.other || { count: 0, totalValue: 0, totalShares: 0 },
      optionExercise: byType['option-exercise'] || { count: 0, totalValue: 0, totalShares: 0 },
      uniqueInsiders: uniqueRes?.cnt || 0,
      topInsiders: topRes.results || [],
    }, 200, origin);
  } catch (e) {
    return jsonResponse({ error: 'D1 insider stats query failed', detail: String(e && e.message || e) }, 500, origin);
  }
}

// ============================================================
// HISTORIQUE D1 : classement insiders par activite (embryon du Top Insiders Phase 2)
// GET /api/history/insider-top[&period=1y|3y|5y][&role=CEO][&type=buy][&limit=50]
// Note : pour un ROI reel il faudra joindre sur les prix historiques (Phase 2).
// Ici on expose deja le ranking par volume total + nombre de transactions.
// ============================================================
async function handleHistoryInsiderTop(url, env, origin) {
  const period = (url.searchParams.get('period') || '1y').toLowerCase();
  const roleFilter = (url.searchParams.get('role') || '').trim();
  const typeFilter = (url.searchParams.get('type') || 'buy').toLowerCase();
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10), 1), 200);
  if (!env.HISTORY) return jsonResponse({ error: 'D1 binding not configured' }, 503, origin);

  const periodDays = { '30d': 30, '90d': 90, '6m': 180, '1y': 365, '3y': 1095, '5y': 1825 }[period] || 365;

  try {
    const conditions = ["filing_date >= date('now', ?)", "trans_type = ?", "value IS NOT NULL", "value > 0"];
    const args = [`-${periodDays} days`, typeFilter];
    if (roleFilter) {
      conditions.push('title LIKE ?');
      args.push(`%${roleFilter}%`);
    }
    args.push(limit);

    const sql = `SELECT insider, title,
                        COUNT(DISTINCT ticker) as tickers,
                        COUNT(*) as tx_count,
                        SUM(value) as total_value,
                        MAX(filing_date) as last_activity
                 FROM insider_transactions_history
                 WHERE ${conditions.join(' AND ')}
                 GROUP BY insider
                 HAVING tx_count >= 2
                 ORDER BY total_value DESC
                 LIMIT ?`;
    const result = await env.HISTORY.prepare(sql).bind(...args).all();

    return jsonResponse({
      period,
      periodDays,
      type: typeFilter,
      role: roleFilter || null,
      count: (result.results || []).length,
      insiders: result.results || [],
      note: 'ROI-based ranking requires historical prices (Phase 2). Here: total value ranking.',
    }, 200, origin);
  } catch (e) {
    return jsonResponse({ error: 'D1 insider top query failed', detail: String(e && e.message || e) }, 500, origin);
  }
}

// Normalisation pour matcher des noms (suppression suffixes corp/inc/sa, espaces, casse)
// Mapping name normalise -> ticker pour les megas a plusieurs classes,
// les ADR, et les valeurs absentes des transactions insiders (parce que
// les insiders deposent rarement sur les megacaps super-liquides).
const KNOWN_TICKERS = {
  'ALPHABET': 'GOOGL',
  'BERKSHIRE HATHAWAY DEL': 'BRK.B',
  'META PLATFORMS': 'META',
  'AMAZON COM': 'AMZN',
  'APPLE': 'AAPL',
  'MICROSOFT': 'MSFT',
  'NVIDIA': 'NVDA',
  'TESLA': 'TSLA',
  'BROADCOM': 'AVGO',
  'JPMORGAN CHASE & CO': 'JPM',
  'JOHNSON & JOHNSON': 'JNJ',
  'EXXON MOBIL': 'XOM',
  'PROCTER & GAMBLE': 'PG',
  'VISA': 'V',
  'MASTERCARD': 'MA',
  'COCA COLA CO': 'KO',
  'PEPSICO': 'PEP',
  'WALMART': 'WMT',
  'COSTCO WHOLESALE': 'COST',
  'ELI LILLY & CO': 'LLY',
  'UNITEDHEALTH': 'UNH',
  'NETFLIX': 'NFLX',
  'ADOBE': 'ADBE',
  'ORACLE': 'ORCL',
  'SALESFORCE': 'CRM',
  'ADVANCED MICRO DEVICES': 'AMD',
  'INTEL': 'INTC',
  'QUALCOMM': 'QCOM',
  'CISCO SYSTEMS': 'CSCO',
  'BANK OF AMERICA': 'BAC',
  'WELLS FARGO': 'WFC',
  'GOLDMAN SACHS': 'GS',
  'MORGAN STANLEY': 'MS',
  'CITIGROUP': 'C',
  'HOME DEPOT': 'HD',
  'MCDONALDS': 'MCD',
  'NIKE': 'NKE',
  'STARBUCKS': 'SBUX',
  'BOEING': 'BA',
  'CATERPILLAR': 'CAT',
  'DEERE & CO': 'DE',
  'GENERAL ELECTRIC': 'GE',
  'CHEVRON': 'CVX',
  'CONOCOPHILLIPS': 'COP',
  'AT&T': 'T',
  'VERIZON COMMUNICATIONS': 'VZ',
  'WALT DISNEY': 'DIS',
  'PFIZER': 'PFE',
  'MERCK & CO': 'MRK',
  'ABBVIE': 'ABBV',
  'NOVO NORDISK A S ADR': 'NVO',
  'TAIWAN SEMICONDUCTOR': 'TSM',
  'PALANTIR TECHNOLOGIES': 'PLTR',
  'COINBASE GLOBAL': 'COIN',
  'SHOPIFY': 'SHOP',
  'ROBLOX': 'RBLX',
  'PALO ALTO NETWORKS': 'PANW',
  'CROWDSTRIKE': 'CRWD',
  'DATADOG': 'DDOG',
  'SNOWFLAKE': 'SNOW',
  'CLOUDFLARE': 'NET',
  'MONGODB': 'MDB',
  'UBER TECHNOLOGIES': 'UBER',
  'AIRBNB': 'ABNB',
  'SPOTIFY TECHNOLOGY': 'SPOT',
  'BLOCK': 'SQ',
  'PAYPAL HOLDINGS': 'PYPL',
  'INTUIT': 'INTU',
  'SERVICENOW': 'NOW',
};

// Construit un Map(normalizedName -> ticker) en combinant :
// 1. KNOWN_TICKERS hardcodes (priorite : Alphabet -> GOOGL pas GOOG)
// 2. Transactions insiders (couvre les autres tickers cotes US/EU)
async function buildTickerByName(env) {
  const m = new Map();
  for (const [name, ticker] of Object.entries(KNOWN_TICKERS)) {
    m.set(name, ticker);
  }
  try {
    const tx = await env.CACHE.get('insider-transactions', 'json');
    if (tx && Array.isArray(tx.transactions)) {
      for (const t of tx.transactions) {
        const tk = (t.ticker || '').trim().toUpperCase();
        const cn = normalizeForMatch(t.company);
        if (tk && cn && !m.has(cn)) m.set(cn, tk);
      }
    }
  } catch (_) {}
  return m;
}

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
    // Pages principales (home en FR + EN signales via xhtml:link hreflang)
    urls.push(`<url>
<loc>${SITE}/</loc>
<xhtml:link rel="alternate" hreflang="fr" href="${SITE}/"/>
<xhtml:link rel="alternate" hreflang="en" href="${SITE}/?lang=en"/>
<xhtml:link rel="alternate" hreflang="x-default" href="${SITE}/"/>
<lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>1.0</priority>
</url>`);

    // Pages statiques legales (RGPD / conformite / mentions) — faible priorite mais indexables
    const staticPages = [
      { path: '/legal.html',   freq: 'monthly', prio: '0.3' },
      { path: '/privacy.html', freq: 'monthly', prio: '0.3' },
      { path: '/cgv.html',     freq: 'monthly', prio: '0.3' },
    ];
    for (const sp of staticPages) {
      urls.push(`<url>
<loc>${SITE}${sp.path}</loc>
<lastmod>${today}</lastmod><changefreq>${sp.freq}</changefreq><priority>${sp.prio}</priority>
</url>`);
    }

    // Une URL SSR par ticker avec hreflang FR + EN (Googlebot indexera les 2)
    for (const t of tickers) {
      const tk = encodeURIComponent(t.ticker);
      urls.push(`<url>
<loc>${SITE}/a/${tk}</loc>
<xhtml:link rel="alternate" hreflang="fr" href="${SITE}/a/${tk}"/>
<xhtml:link rel="alternate" hreflang="en" href="${SITE}/a/${tk}?lang=en"/>
<xhtml:link rel="alternate" hreflang="x-default" href="${SITE}/a/${tk}"/>
<lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.8</priority>
</url>`);
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>`;

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
function signalFromScoreSsr(total, lang = 'fr') {
  // SSR_I18N defini plus loin dans le fichier ; fallback FR si pas dispo
  const t = (k) => (typeof SSR_I18N !== 'undefined' && SSR_I18N[lang] && SSR_I18N[lang][k]) || k;
  if (total >= 75) return { label: t('sig_strong_buy') || 'ACHAT FORT', color: '#10B981' };
  if (total >= 60) return { label: t('sig_buy') || 'ACHAT', color: '#34D399' };
  if (total >= 40) return { label: t('sig_neutral') || 'NEUTRE', color: '#9CA3AF' };
  if (total >= 25) return { label: t('sig_sell') || 'VENTE', color: '#F87171' };
  return { label: t('sig_strong_sell') || 'VENTE FORTE', color: '#EF4444' };
}

// ============================================================
// Radar SVG pour le SSR Kairos Score (statique, pas d'animation JS)
// Affiche le radar 8 axes si breakdown dispo, sinon un gauge simple.
// ============================================================
function renderKairosRadarSsr(scoreObj, sig) {
  const total = (scoreObj && typeof scoreObj.total === 'number') ? scoreObj.total : 0;
  const color = sig.color;
  const breakdown = scoreObj?.breakdown || null;

  // Si pas de breakdown (vue publique tronquee) : gauge simple
  if (!breakdown) {
    const deg = Math.max(0, Math.min(100, total)) * 3.6;
    return `
      <div style="flex:0 0 220px;position:relative;z-index:1">
        <div style="width:200px;height:200px;border-radius:50%;background:conic-gradient(${color} ${deg}deg, rgba(255,255,255,0.08) 0deg);position:relative;margin:0 auto;box-shadow:0 12px 24px ${color}33">
          <div style="position:absolute;inset:12px;background:#0A0F1E;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-direction:column">
            <div style="font-family:'Space Grotesk',sans-serif;font-size:48px;font-weight:700;color:${color};line-height:1;letter-spacing:-0.02em">${total}</div>
            <div style="font-size:11px;color:#6B7280;letter-spacing:0.12em;margin-top:4px">/ 100</div>
          </div>
        </div>
      </div>
    `;
  }

  // Version complete avec radar (disponible si breakdown present)
  const axesOrder = [
    { key: 'insider',    short: 'INS' },
    { key: 'smartMoney', short: 'HF'  },
    { key: 'momentum',   short: 'MOM' },
    { key: 'earnings',   short: 'EPS' },
    { key: 'analyst',    short: 'ANA' },
    { key: 'valuation',  short: 'VAL' },
    { key: 'health',     short: 'FIN' },
    { key: 'govGuru',    short: 'GOV' },
  ];
  const CX = 200, CY = 200, R = 140;
  const N = axesOrder.length;
  const points = [];
  const grid = [];
  axesOrder.forEach((axis, i) => {
    const angle = (-Math.PI / 2) + (i * 2 * Math.PI / N);
    const b = breakdown[axis.key];
    const pctFill = (b && b.max > 0) ? (b.score / b.max) : 0;
    const r = R * Math.max(0.05, Math.min(1, pctFill));
    const x = CX + r * Math.cos(angle);
    const y = CY + r * Math.sin(angle);
    points.push({ x, y, angle, short: axis.short, score: b?.score || 0, max: b?.max || 0 });
    grid.push({ x: CX + R * Math.cos(angle), y: CY + R * Math.sin(angle), angle });
  });

  const polyPath = points.map(p => `${p.x},${p.y}`).join(' ');
  const rings = [0.25, 0.5, 0.75, 1.0].map(frac => {
    const pts = grid.map(p => {
      const x = CX + (R * frac) * Math.cos(p.angle);
      const y = CY + (R * frac) * Math.sin(p.angle);
      return `${x},${y}`;
    }).join(' ');
    return `<polygon points="${pts}" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>`;
  }).join('');
  const axes = grid.map(p => `<line x1="${CX}" y1="${CY}" x2="${p.x}" y2="${p.y}" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>`).join('');

  const labels = points.map(p => {
    const r = R + 24;
    const x = CX + r * Math.cos(p.angle);
    const y = CY + r * Math.sin(p.angle);
    let anchor = 'middle';
    if (Math.cos(p.angle) > 0.3) anchor = 'start';
    else if (Math.cos(p.angle) < -0.3) anchor = 'end';
    return `<text x="${x}" y="${y + 4}" text-anchor="${anchor}" font-size="11" font-weight="600" fill="${color}" font-family="'Space Grotesk', sans-serif">${p.short}</text>`;
  }).join('');

  const dots = points.map(p => `<circle cx="${p.x}" cy="${p.y}" r="3.5" fill="${color}" stroke="#0A0F1E" stroke-width="1.5"/>`).join('');

  return `
    <div style="flex:0 0 280px;position:relative;z-index:1">
      <svg viewBox="0 0 400 400" style="width:100%;max-width:300px;height:auto;display:block;filter:drop-shadow(0 10px 20px ${color}55)">
        ${axes}
        ${rings}
        <polygon points="${polyPath}" fill="${color}" fill-opacity="0.22" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
        ${dots}
        ${labels}
        <text x="${CX}" y="${CY - 8}" text-anchor="middle" font-size="48" font-weight="700" fill="${color}" font-family="'Space Grotesk', sans-serif" letter-spacing="-0.02em">${total}</text>
        <text x="${CX}" y="${CY + 14}" text-anchor="middle" font-size="10" fill="#6B7280" font-family="'Space Grotesk', sans-serif" letter-spacing="0.12em">/ 100</text>
      </svg>
    </div>
  `;
}

// Mini dictionnaire i18n inline pour le SSR (pas besoin de charger un module
// cote serveur, on duplique les cles strictement necessaires).
const SSR_I18N = {
  fr: {
    not_found_title: 'Ticker introuvable — Kairos Insider',
    not_found_h1: 'Ticker {ticker} introuvable',
    not_found_p: 'Cette action n\'est pas couverte par Kairos Insider.',
    back_to_dashboard: 'Retour au dashboard',
    description: 'Analyse smart money de {name} ({ticker}){sector}. Kairos Score : {score}/100 ({signal}). {insiders} transactions insiders, {funds} hedge funds. Cours : {price}.',
    open_full: 'Ouvrir l\'analyse complète →',
    score_intro: 'Score composite qui agrège <strong>8 dimensions du smart money</strong> : initiés (SEC/AMF/BaFin), hedge funds, politiciens & gourous, momentum du cours, valorisation, consensus analystes, santé financière, momentum des résultats. Plus le score est élevé, plus le consensus des signaux institutionnels est favorable à l\'achat.',
    breakdown_locked: '💡 <strong>Décomposition détaillée</strong> (les 8 sous-scores) disponible dans le dashboard Premium.',
    about: 'À propos de {name}',
    key_info: 'Informations clés',
    info_ceo: 'PDG', info_founded: 'Fondée en', info_hq: 'Siège', info_employees: 'Employés',
    info_marketcap: 'Capitalisation', info_pe: 'PER', info_div: 'Rendement div.', info_ipo: 'IPO',
    insiders_h2: '🕴️ Activité des initiés (90 jours)',
    insiders_p: '<strong>{total}</strong> transactions — dont <strong>{buys}</strong> achats déclarés par les dirigeants de {name} auprès de la SEC / AMF / BaFin.',
    funds_h2: '🏦 Hedge Funds',
    funds_p: '<strong>{total}</strong> fonds institutionnels déclarent une position sur {ticker} dans leur dernière déclaration trimestrielle SEC.',
    news_h2: '📰 Actualités récentes',
    news_p: '<strong>{total}</strong> articles récents sur {ticker}.',
    trends_h2: '🔎 Intérêt de recherche Google',
    trends_subtitle_part1: '{interest}/100 — intérêt actuel',
    trends_spike_up: '+{spike}% vs semaine dernière 📈',
    trends_spike_down: '{spike}% vs semaine dernière 📉',
    trends_spike_stable: 'stable ({spike}%)',
    trends_trend_label: 'Tendance :',
    trend_rising: '↗️ en hausse', trend_falling: '↘️ en baisse', trend_stable: '→ stable',
    trends_helper: 'Volume de recherche Google pour "{ticker}" sur 90 jours (échelle 0-100, 100 = pic de la période).',
    trends_avg_max: 'Moyenne 90j : {avg}/100, pic max : {max}/100.',
    paywall_h2: '🔓 Débloquez l\'analyse complète',
    paywall_p: 'Cette page publique ne montre qu\'un extrait. L\'analyse complète de <strong>{ticker}</strong> sur le dashboard Kairos Insider inclut :',
    paywall_f1: '✅ Kairos Score complet (radar 8 axes + synthèse)',
    paywall_f2: '✅ Historique des {total} transactions insiders sur 90j',
    paywall_f3: '✅ Tous les {total} hedge funds (sur 200+ suivis)',
    paywall_f4: '✅ 11 ETF thématiques (ARK, BUZZ, NANC, GOP, JEPI…)',
    paywall_f5: '✅ Hot Stocks Google Trends',
    paywall_f6: '✅ Historique 2 ans : AUM + rotations',
    paywall_f7: '✅ Fondamentaux (P/E, PEG, EV/EBITDA, ROE…)',
    paywall_f8: '✅ Santé financière (Altman Z, Piotroski F)',
    paywall_f9: '✅ Concurrents sectoriels + earnings 6 trim.',
    paywall_cta: 'Voir l\'analyse complète →',
    paywall_terms: 'Inscription gratuite · Premium 29€/mois sans engagement',
    footer_tagline: 'kairosinsider.fr · La plateforme francophone du smart money',
    footer_sources: 'Données SEC EDGAR, AMF, BaFin, Yahoo Finance — mises à jour quotidiennement',
    // NEW visual pack
    stats_h2: '📊 La donnée derrière cette analyse',
    stats_insiders: 'Transactions insiders',
    stats_insiders_sub: 'SEC Form 4 · AMF · BaFin — 90 jours glissants',
    stats_funds: 'Hedge funds suivis',
    stats_funds_sub: '200+ fonds 13F SEC, mis a jour trimestriellement',
    stats_etfs: 'ETF thematiques',
    stats_etfs_sub: 'ARK, NANC, GOP, GURU, BUZZ, JEPI, ITA…',
    stats_fresh: 'Frequence',
    stats_fresh_sub: 'Pipeline quotidien 5h UTC · Historique 2 ans en base',
    features_h2: '🧠 Ce qui fait Kairos Insider',
    features_p: 'Au-dela des donnees brutes, nous agregeons et scoring tout le signal smart money pour vous donner une vue unique.',
    feat1_title: 'Kairos Score 0-100',
    feat1_desc: 'Score composite sur 8 dimensions : insiders · hedge funds · politiciens · momentum · valorisation · sante · analystes · earnings.',
    feat2_title: 'Clusters Insiders',
    feat2_desc: 'Detection automatique quand 3+ dirigeants achetent la meme action simultanement — le signal le plus fiable historiquement.',
    feat3_title: 'Hedge funds 13F',
    feat3_desc: 'Berkshire (Buffett), Pershing Square (Ackman), Tiger Global, Bridgewater + 200 autres. Qui achete quoi, chaque trimestre.',
    feat4_title: 'Rotations ETF',
    feat4_desc: 'NANC & GOP (Pelosi & republicains), GURU (top hedge funds), ARK (Cathie Wood). Voyez qui entre et sort chaque semaine.',
    feat5_title: 'Google Trends',
    feat5_desc: 'Detectez les small caps dont l\'interet retail explose avant le reste du marche. 100+ tickers surveilles.',
    feat6_title: 'Alertes email',
    feat6_desc: 'Creez votre watchlist et recevez chaque matin a 8h le Brief des evenements sur VOS tickers.',
    trust_h2: 'Sources officielles · Donnees publiques',
    trust_sec: 'SEC EDGAR — Form 4 & 13F',
    trust_amf: 'AMF — Declarations dirigeants',
    trust_bafin: 'BaFin — Directors\' Dealings',
    trust_quote: 'Yahoo Finance · Alpha Vantage',
    cta_secondary_label: 'Analyser d\'autres tickers gratuitement',
    sig_strong_buy: 'ACHAT FORT', sig_buy: 'ACHAT', sig_neutral: 'NEUTRE', sig_sell: 'VENTE', sig_strong_sell: 'VENTE FORTE',
    session_change: 'sur la séance', ytd_label: 'depuis le 1er janvier', y1_label: 'sur 1 an',
    aperçu: 'Aperçu', top_funds: 'Top détenteurs',
  },
  en: {
    not_found_title: 'Ticker not found — Kairos Insider',
    not_found_h1: 'Ticker {ticker} not found',
    not_found_p: 'This stock is not covered by Kairos Insider.',
    back_to_dashboard: 'Back to dashboard',
    description: 'Smart money analysis of {name} ({ticker}){sector}. Kairos Score: {score}/100 ({signal}). {insiders} insider transactions, {funds} hedge funds. Price: {price}.',
    open_full: 'Open full analysis →',
    score_intro: 'Composite score aggregating <strong>8 smart money dimensions</strong>: insiders (SEC/AMF/BaFin), hedge funds, politicians & gurus, price momentum, valuation, analyst consensus, financial health, earnings momentum. The higher the score, the more favorable the institutional signals consensus.',
    breakdown_locked: '💡 <strong>Detailed breakdown</strong> (the 8 sub-scores) available in the Premium dashboard.',
    about: 'About {name}',
    key_info: 'Key info',
    info_ceo: 'CEO', info_founded: 'Founded', info_hq: 'HQ', info_employees: 'Employees',
    info_marketcap: 'Market cap', info_pe: 'P/E', info_div: 'Dividend yield', info_ipo: 'IPO',
    insiders_h2: '🕴️ Insider activity (90 days)',
    insiders_p: '<strong>{total}</strong> transactions — including <strong>{buys}</strong> buys declared by {name} executives to SEC / AMF / BaFin.',
    funds_h2: '🏦 Hedge Funds',
    funds_p: '<strong>{total}</strong> institutional funds report a position on {ticker} in their latest SEC quarterly filing.',
    news_h2: '📰 Recent news',
    news_p: '<strong>{total}</strong> recent articles on {ticker}.',
    trends_h2: '🔎 Google search interest',
    trends_subtitle_part1: '{interest}/100 — current interest',
    trends_spike_up: '+{spike}% vs last week 📈',
    trends_spike_down: '{spike}% vs last week 📉',
    trends_spike_stable: 'stable ({spike}%)',
    trends_trend_label: 'Trend:',
    trend_rising: '↗️ rising', trend_falling: '↘️ falling', trend_stable: '→ stable',
    trends_helper: 'Google search volume for "{ticker}" over 90 days (0-100 scale, 100 = period peak).',
    trends_avg_max: '90-day average: {avg}/100, peak max: {max}/100.',
    paywall_h2: '🔓 Unlock the full analysis',
    paywall_p: 'This public page only shows a preview. The full analysis of <strong>{ticker}</strong> on the Kairos Insider dashboard includes:',
    paywall_f1: '✅ Full Kairos Score (8-axis radar + synthesis)',
    paywall_f2: '✅ History of all {total} insider transactions over 90 days',
    paywall_f3: '✅ All {total} hedge funds (among 200+ tracked)',
    paywall_f4: '✅ 11 thematic ETFs (ARK, BUZZ, NANC, GOP, JEPI…)',
    paywall_f5: '✅ Hot Stocks Google Trends',
    paywall_f6: '✅ 2-year history: AUM + rotations',
    paywall_f7: '✅ Fundamentals (P/E, PEG, EV/EBITDA, ROE…)',
    paywall_f8: '✅ Financial health (Altman Z, Piotroski F)',
    paywall_f9: '✅ Sector peers + 6-quarter earnings',
    paywall_cta: 'See full analysis →',
    paywall_terms: 'Free signup · Premium €29/month no commitment',
    footer_tagline: 'kairosinsider.fr · The smart money platform',
    footer_sources: 'Data from SEC EDGAR, AMF, BaFin, Yahoo Finance — updated daily',
    // NEW visual pack
    stats_h2: '📊 The data behind this analysis',
    stats_insiders: 'Insider transactions',
    stats_insiders_sub: 'SEC Form 4 · AMF · BaFin — rolling 90 days',
    stats_funds: 'Hedge funds tracked',
    stats_funds_sub: '200+ 13F SEC funds, updated quarterly',
    stats_etfs: 'Thematic ETFs',
    stats_etfs_sub: 'ARK, NANC, GOP, GURU, BUZZ, JEPI, ITA…',
    stats_fresh: 'Frequency',
    stats_fresh_sub: 'Daily 5AM UTC pipeline · 2-year historical DB',
    features_h2: '🧠 What makes Kairos Insider',
    features_p: 'Beyond raw data, we aggregate and score every smart money signal to give you a unique view.',
    feat1_title: 'Kairos Score 0-100',
    feat1_desc: '8-dimension composite score: insiders · hedge funds · politicians · momentum · valuation · health · analysts · earnings.',
    feat2_title: 'Insider Clusters',
    feat2_desc: 'Automatic detection when 3+ executives buy the same stock simultaneously — historically the most reliable signal.',
    feat3_title: '13F Hedge Funds',
    feat3_desc: 'Berkshire (Buffett), Pershing Square (Ackman), Tiger Global, Bridgewater + 200 more. Who buys what, each quarter.',
    feat4_title: 'ETF Rotations',
    feat4_desc: 'NANC & GOP (Pelosi & Republicans), GURU (top hedge funds), ARK (Cathie Wood). See who enters and exits each week.',
    feat5_title: 'Google Trends',
    feat5_desc: 'Spot small caps whose retail interest explodes before the rest of the market. 100+ tickers monitored.',
    feat6_title: 'Email alerts',
    feat6_desc: 'Create your watchlist and receive every morning at 8am the Brief of events on YOUR tickers.',
    trust_h2: 'Official sources · Public data',
    trust_sec: 'SEC EDGAR — Form 4 & 13F',
    trust_amf: 'AMF — Executive filings',
    trust_bafin: 'BaFin — Directors\' Dealings',
    trust_quote: 'Yahoo Finance · Alpha Vantage',
    cta_secondary_label: 'Analyze other tickers for free',
    sig_strong_buy: 'STRONG BUY', sig_buy: 'BUY', sig_neutral: 'NEUTRAL', sig_sell: 'SELL', sig_strong_sell: 'STRONG SELL',
    session_change: 'today', ytd_label: 'YTD', y1_label: '1Y',
    aperçu: 'Preview', top_funds: 'Top holders',
  },
};
function ssrT(lang, key, vars) {
  const dict = SSR_I18N[lang] || SSR_I18N.fr;
  let s = dict[key] || SSR_I18N.fr[key] || key;
  if (vars) {
    for (const k in vars) s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), vars[k]);
  }
  return s;
}

async function handleActionSSR(rawTicker, env, lang = 'fr') {
  const ticker = String(rawTicker || '').toUpperCase().trim().replace(/[^A-Z0-9.\-]/g, '');
  if (!ticker || ticker.length > 12) {
    return new Response('Invalid ticker', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  // Normalise lang
  if (lang !== 'fr' && lang !== 'en') lang = 'fr';

  let data;
  try {
    data = await handleStockAnalysis(ticker, env, { publicView: true });
  } catch (e) {
    data = { error: 'Failed to load', detail: String(e && e.message || e) };
  }

  // Page d'erreur SSR (reste indexable)
  if (!data || data.error) {
    const html = `<!DOCTYPE html><html lang="${lang}"><head><meta charset="UTF-8"><title>${escHtmlSsr(ssrT(lang, 'not_found_title'))}</title><meta name="robots" content="noindex,follow"><style>body{font-family:system-ui;background:#0A0F1E;color:#F9FAFB;text-align:center;padding:80px 20px}a{color:#3B82F6}</style></head><body><h1>${ssrT(lang, 'not_found_h1', { ticker: escHtmlSsr(ticker) })}</h1><p>${ssrT(lang, 'not_found_p')}</p><p><a href="https://kairosinsider.fr/dashboard.html?lang=${lang}">${ssrT(lang, 'back_to_dashboard')}</a></p></body></html>`;
    return new Response(html, {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
    });
  }

  const name = data.company?.name || ticker;
  const sector = data.company?.sector || '';
  const score = data.score?.total || 0;
  const sig = signalFromScoreSsr(score, lang);
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
  const desc = ssrT(lang, 'description', {
    name, ticker,
    sector: sector ? ' — ' + sector : '',
    score: String(score),
    signal: sig.label,
    insiders: String(totalInsiderTx),
    funds: String(totalFunds),
    price: fmtCurrSsr(price, currency),
  });
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
    image: 'https://kairosinsider.fr/assets/og-image.png',
    url: canonical,
    author: { '@type': 'Organization', name: 'Kairos Insider', url: 'https://kairosinsider.fr' },
    publisher: {
      '@type': 'Organization',
      name: 'Kairos Insider',
      url: 'https://kairosinsider.fr',
      logo: { '@type': 'ImageObject', url: 'https://kairosinsider.fr/assets/logo-512.png' },
    },
    about: {
      '@type': 'Corporation',
      name: name,
      tickerSymbol: ticker,
      ...(data.company?.exchange && { exchange: data.company.exchange }),
      ...(data.company?.website && { url: data.company.website }),
      ...(data.company?.industry && { industry: data.company.industry }),
    },
    // NOTE: AggregateRating retire car non valide sur un parent Article
    // (Google Search Console error : "Type d'objet non valide pour parent_node").
    // Le Kairos Score reste affiche dans le titre meta (SERP) mais pas comme
    // "review snippet" structure.
  };

  const insiderTeaser = (data.insiders?.transactions || []).slice(0, 3).map(t => {
    const action = (t.type === 'P' || t.adType === 'A') ? 'Achat' : 'Vente';
    const who = escHtmlSsr(t.insider || 'Dirigeant');
    return `<li>${who} — <strong>${action}</strong>${t.date ? ' · ' + escHtmlSsr(t.date) : ''}</li>`;
  }).join('');

  const fundsTeaser = (data.smartMoney?.topFunds || []).slice(0, 5).map(f => {
    return `<li>${escHtmlSsr(f.fundName || f.cik || 'Hedge fund')}</li>`;
  }).join('');

  const newsTeaser = (data.news || []).slice(0, 3).map(n => {
    return `<li><strong>${escHtmlSsr(n.title || '')}</strong>${n.source ? ' <span style="opacity:0.6">· ' + escHtmlSsr(n.source) + '</span>' : ''}</li>`;
  }).join('');

  // URLs pour hreflang (SEO international : signaler les versions FR/EN)
  const baseUrl = `https://kairosinsider.fr/a/${encodeURIComponent(ticker)}`;
  const ogLocale = lang === 'en' ? 'en_US' : 'fr_FR';
  const altLocale = lang === 'en' ? 'fr_FR' : 'en_US';

  const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlSsr(title)}</title>
<meta name="description" content="${escHtmlSsr(desc)}">
<meta name="robots" content="index,follow">
<meta name="theme-color" content="#0A0F1E">
<link rel="canonical" href="${baseUrl}${lang === 'en' ? '?lang=en' : ''}">
<link rel="alternate" hreflang="fr" href="${baseUrl}">
<link rel="alternate" hreflang="en" href="${baseUrl}?lang=en">
<link rel="alternate" hreflang="x-default" href="${baseUrl}">
<link rel="icon" type="image/svg+xml" href="https://kairosinsider.fr/assets/logo.svg">

<meta property="og:type" content="article">
<meta property="og:locale" content="${ogLocale}">
<meta property="og:locale:alternate" content="${altLocale}">
<meta property="og:site_name" content="Kairos Insider">
<meta property="og:title" content="${escHtmlSsr(title)}">
<meta property="og:description" content="${escHtmlSsr(desc)}">
<meta property="og:url" content="${baseUrl}${lang === 'en' ? '?lang=en' : ''}">
<meta property="og:image" content="https://kairosinsider.fr/assets/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${escHtmlSsr(title)}">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escHtmlSsr(title)}">
<meta name="twitter:description" content="${escHtmlSsr(desc)}">
<meta name="twitter:image" content="https://kairosinsider.fr/assets/og-image.png">
<meta name="twitter:image:alt" content="${escHtmlSsr(title)}">

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
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;background:#0A0F1E;color:#F9FAFB;line-height:1.6;min-height:100vh;-webkit-font-smoothing:antialiased;background-image:radial-gradient(circle at 20% 10%,rgba(59,130,246,0.08),transparent 50%),radial-gradient(circle at 80% 40%,rgba(139,92,246,0.05),transparent 50%);background-attachment:fixed}
.container{max-width:960px;margin:0 auto;padding:40px 24px}
.nav{display:flex;justify-content:space-between;align-items:center;margin-bottom:40px;position:sticky;top:0;padding:16px 0;background:rgba(10,15,30,0.85);backdrop-filter:blur(12px);z-index:50;border-bottom:1px solid rgba(255,255,255,0.04)}
.logo{font-weight:700;font-size:20px;background:linear-gradient(135deg,#F9FAFB,#9CA3AF);-webkit-background-clip:text;color:transparent;text-decoration:none;display:inline-flex;align-items:center;gap:8px}
.logo svg{width:28px;height:28px}
.cta{padding:11px 22px;background:linear-gradient(135deg,#3B82F6,#8B5CF6);border-radius:10px;color:#fff;text-decoration:none;font-weight:600;font-size:14px;box-shadow:0 4px 20px rgba(59,130,246,0.3);transition:transform 0.15s}
.cta:hover{transform:translateY(-1px)}
.ticker-header{display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:20px;padding:36px;background:linear-gradient(135deg,rgba(59,130,246,0.12),rgba(139,92,246,0.06));border:1px solid rgba(255,255,255,0.1);border-radius:18px;margin-bottom:24px;position:relative;overflow:hidden}
.ticker-header::before{content:"";position:absolute;top:-50%;right:-20%;width:400px;height:400px;background:radial-gradient(circle,rgba(59,130,246,0.15) 0%,transparent 60%);pointer-events:none}
.ticker-symbol{font-size:46px;font-weight:700;letter-spacing:-1.5px;position:relative}
.ticker-name{font-size:18px;color:#9CA3AF;margin-top:4px;position:relative}
.badges{margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;position:relative}
.badge{font-size:12px;padding:5px 12px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08);border-radius:6px;color:#9CA3AF;font-weight:500}
.price-box{text-align:right;position:relative}
.price{font-size:34px;font-weight:600}
.change-up{color:#10B981}.change-down{color:#EF4444}
/* Stats bar : les 4 chiffres cles montrent la richesse de la donnee */
.stats-bar{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:24px}
.stat-card{padding:18px 20px;background:linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.01));border:1px solid rgba(255,255,255,0.08);border-radius:14px;transition:border-color 0.2s}
.stat-card:hover{border-color:rgba(59,130,246,0.3)}
.stat-value{font-size:26px;font-weight:700;letter-spacing:-0.5px;background:linear-gradient(135deg,#3B82F6,#8B5CF6);-webkit-background-clip:text;color:transparent;margin-bottom:4px}
.stat-label{font-size:12px;color:#D1D5DB;font-weight:600;margin-bottom:2px}
.stat-sub{font-size:11px;color:#6B7280;line-height:1.4}
/* Score card */
.score-card{display:flex;gap:24px;align-items:center;flex-wrap:wrap;padding:32px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.08);border-radius:16px;margin-bottom:24px}
.score-info h1{font-size:26px;margin-bottom:10px}
.signal{display:inline-block;padding:6px 14px;border-radius:20px;font-size:13px;font-weight:600;margin-bottom:10px}
/* Sections */
.section{padding:26px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.08);border-radius:14px;margin-bottom:20px}
.section h2{font-size:19px;margin-bottom:12px;letter-spacing:-0.2px}
.section > p{color:#9CA3AF;font-size:14px}
.section ul{list-style:none;margin-top:12px}
.section li{padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:14px;color:#D1D5DB}
.section li:last-child{border-bottom:none}
.info-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-top:16px}
.info-item{padding:16px;background:linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.01));border:1px solid rgba(255,255,255,0.06);border-radius:12px;position:relative;overflow:hidden;transition:transform 0.15s,border-color 0.15s}
.info-item:hover{transform:translateY(-2px);border-color:rgba(255,255,255,0.12)}
.info-icon{width:32px;height:32px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;font-size:16px;margin-bottom:10px}
.info-label{font-size:10px;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.08em;font-weight:600}
.info-value{font-size:16px;font-weight:700;margin-top:4px;letter-spacing:-0.2px}
/* Color variants pour les info cards */
.info-item.c-blue .info-icon{background:rgba(59,130,246,0.18);color:#60A5FA}
.info-item.c-blue .info-value{color:#DBEAFE}
.info-item.c-green .info-icon{background:rgba(16,185,129,0.18);color:#34D399}
.info-item.c-green .info-value{color:#D1FAE5}
.info-item.c-purple .info-icon{background:rgba(139,92,246,0.18);color:#A78BFA}
.info-item.c-purple .info-value{color:#EDE9FE}
.info-item.c-orange .info-icon{background:rgba(245,158,11,0.18);color:#FBBF24}
.info-item.c-orange .info-value{color:#FEF3C7}
.info-item.c-pink .info-icon{background:rgba(236,72,153,0.18);color:#F472B6}
.info-item.c-pink .info-value{color:#FCE7F3}
.info-item.c-cyan .info-icon{background:rgba(6,182,212,0.18);color:#22D3EE}
.info-item.c-cyan .info-value{color:#CFFAFE}
.info-item.c-teal .info-icon{background:rgba(20,184,166,0.18);color:#2DD4BF}
.info-item.c-teal .info-value{color:#CCFBF1}
.info-item.c-indigo .info-icon{background:rgba(99,102,241,0.18);color:#818CF8}
.info-item.c-indigo .info-value{color:#E0E7FF}

/* Insider transactions list — plus visuel, avec badges colores */
.insider-list{display:flex;flex-direction:column;gap:8px;margin-top:14px}
.insider-row{display:flex;align-items:center;gap:12px;padding:12px 16px;background:linear-gradient(90deg,rgba(255,255,255,0.03),rgba(255,255,255,0.01));border:1px solid rgba(255,255,255,0.06);border-radius:10px;transition:border-color 0.15s}
.insider-row:hover{border-color:rgba(255,255,255,0.14)}
.insider-avatar{width:36px;height:36px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;color:#fff;flex-shrink:0;letter-spacing:-0.3px}
.insider-avatar.buy{background:linear-gradient(135deg,#10B981,#059669);box-shadow:0 0 12px rgba(16,185,129,0.35)}
.insider-avatar.sell{background:linear-gradient(135deg,#EF4444,#DC2626);box-shadow:0 0 12px rgba(239,68,68,0.35)}
.insider-avatar.other{background:linear-gradient(135deg,#6B7280,#4B5563)}
.insider-info{flex:1;min-width:0}
.insider-name{font-size:14px;font-weight:700;color:#F9FAFB;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.insider-meta{font-size:11px;color:#9CA3AF}
.insider-badge{padding:5px 11px;border-radius:100px;font-size:11px;font-weight:700;letter-spacing:0.03em;flex-shrink:0}
.insider-badge.buy{background:rgba(16,185,129,0.15);color:#34D399;border:1px solid rgba(16,185,129,0.35)}
.insider-badge.sell{background:rgba(239,68,68,0.15);color:#F87171;border:1px solid rgba(239,68,68,0.35)}
.insider-badge.other{background:rgba(107,114,128,0.15);color:#9CA3AF;border:1px solid rgba(107,114,128,0.35)}

/* Funds list — style similar but teal tone */
.funds-list{display:flex;flex-direction:column;gap:6px;margin-top:14px}
.fund-row{display:flex;align-items:center;gap:12px;padding:10px 14px;background:rgba(20,184,166,0.05);border:1px solid rgba(20,184,166,0.15);border-radius:10px;font-size:13px;color:#D1D5DB}
.fund-row::before{content:"🏦";font-size:14px}
.fund-row strong{color:#2DD4BF;font-weight:600}
/* Feature grid : 6 cards "teaser" suggerant la richesse de la plateforme */
.features-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-top:20px}
.feature-card{padding:22px;background:linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.01));border:1px solid rgba(255,255,255,0.08);border-radius:14px;position:relative;overflow:hidden;transition:transform 0.18s,border-color 0.18s}
.feature-card:hover{transform:translateY(-3px);border-color:rgba(59,130,246,0.35)}
.feature-card .icon-wrap{width:42px;height:42px;border-radius:10px;display:flex;align-items:center;justify-content:center;margin-bottom:14px;font-size:22px}
.feature-card h3{font-size:16px;margin-bottom:8px;letter-spacing:-0.2px}
.feature-card p{color:#9CA3AF;font-size:13px;line-height:1.55}
.feature-card.locked::after{content:"🔒 Premium";position:absolute;top:14px;right:14px;font-size:10px;padding:3px 8px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:100px;color:#D1D5DB;font-weight:600}
/* Trust bar */
.trust-bar{padding:20px 24px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:12px;margin-bottom:24px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:center;font-size:13px;color:#9CA3AF}
.trust-bar strong{color:#D1D5DB;font-weight:600}
.trust-bar .dot{color:#4B5563}
/* Paywall */
.paywall{padding:40px 32px;background:linear-gradient(135deg,rgba(59,130,246,0.18),rgba(139,92,246,0.12));border:1px solid rgba(59,130,246,0.35);border-radius:18px;text-align:center;margin-top:32px;position:relative;overflow:hidden}
.paywall::before{content:"";position:absolute;top:-50%;left:-10%;width:120%;height:200%;background:radial-gradient(ellipse,rgba(59,130,246,0.15),transparent 60%);pointer-events:none}
.paywall h2{font-size:24px;margin-bottom:12px;letter-spacing:-0.3px;position:relative}
.paywall > p{color:#D1D5DB;margin-bottom:20px;position:relative}
.paywall .cta{display:inline-block;padding:14px 30px;font-size:15px;position:relative}
.paywall-secondary{display:inline-block;margin-top:12px;font-size:13px;color:#9CA3AF;text-decoration:none;position:relative}
.paywall-secondary:hover{color:#D1D5DB}
.features{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;margin:24px 0;text-align:left;position:relative}
.feature{padding:12px 16px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.06);border-radius:10px;font-size:13px;color:#D1D5DB}
footer{margin-top:60px;padding-top:30px;border-top:1px solid rgba(255,255,255,0.05);font-size:12px;color:#6B7280;text-align:center}
footer a{color:#9CA3AF;text-decoration:none}
@media (max-width:640px){.container{padding:24px 16px}.ticker-symbol{font-size:36px}.price{font-size:26px}.stat-value{font-size:22px}}
</style>
</head>
<body>
<div class="container">
  <nav class="nav">
    <a href="https://kairosinsider.fr/" class="logo">
      <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="24" cy="24" r="20" stroke="url(#lg1)" stroke-width="2" fill="none"/><path d="M10 30 L18 20 L26 26 L38 14" stroke="url(#lg1)" fill="none"/><defs><linearGradient id="lg1" x1="0" y1="0" x2="48" y2="48"><stop offset="0" stop-color="#3B82F6"/><stop offset="1" stop-color="#8B5CF6"/></linearGradient></defs></svg>
      Kairos Insider
    </a>
    <a href="${dashboardUrl}?lang=${lang}" class="cta">${ssrT(lang, 'open_full')}</a>
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
      ${changePct != null ? `<div class="${changePct >= 0 ? 'change-up' : 'change-down'}" style="margin-top:4px">${fmtPctSsr(changePct)} ${ssrT(lang, 'session_change')}</div>` : ''}
      ${changeYtd != null ? `<div style="font-size:12px;color:#6B7280;margin-top:6px">${fmtPctSsr(changeYtd)} ${ssrT(lang, 'ytd_label')} · ${fmtPctSsr(change1y)} ${ssrT(lang, 'y1_label')}</div>` : ''}
    </div>
  </div>

  <!-- Stats bar : 4 chiffres cles qui montrent la richesse des donnees -->
  <div class="stats-bar">
    <div class="stat-card">
      <div class="stat-value">${totalInsiderTx}</div>
      <div class="stat-label">${ssrT(lang, 'stats_insiders')}</div>
      <div class="stat-sub">${ssrT(lang, 'stats_insiders_sub')}</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${totalFunds}${totalFunds > 0 ? '' : ' / 200+'}</div>
      <div class="stat-label">${ssrT(lang, 'stats_funds')}</div>
      <div class="stat-sub">${ssrT(lang, 'stats_funds_sub')}</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">16</div>
      <div class="stat-label">${ssrT(lang, 'stats_etfs')}</div>
      <div class="stat-sub">${ssrT(lang, 'stats_etfs_sub')}</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">24h</div>
      <div class="stat-label">${ssrT(lang, 'stats_fresh')}</div>
      <div class="stat-sub">${ssrT(lang, 'stats_fresh_sub')}</div>
    </div>
  </div>

  <div class="score-card" style="display:flex;flex-wrap:wrap;gap:32px;align-items:center;position:relative;overflow:hidden">
    <div style="position:absolute;top:-60px;right:-60px;width:220px;height:220px;background:radial-gradient(circle, ${sig.color}50 0%, transparent 65%);pointer-events:none"></div>
    ${renderKairosRadarSsr(data.score, sig)}
    <div class="score-info" style="flex:1;min-width:260px;position:relative;z-index:1">
      <div style="display:inline-flex;align-items:center;gap:8px;padding:5px 14px;background:${sig.color}22;color:${sig.color};border:1px solid ${sig.color}55;border-radius:100px;font-size:11px;font-weight:700;letter-spacing:0.06em;margin-bottom:12px">
        <span style="width:6px;height:6px;background:${sig.color};border-radius:50%;box-shadow:0 0 10px ${sig.color}"></span>
        ${sig.label}
      </div>
      <h1 style="font-size:26px;margin:0 0 10px;letter-spacing:-0.01em">Kairos Score : <span style="color:${sig.color}">${score}</span><span style="opacity:0.4;font-size:20px">/100</span></h1>
      <p>Score composite qui agrège <strong>8 dimensions du smart money</strong> : initiés (SEC/AMF/BaFin), hedge funds, politiciens &amp; gourous, momentum du cours, valorisation, consensus analystes, santé financière, momentum des résultats. Plus le score est élevé, plus le consensus des signaux institutionnels est favorable à l'achat.</p>
      ${data.score && data.score._breakdownHidden ? `<p style="font-size:12px;opacity:0.6;margin-top:10px">💡 <strong>Décomposition détaillée</strong> (les 8 sous-scores) disponible dans le dashboard Premium.</p>` : ''}
    </div>
  </div>

  ${data.company?.description ? `
    <div class="section">
      <h2>${ssrT(lang, 'about', { name: escHtmlSsr(name) })}</h2>
      <p>${escHtmlSsr(data.company.description)}</p>
    </div>
  ` : ''}

  <div class="section">
    <h2>${ssrT(lang, 'key_info')}</h2>
    <div class="info-grid">
      ${data.company?.ceo ? `<div class="info-item c-purple"><div class="info-icon">👔</div><div class="info-label">${ssrT(lang, 'info_ceo')}</div><div class="info-value">${escHtmlSsr(data.company.ceo)}</div></div>` : ''}
      ${data.company?.founded ? `<div class="info-item c-cyan"><div class="info-icon">🎂</div><div class="info-label">${ssrT(lang, 'info_founded')}</div><div class="info-value">${escHtmlSsr(data.company.founded)}</div></div>` : ''}
      ${data.company?.headquarters ? `<div class="info-item c-indigo"><div class="info-icon">📍</div><div class="info-label">${ssrT(lang, 'info_hq')}</div><div class="info-value">${escHtmlSsr(data.company.headquarters)}</div></div>` : ''}
      ${data.company?.employees ? `<div class="info-item c-teal"><div class="info-icon">👥</div><div class="info-label">${ssrT(lang, 'info_employees')}</div><div class="info-value">${fmtIntSsr(data.company.employees)}</div></div>` : ''}
      ${marketCap ? `<div class="info-item c-blue"><div class="info-icon">💰</div><div class="info-label">${ssrT(lang, 'info_marketcap')}</div><div class="info-value">${fmtCurrSsr(marketCap, currency)}</div></div>` : ''}
      ${pe ? `<div class="info-item c-orange"><div class="info-icon">📊</div><div class="info-label">${ssrT(lang, 'info_pe')}</div><div class="info-value">${typeof pe === 'number' ? pe.toFixed(1) : escHtmlSsr(pe)}</div></div>` : ''}
      ${dividendYield ? `<div class="info-item c-green"><div class="info-icon">💸</div><div class="info-label">${ssrT(lang, 'info_div')}</div><div class="info-value">${typeof dividendYield === 'number' ? dividendYield.toFixed(2) + '%' : escHtmlSsr(dividendYield)}</div></div>` : ''}
      ${data.company?.ipoDate ? `<div class="info-item c-pink"><div class="info-icon">🚀</div><div class="info-label">${ssrT(lang, 'info_ipo')}</div><div class="info-value">${escHtmlSsr(data.company.ipoDate)}</div></div>` : ''}
    </div>
  </div>

  <div class="section">
    <h2>${ssrT(lang, 'insiders_h2')}</h2>
    <p>${ssrT(lang, 'insiders_p', { total: String(totalInsiderTx), buys: String(insiderBuyCount), name: escHtmlSsr(name) })}</p>
    ${(() => {
      const txs = (data.insiders?.transactions || []).slice(0, 5);
      if (!txs.length) return '';
      const rows = txs.map(t => {
        const isBuy = (t.type === 'P' || t.adType === 'A');
        const isSell = (t.type === 'S' || t.adType === 'D');
        const kind = isBuy ? 'buy' : isSell ? 'sell' : 'other';
        const label = isBuy ? (lang === 'en' ? 'Buy' : 'Achat') : isSell ? (lang === 'en' ? 'Sell' : 'Vente') : (lang === 'en' ? 'Other' : 'Autre');
        const name = escHtmlSsr(t.insider || '—');
        const initials = (t.insider || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(s => s[0].toUpperCase()).join('') || '?';
        const date = t.date ? escHtmlSsr(t.date) : '';
        const role = t.title ? escHtmlSsr(t.title) : '';
        const meta = [role, date].filter(Boolean).join(' · ');
        return `
          <div class="insider-row">
            <div class="insider-avatar ${kind}">${escHtmlSsr(initials)}</div>
            <div class="insider-info">
              <div class="insider-name">${name}</div>
              ${meta ? `<div class="insider-meta">${meta}</div>` : ''}
            </div>
            <span class="insider-badge ${kind}">${label}</span>
          </div>
        `;
      }).join('');
      return `<div class="insider-list">${rows}</div>`;
    })()}
  </div>

  <div class="section">
    <h2>${ssrT(lang, 'funds_h2')}</h2>
    <p>${ssrT(lang, 'funds_p', { total: String(totalFunds), ticker: escHtmlSsr(ticker) })}</p>
    ${(() => {
      const funds = (data.smartMoney?.topFunds || []).slice(0, 5);
      if (!funds.length) return '';
      const rows = funds.map(f => `<div class="fund-row"><strong>${escHtmlSsr(f.fundName || f.cik || 'Hedge fund')}</strong></div>`).join('');
      return `<div class="funds-list">${rows}</div>`;
    })()}
  </div>

  ${totalNews > 0 ? `
    <div class="section">
      <h2>${ssrT(lang, 'news_h2')}</h2>
      <p>${ssrT(lang, 'news_p', { total: String(totalNews), ticker: escHtmlSsr(ticker) })}</p>
      ${newsTeaser ? `<ul>${newsTeaser}</ul>` : ''}
    </div>
  ` : ''}

  ${trends && trends.interestMax >= 8 ? `
    <div class="section">
      <h2>${ssrT(lang, 'trends_h2')}</h2>
      <p>
        ${ssrT(lang, 'trends_subtitle_part1', { interest: String(trends.interestNow) })}
        ${trends.interestNow >= 8 ? (
          trends.spike7d > 5 ? ` · <span style="color:#10B981">${ssrT(lang, 'trends_spike_up', { spike: String(trends.spike7d) })}</span>` :
          trends.spike7d < -5 ? ` · <span style="color:#EF4444">${ssrT(lang, 'trends_spike_down', { spike: String(trends.spike7d) })}</span>` :
          ` · ${ssrT(lang, 'trends_spike_stable', { spike: String(trends.spike7d) })}`
        ) : ''}
        ${trends.interestNow >= 8 ? ` · ${ssrT(lang, 'trends_trend_label')} <strong>${trends.trend === 'rising' ? ssrT(lang, 'trend_rising') : trends.trend === 'falling' ? ssrT(lang, 'trend_falling') : ssrT(lang, 'trend_stable')}</strong>` : ''}
      </p>
      <p style="font-size:12px;color:#6B7280;margin-top:8px">
        ${ssrT(lang, 'trends_helper', { ticker: escHtmlSsr(ticker) })}
        ${ssrT(lang, 'trends_avg_max', { avg: String(trends.interestMean), max: String(trends.interestMax) })}
      </p>
    </div>
  ` : ''}

  <!-- Features grid : 6 cards qui montrent la richesse de la plateforme au-dela de cette page -->
  <div class="section" style="background:transparent;border:none;padding:0;margin-top:40px">
    <h2 style="font-size:22px;margin-bottom:8px">${ssrT(lang, 'features_h2')}</h2>
    <p style="color:#9CA3AF;font-size:14px;margin-bottom:4px">${ssrT(lang, 'features_p')}</p>
    <div class="features-grid">
      <div class="feature-card locked">
        <div class="icon-wrap" style="background:rgba(59,130,246,0.15);color:#3B82F6">🧠</div>
        <h3>${ssrT(lang, 'feat1_title')}</h3>
        <p>${ssrT(lang, 'feat1_desc')}</p>
      </div>
      <div class="feature-card locked">
        <div class="icon-wrap" style="background:rgba(239,68,68,0.15);color:#EF4444">🎯</div>
        <h3>${ssrT(lang, 'feat2_title')}</h3>
        <p>${ssrT(lang, 'feat2_desc')}</p>
      </div>
      <div class="feature-card locked">
        <div class="icon-wrap" style="background:rgba(20,184,166,0.15);color:#14B8A6">🏦</div>
        <h3>${ssrT(lang, 'feat3_title')}</h3>
        <p>${ssrT(lang, 'feat3_desc')}</p>
      </div>
      <div class="feature-card locked">
        <div class="icon-wrap" style="background:rgba(6,182,212,0.15);color:#06B6D4">📈</div>
        <h3>${ssrT(lang, 'feat4_title')}</h3>
        <p>${ssrT(lang, 'feat4_desc')}</p>
      </div>
      <div class="feature-card locked">
        <div class="icon-wrap" style="background:rgba(245,158,11,0.15);color:#F59E0B">🔥</div>
        <h3>${ssrT(lang, 'feat5_title')}</h3>
        <p>${ssrT(lang, 'feat5_desc')}</p>
      </div>
      <div class="feature-card locked">
        <div class="icon-wrap" style="background:rgba(251,191,36,0.15);color:#FBBF24">📧</div>
        <h3>${ssrT(lang, 'feat6_title')}</h3>
        <p>${ssrT(lang, 'feat6_desc')}</p>
      </div>
    </div>
  </div>

  <!-- Trust bar : rassurer sur la provenance officielle des donnees -->
  <div class="trust-bar">
    <strong>${ssrT(lang, 'trust_h2')}</strong>
    <span class="dot">·</span> ${ssrT(lang, 'trust_sec')}
    <span class="dot">·</span> ${ssrT(lang, 'trust_amf')}
    <span class="dot">·</span> ${ssrT(lang, 'trust_bafin')}
    <span class="dot">·</span> ${ssrT(lang, 'trust_quote')}
  </div>

  <div class="paywall">
    <h2>${ssrT(lang, 'paywall_h2')}</h2>
    <p>${ssrT(lang, 'paywall_p', { ticker: escHtmlSsr(ticker) })}</p>
    <div class="features">
      <div class="feature">${ssrT(lang, 'paywall_f1')}</div>
      <div class="feature">${ssrT(lang, 'paywall_f2', { total: String(totalInsiderTx) })}</div>
      <div class="feature">${ssrT(lang, 'paywall_f3', { total: String(totalFunds) })}</div>
      <div class="feature">${ssrT(lang, 'paywall_f4')}</div>
      <div class="feature">${ssrT(lang, 'paywall_f5')}</div>
      <div class="feature">${ssrT(lang, 'paywall_f6')}</div>
      <div class="feature">${ssrT(lang, 'paywall_f7')}</div>
      <div class="feature">${ssrT(lang, 'paywall_f8')}</div>
      <div class="feature">${ssrT(lang, 'paywall_f9')}</div>
    </div>
    <a href="${dashboardUrl}?lang=${lang}" class="cta">${ssrT(lang, 'paywall_cta')}</a>
    <br>
    <a href="https://kairosinsider.fr/?lang=${lang}" class="paywall-secondary">${ssrT(lang, 'cta_secondary_label')} →</a>
    <p style="margin-top:14px;font-size:12px;color:#6B7280;position:relative">${ssrT(lang, 'paywall_terms')}</p>
  </div>

  <footer>
    <p><a href="https://kairosinsider.fr/?lang=${lang}">${ssrT(lang, 'footer_tagline')}</a></p>
    <p style="margin-top:6px">${ssrT(lang, 'footer_sources')}</p>
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
// Resout le plan (pro|elite|legacy) + billing (monthly|yearly) a partir du
// priceId Stripe. Prioritise les metadata Stripe (nouvelle architecture avril 2026),
// fallback sur mapping inverse via les env vars de prix.
function resolveStripePlan(priceId, metadata, env) {
  // 1. Metadata presente (checkout cree avec la nouvelle architecture)
  if (metadata?.plan && metadata?.billing) {
    return {
      plan: metadata.plan,
      billing: metadata.billing === 'yearly' ? 'yearly' : 'monthly',
    };
  }
  // 2. Mapping inverse via priceId
  if (priceId === env.STRIPE_PRICE_ID_PRO_MONTHLY)   return { plan: 'pro',   billing: 'monthly' };
  if (priceId === env.STRIPE_PRICE_ID_PRO_ANNUAL)    return { plan: 'pro',   billing: 'yearly'  };
  if (priceId === env.STRIPE_PRICE_ID_ELITE_MONTHLY) return { plan: 'elite', billing: 'monthly' };
  if (priceId === env.STRIPE_PRICE_ID_ELITE_ANNUAL)  return { plan: 'elite', billing: 'yearly'  };
  // 3. Fallback : ancien prix Premium 29€ (grandfathered users)
  if (priceId === env.STRIPE_PRICE_ID)               return { plan: 'legacy', billing: 'monthly' };
  // 4. Prix inconnu : defaut pro/monthly pour eviter blocage
  return { plan: 'pro', billing: 'monthly' };
}

async function handleCreateCheckout(request, env, user, origin) {
  try {
    const body = await request.json().catch(() => ({}));

    // Nouveau modele 3 plans (avr 2026) :
    //   plan=pro + billing=monthly  → STRIPE_PRICE_ID_PRO_MONTHLY   (19€/mois)
    //   plan=pro + billing=yearly   → STRIPE_PRICE_ID_PRO_ANNUAL    (190€/an)
    //   plan=elite + billing=monthly → STRIPE_PRICE_ID_ELITE_MONTHLY (49€/mois)
    //   plan=elite + billing=yearly  → STRIPE_PRICE_ID_ELITE_ANNUAL  (490€/an)
    //   fallback (pas de plan) → STRIPE_PRICE_ID (ancien Premium 29€, archive
    //   cote Stripe mais toujours utilisable pour grandfathering).
    const plan = (body.plan === 'elite') ? 'elite' : (body.plan === 'pro') ? 'pro' : 'pro'; // defaut pro (nouveau flow)
    const billing = (body.billing === 'yearly') ? 'yearly' : 'monthly';

    const priceMap = {
      'pro:monthly':   env.STRIPE_PRICE_ID_PRO_MONTHLY,
      'pro:yearly':    env.STRIPE_PRICE_ID_PRO_ANNUAL,
      'elite:monthly': env.STRIPE_PRICE_ID_ELITE_MONTHLY,
      'elite:yearly':  env.STRIPE_PRICE_ID_ELITE_ANNUAL,
    };
    const priceId = priceMap[`${plan}:${billing}`] || env.STRIPE_PRICE_ID;
    const effectiveBilling = billing;
    const effectivePlan = plan;

    if (!priceId) {
      console.warn('[stripe] No price_id available for plan=' + plan + ' billing=' + billing);
      return jsonResponse({
        error: 'Price not configured',
        detail: 'Le plan demande n\'est pas encore configure cote Stripe.',
        code: 'PRICE_NOT_CONFIGURED',
      }, 200, origin);
    }

    const params = new URLSearchParams({
      'mode': 'subscription',
      'client_reference_id': user.uid,
      'customer_email': user.email,
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      'success_url': body.successUrl || `${env.ALLOWED_ORIGIN}/merci.html?session_id={CHECKOUT_SESSION_ID}`,
      'cancel_url': body.cancelUrl || `${env.ALLOWED_ORIGIN}/dashboard.html?checkout=cancelled`,
      'subscription_data[metadata][firebase_uid]': user.uid,
      'subscription_data[metadata][billing]': effectiveBilling,
      'subscription_data[metadata][plan]': effectivePlan,
    });
    // Méthodes de paiement : carte en 1er, PayPal si activé sur Stripe Dashboard.
    // Ordre explicite évite que Link soit auto-injecté en premier écran.
    params.append('payment_method_types[]', 'card');
    params.append('payment_method_types[]', 'paypal');
    // Collecte billing address pour PCI compliance + fraud prevention
    params.append('billing_address_collection', 'auto');

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
// STRIPE : Vérification de signature du webhook
// ============================================================
// Format du header Stripe-Signature: "t=TIMESTAMP,v1=SIGNATURE[,v1=...]"
// On recompute HMAC_SHA256(secret, timestamp + "." + rawBody) et on compare.
async function verifyStripeSignature(rawBody, sigHeader, secret, toleranceSec = 300) {
  if (!sigHeader || !secret) return false;
  const parts = sigHeader.split(',').map(s => s.trim());
  let ts = null;
  const v1Sigs = [];
  for (const p of parts) {
    const [k, v] = p.split('=');
    if (k === 't') ts = v;
    else if (k === 'v1') v1Sigs.push(v);
  }
  if (!ts || v1Sigs.length === 0) return false;

  // Replay protection : rejeter si timestamp trop vieux
  const tsNum = parseInt(ts, 10);
  if (!Number.isFinite(tsNum)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - tsNum) > toleranceSec) return false;

  // Recomputer HMAC
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const payload = `${ts}.${rawBody}`;
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  const expectedHex = Array.from(new Uint8Array(sigBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Comparaison constant-time
  for (const sig of v1Sigs) {
    if (sig.length !== expectedHex.length) continue;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) {
      diff |= sig.charCodeAt(i) ^ expectedHex.charCodeAt(i);
    }
    if (diff === 0) return true;
  }
  return false;
}

// ============================================================
// STRIPE : Webhook (events de subscription)
// ============================================================
async function handleStripeWebhook(request, env) {
  try {
    const body = await request.text();

    // Vérification de la signature Stripe (anti-forgerie)
    const sigHeader = request.headers.get('Stripe-Signature') || request.headers.get('stripe-signature');
    const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      log.error('stripe.webhook.secret_missing');
      return new Response(JSON.stringify({ error: 'Webhook secret not configured' }), { status: 500 });
    }
    const valid = await verifyStripeSignature(body, sigHeader, webhookSecret);
    if (!valid) {
      log.warn('stripe.webhook.signature_invalid');
      return new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 400 });
    }

    const event = JSON.parse(body);

    // Rejet des events test en production (évite que des paiements test accordent un Premium réel).
    // STRIPE_ALLOW_TEST_MODE=1 pour autoriser (dev/staging).
    if (event.livemode === false && env.STRIPE_ALLOW_TEST_MODE !== '1') {
      console.warn(`Stripe webhook: test-mode event ignored (type=${event.type}, id=${event.id})`);
      return new Response(JSON.stringify({ received: true, ignored: 'test-mode' }), { status: 200 });
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const uid = session.client_reference_id || session.subscription_data?.metadata?.firebase_uid;
      if (uid && session.subscription) {
        // Récupérer les détails de la subscription
        const subResp = await fetch(`https://api.stripe.com/v1/subscriptions/${session.subscription}`, {
          headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
        });
        const sub = await subResp.json();

        const priceId = sub.items?.data?.[0]?.price?.id || env.STRIPE_PRICE_ID;
        // Resolve plan (pro|elite|legacy) + billing (monthly|yearly) depuis priceId.
        // Prioritise le metadata si dispo (nouvelle architecture), sinon mapping inverse.
        const { plan, billing } = resolveStripePlan(priceId, sub.metadata, env);
        await env.CACHE.put(`sub:${uid}`, JSON.stringify({
          status: sub.status,
          subscriptionId: sub.id,
          customerId: sub.customer,
          currentPeriodEnd: sub.current_period_end,
          priceId,
          plan,
          billing,
        }));
        console.log(`Subscription created for uid: ${uid}, status: ${sub.status}, plan: ${plan}, billing: ${billing}`);

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
        const priceId = sub.items?.data?.[0]?.price?.id || env.STRIPE_PRICE_ID;
        const { plan, billing } = resolveStripePlan(priceId, sub.metadata, env);
        await env.CACHE.put(`sub:${uid}`, JSON.stringify({
          status: sub.status,
          subscriptionId: sub.id,
          customerId: sub.customer,
          currentPeriodEnd: sub.current_period_end,
          priceId,
          plan,
          billing,
        }));
        console.log(`Subscription updated for uid: ${uid}, status: ${sub.status}, plan: ${plan}, billing: ${billing}`);
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
  // Resolve le plan actuel (pro | elite | legacy) pour l'UI dashboard.
  // 'legacy' = abonnes historiques sur l'ancien prix 29€, grandfathered.
  let plan = null;
  let billing = null;
  if (subData) {
    const resolved = resolveStripePlan(subData.priceId, { plan: subData.plan, billing: subData.billing }, env);
    plan = resolved.plan;
    billing = resolved.billing;
  }
  return jsonResponse({
    uid: user.uid,
    email: user.email,
    hasSubscription: !!(subData && (subData.status === 'active' || subData.status === 'past_due')),
    status: subData?.status || null,
    subscriptionStatus: subData?.status || null,   // retrocompat
    currentPeriodEnd: subData?.currentPeriodEnd || null,
    plan,                                           // 'pro' | 'elite' | 'legacy' | null
    billing,                                        // 'monthly' | 'yearly' | null
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
// ACCOUNT : Suppression (RGPD)
// Purge côté serveur : KV (sub + watchlist). Firebase Auth + RTDB sont supprimés côté client.
// Si abonnement Stripe actif, on tente l'annulation automatique.
// ============================================================
async function handleAccountDelete(env, user, origin) {
  try {
    const uid = user.uid;
    // 1) Annuler l'abonnement Stripe si présent (best-effort)
    try {
      const subData = await env.CACHE.get(`sub:${uid}`, 'json');
      if (subData?.subscriptionId && env.STRIPE_SECRET_KEY) {
        await fetch(`https://api.stripe.com/v1/subscriptions/${subData.subscriptionId}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
        }).catch(e => console.warn('Stripe cancel failed:', e));
      }
    } catch (e) { console.warn('sub cancel pre-delete:', e); }

    // 2) Purge KV
    await Promise.all([
      env.CACHE.delete(`sub:${uid}`).catch(() => {}),
      env.CACHE.delete(`wl:${uid}`).catch(() => {}),
    ]);

    console.log(`[account/delete] purged KV for uid=${uid} (email=${user.email})`);
    return jsonResponse({ ok: true, purged: ['sub', 'wl'] }, 200, origin);
  } catch (err) {
    console.error('handleAccountDelete error:', err);
    return jsonResponse({ error: 'Internal error' }, 500, origin);
  }
}

// ============================================================
// SUPPORT : envoi email de contact via Brevo
// → destinataire : contact@kairosinsider.fr
// → replyTo : email du user (pour réponse directe)
// Rate-limit : 5 msg / heure / user via KV
// ============================================================
const SUPPORT_RATE_LIMIT = 5;   // max msgs / fenêtre
const SUPPORT_RATE_WINDOW = 3600; // en secondes (1h)
const SUPPORT_SUBJECTS = {
  question: '❓ Question générale',
  bug: '🐛 Bug',
  billing: '💳 Facturation / Abonnement',
  feature: '💡 Suggestion',
  data: '📊 Problème de données',
  other: '✉️ Autre',
};

async function handleSupportContact(request, env, user, origin) {
  try {
    const body = await request.json();
    const subject = (body.subject || 'other').toLowerCase();
    const message = (body.message || '').trim();

    // Validation
    if (!SUPPORT_SUBJECTS[subject]) {
      return jsonResponse({ error: 'Sujet invalide' }, 400, origin);
    }
    if (message.length < 10) {
      return jsonResponse({ error: 'Message trop court (10 caractères min)' }, 400, origin);
    }
    if (message.length > 4000) {
      return jsonResponse({ error: 'Message trop long (4000 caractères max)' }, 400, origin);
    }

    // Rate-limit anti-spam (5 messages / heure / user)
    const rlKey = `support_rl:${user.uid}`;
    const current = parseInt(await env.CACHE.get(rlKey) || '0', 10);
    if (current >= SUPPORT_RATE_LIMIT) {
      return jsonResponse({ error: 'Trop de messages envoyés. Réessayez dans 1 heure.' }, 429, origin);
    }
    await env.CACHE.put(rlKey, String(current + 1), { expirationTtl: SUPPORT_RATE_WINDOW });

    // Récup infos abonnement (utile pour le support)
    const subData = await env.CACHE.get(`sub:${user.uid}`, 'json').catch(() => null);
    const planLabel = subData?.status === 'active'
      ? (subData.billing === 'yearly' ? 'Premium Annuel' : 'Premium Mensuel')
      : 'Free';

    const subjectLabel = SUPPORT_SUBJECTS[subject];
    const userEmail = user.email || 'inconnu';
    const userName = user.name || user.displayName || userEmail.split('@')[0];

    // HTML email
    const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
    const html = `
      <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;padding:20px;color:#1F2937">
        <h2 style="color:#3B82F6;border-bottom:2px solid #3B82F6;padding-bottom:8px">🎧 Nouveau message support</h2>
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <tr><td style="padding:6px 0;color:#6B7280;width:140px">Sujet</td><td style="padding:6px 0;font-weight:600">${esc(subjectLabel)}</td></tr>
          <tr><td style="padding:6px 0;color:#6B7280">Utilisateur</td><td style="padding:6px 0;font-weight:600">${esc(userName)}</td></tr>
          <tr><td style="padding:6px 0;color:#6B7280">Email</td><td style="padding:6px 0"><a href="mailto:${esc(userEmail)}" style="color:#3B82F6">${esc(userEmail)}</a></td></tr>
          <tr><td style="padding:6px 0;color:#6B7280">UID</td><td style="padding:6px 0;font-family:monospace;font-size:12px;color:#6B7280">${esc(user.uid)}</td></tr>
          <tr><td style="padding:6px 0;color:#6B7280">Plan</td><td style="padding:6px 0">${esc(planLabel)}</td></tr>
          <tr><td style="padding:6px 0;color:#6B7280">Date</td><td style="padding:6px 0">${new Date().toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Paris' })}</td></tr>
        </table>
        <div style="background:#F9FAFB;border-left:4px solid #3B82F6;padding:16px;border-radius:4px;margin:16px 0">
          <div style="white-space:pre-wrap;line-height:1.6;color:#1F2937">${esc(message)}</div>
        </div>
        <div style="font-size:12px;color:#6B7280;margin-top:20px;padding-top:14px;border-top:1px solid #E5E7EB">
          💡 Pour répondre, cliquez simplement sur « Répondre » : l'email ira directement à <strong>${esc(userEmail)}</strong>.
        </div>
      </div>`;

    // Envoi via Brevo SMTP API
    const brevoResp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'accept': 'application/json',
      },
      body: JSON.stringify({
        sender: { name: 'Kairos Insider Support', email: env.BREVO_SENDER_EMAIL || 'contact@kairosinsider.fr' },
        to: [{ email: env.SUPPORT_INBOX_EMAIL || 'natquinson@gmail.com', name: 'Support Kairos' }],
        replyTo: { email: userEmail, name: userName },
        subject: `[Support] ${subjectLabel} — ${userName}`,
        htmlContent: html,
      }),
    });

    if (!brevoResp.ok) {
      const errText = await brevoResp.text().catch(() => '');
      console.error('Brevo support send failed:', brevoResp.status, errText);
      return jsonResponse({ error: 'Envoi de l\'email échoué' }, 502, origin);
    }

    console.log(`[support] message sent from uid=${user.uid} email=${userEmail} subject=${subject}`);
    return jsonResponse({ ok: true }, 200, origin);
  } catch (err) {
    console.error('handleSupportContact error:', err);
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
  <li>✓ <strong>Kairos Score 0-100</strong> (radar 8 axes + synthese textuelle)</li>
  <li>✓ Transactions d'inities US, Europe et France en quasi-temps reel</li>
  <li>✓ Signaux de clusters d'insiders sur 90 jours</li>
  <li>✓ <strong>200+ hedge funds</strong> 13F consolides (Buffett, Burry, Tiger, BlackRock...)</li>
  <li>✓ Smart Money Consensus avec ★ conviction</li>
  <li>✓ <strong>11 ETF thematiques</strong> (politique, ARK, sentiment retail, income, defense, uranium...)</li>
  <li>✓ Hot Stocks via Google Trends</li>
  <li>✓ Historique 2 ans (evolution AUM, rotations, scores)</li>
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

// ============================================================
// ============================================================
// ADMIN HANDLERS (Phase B+ : Users, Subs, Traffic, DB, Jobs)
// ============================================================
// Toutes les routes /api/admin/* sont gardees par isAdmin() en amont.
// ============================================================

// Prix Stripe (en EUR) - hardcode pour l'instant, a terme: recuperer via Stripe API
const STRIPE_MONTHLY_PRICE_EUR = 29.00;   // 29€/mois
const STRIPE_YEARLY_PRICE_EUR = 290.00;   // 290€/an = 24.17€/mois effectif

// Liste toutes les cles KV avec un prefixe donne, gere la pagination.
async function listAllKvKeys(env, prefix, limit = 10000) {
  const keys = [];
  let cursor = undefined;
  while (keys.length < limit) {
    const res = await env.CACHE.list({ prefix, cursor, limit: Math.min(1000, limit - keys.length) });
    for (const k of res.keys) keys.push(k.name);
    if (res.list_complete) break;
    cursor = res.cursor;
    if (!cursor) break;
  }
  return keys;
}

// GET /api/admin/subs-stats : agrege les abonnements depuis KV sub:*
// Retourne : { active, past_due, canceled, trialing, unknown, mrr_eur, total_subs }
async function handleAdminSubsStats(env, origin) {
  try {
    const subKeys = await listAllKvKeys(env, 'sub:', 5000);
    const counts = { active: 0, past_due: 0, canceled: 0, trialing: 0, incomplete: 0, unknown: 0 };
    const byBilling = { monthly: 0, yearly: 0, unknown: 0 };
    let mrr = 0; // MRR effectif en EUR (yearly divise par 12)
    // Fetch en parallele pour accelerer (max 50 en parallele)
    const batchSize = 50;
    for (let i = 0; i < subKeys.length; i += batchSize) {
      const batch = subKeys.slice(i, i + batchSize);
      const values = await Promise.all(batch.map(k => env.CACHE.get(k, 'json').catch(() => null)));
      for (const v of values) {
        if (!v || !v.status) { counts.unknown++; continue; }
        if (counts[v.status] !== undefined) counts[v.status]++;
        else counts.unknown++;
        // MRR = uniquement subs 'active', 'past_due' ou 'trialing'
        if (['active', 'past_due', 'trialing'].includes(v.status)) {
          if (v.billing === 'yearly') {
            byBilling.yearly++;
            mrr += STRIPE_YEARLY_PRICE_EUR / 12;
          } else if (v.billing === 'monthly') {
            byBilling.monthly++;
            mrr += STRIPE_MONTHLY_PRICE_EUR;
          } else {
            byBilling.unknown++;
            mrr += STRIPE_MONTHLY_PRICE_EUR; // defaut : monthly
          }
        }
      }
    }
    return jsonResponse({
      total_subs: subKeys.length,
      active: counts.active,
      past_due: counts.past_due,
      canceled: counts.canceled,
      trialing: counts.trialing,
      incomplete: counts.incomplete,
      unknown: counts.unknown,
      mrr_eur: Math.round(mrr * 100) / 100,
      price_per_month_eur: STRIPE_MONTHLY_PRICE_EUR,
      price_per_year_eur: STRIPE_YEARLY_PRICE_EUR,
      billing_mix: byBilling,
    }, 200, origin);
  } catch (e) {
    return jsonResponse({ error: 'Failed to aggregate subs', detail: String(e && e.message || e) }, 500, origin);
  }
}

// Fetch l'email d'un customer Stripe avec cache KV 24h.
// Retourne null si customerId absent, deleted, rate-limite ou Stripe indispo.
// Cache key : stripe-email:{customerId} (infini en cas de 404 pour pas repaper).
async function fetchStripeCustomerEmail(customerId, env) {
  if (!customerId || !env.STRIPE_SECRET_KEY) return null;
  const cacheKey = `stripe-email:${customerId}`;
  try {
    const cached = await env.CACHE.get(cacheKey, 'json');
    if (cached && cached.hasOwnProperty('email')) return cached.email;
  } catch {}
  try {
    const resp = await fetch(`https://api.stripe.com/v1/customers/${encodeURIComponent(customerId)}`, {
      headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    if (!resp.ok) {
      // 404 (deleted customer) → cache null 7j pour eviter de reappeler
      if (resp.status === 404) {
        await env.CACHE.put(cacheKey, JSON.stringify({ email: null, deleted: true }), { expirationTtl: 7 * 86400 });
      }
      return null;
    }
    const data = await resp.json();
    const email = data.deleted ? null : (data.email || null);
    await env.CACHE.put(cacheKey, JSON.stringify({ email }), { expirationTtl: 24 * 3600 });
    return email;
  } catch {
    return null;
  }
}

// GET /api/admin/users : liste tous les utilisateurs connus via KV (sub:* + wl:*)
// Ne retourne PAS les users free qui n'ont ni watchlist ni paiement
// (pour ca il faudrait un service account Firebase Admin, a faire plus tard).
// Email : on prefere d'abord l'email Stripe (plus fiable pour les payants),
// fallback watchlistEmail. Cache KV 24h par customerId (stripe-email:XXX).
// Retourne : { total, users: [{ uid, hasSubscription, subStatus, email, ... }] }
async function handleAdminUsers(env, origin) {
  try {
    const [subKeys, wlKeys] = await Promise.all([
      listAllKvKeys(env, 'sub:', 5000),
      listAllKvKeys(env, 'wl:', 5000),
    ]);
    const subUids = new Set(subKeys.map(k => k.slice(4)));  // "sub:XXX" -> "XXX"
    const wlUids = new Set(wlKeys.map(k => k.slice(3)));    // "wl:XXX"  -> "XXX"
    const allUids = new Set([...subUids, ...wlUids]);

    // Fetch les donnees en parallele (batch 40 pour eviter de saturer)
    const users = [];
    const uidsArr = Array.from(allUids);
    const batchSize = 40;
    for (let i = 0; i < uidsArr.length; i += batchSize) {
      const batch = uidsArr.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(async (uid) => {
        const hasSub = subUids.has(uid);
        const hasWl = wlUids.has(uid);
        let subData = null;
        let wlData = null;
        if (hasSub) subData = await env.CACHE.get(`sub:${uid}`, 'json').catch(() => null);
        if (hasWl) wlData = await env.CACHE.get(`wl:${uid}`, 'json').catch(() => null);
        // Email : Stripe prioritaire (payants), puis watchlist en fallback
        const customerId = subData?.customerId || null;
        const stripeEmail = customerId ? await fetchStripeCustomerEmail(customerId, env) : null;
        const email = stripeEmail || wlData?.email || null;
        return {
          uid,
          hasSubscription: hasSub,
          subStatus: subData?.status || null,
          currentPeriodEnd: subData?.currentPeriodEnd || null,
          customerId,
          hasWatchlist: hasWl,
          watchlistCount: Array.isArray(wlData?.tickers) ? wlData.tickers.length : 0,
          email,                                  // <- source unifiee (Stripe > watchlist)
          watchlistEmail: wlData?.email || null,  // conserve pour compat
          emailSource: stripeEmail ? 'stripe' : (wlData?.email ? 'watchlist' : null),
          watchlistOptIn: !!wlData?.optin,
          lastWatchlistUpdate: wlData?.updatedAt || null,
        };
      }));
      users.push(...results);
    }

    // Tri : premium active en premier, puis watchlist, puis le reste
    users.sort((a, b) => {
      const ap = a.subStatus === 'active' ? 0 : (a.hasSubscription ? 1 : (a.hasWatchlist ? 2 : 3));
      const bp = b.subStatus === 'active' ? 0 : (b.hasSubscription ? 1 : (b.hasWatchlist ? 2 : 3));
      if (ap !== bp) return ap - bp;
      return (b.lastWatchlistUpdate || '').localeCompare(a.lastWatchlistUpdate || '');
    });

    return jsonResponse({
      total: users.length,
      withSubscription: subKeys.length,
      withWatchlist: wlKeys.length,
      note: 'Ne liste que les users avec subscription ou watchlist. Les free sans activite ne sont pas en KV.',
      users,
    }, 200, origin);
  } catch (e) {
    return jsonResponse({ error: 'Failed to list users', detail: String(e && e.message || e) }, 500, origin);
  }
}

// GET /api/admin/jobs
// Liste toutes les cles KV lastRun:* et retourne leur payload pour afficher
// le statut des jobs du pipeline (derniere exec + statut + duree).
async function handleAdminJobs(env, origin) {
  try {
    const keys = await listAllKvKeys(env, 'lastRun:', 200);
    const jobs = [];
    // Fetch en parallele
    const values = await Promise.all(
      keys.map(async (k) => {
        const data = await env.CACHE.get(k, 'json').catch(() => null);
        return { key: k, name: k.slice('lastRun:'.length), data };
      })
    );
    for (const { name, data } of values) {
      if (!data) continue;
      jobs.push({
        name,
        ts: data.ts || null,
        iso: data.iso || null,
        status: data.status || 'unknown',
        durationSec: data.durationSec || null,
        summary: data.summary || '',
        error: data.error || '',
      });
    }
    // Ajoute aussi le cron watchlist (on a deja la cle `wl-last-cron-run`)
    const cronData = await env.CACHE.get('wl-last-cron-run', 'json').catch(() => null);
    if (cronData) {
      jobs.push({
        name: 'cron-watchlist-digest',
        ts: cronData.ts || null,
        iso: cronData.iso || null,
        status: cronData.status || 'ok',
        durationSec: cronData.durationSec || null,
        summary: cronData.summary || (cronData.emailsSent != null ? `${cronData.emailsSent} emails envoyes` : ''),
        error: cronData.error || '',
      });
    }
    // Tri : plus recent en haut
    jobs.sort((a, b) => (b.ts || 0) - (a.ts || 0));

    // Compte global pour KPI
    const okCount = jobs.filter(j => j.status === 'ok').length;
    return jsonResponse({
      timestamp: new Date().toISOString(),
      total: jobs.length,
      ok: okCount,
      failed: jobs.filter(j => j.status === 'failed').length,
      jobs,
    }, 200, origin);
  } catch (e) {
    return jsonResponse({ error: 'Failed to list jobs', detail: String(e && e.message || e) }, 500, origin);
  }
}

// ============================================================
// 13D / 13G Schedule filings (>5% stakes & activist signals)
// ============================================================
// GET /api/13dg/recent?days=30&activistOnly=0
// Retourne les filings recents (max 300 items). Filtrable par periode + activists-only.
async function handleScheduleDGRecent(url, env, origin) {
  const data = await env.CACHE.get('13dg-recent', 'json');
  if (!data) return jsonResponse({ error: '13D/G data not loaded yet' }, 503, origin);

  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '30', 10), 1), 90);
  const activistOnly = url.searchParams.get('activistOnly') === '1';
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10), 1), 500);

  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);
  let filings = (data.filings || []).filter(f => (f.fileDate || '') >= cutoff);
  if (activistOnly) filings = filings.filter(f => f.isActivist);
  const total = filings.length;
  filings = filings.slice(0, limit);

  return jsonResponse({
    updatedAt: data.updatedAt,
    lookbackDays: days,
    activistOnly,
    total,
    activistsCount: filings.filter(f => f.isActivist).length,
    filings,
  }, 200, origin);
}

// GET /api/13dg/ticker?ticker=AAPL
// Retourne tous les filings recents sur un ticker precis.
async function handleScheduleDGTicker(url, env, origin) {
  const ticker = (url.searchParams.get('ticker') || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '');
  if (!ticker) return jsonResponse({ error: 'Missing ticker' }, 400, origin);
  const data = await env.CACHE.get('13dg-recent', 'json');
  if (!data) return jsonResponse({ error: '13D/G data not loaded yet' }, 503, origin);

  const filings = (data.filings || []).filter(f => (f.ticker || '').toUpperCase() === ticker);
  return jsonResponse({
    ticker,
    updatedAt: data.updatedAt,
    total: filings.length,
    activistsCount: filings.filter(f => f.isActivist).length,
    hasActivist: filings.some(f => f.isActivist),
    mostRecent: filings[0] || null,
    filings,
  }, 200, origin);
}

// GET /api/13dg/activists?days=30
// Retourne uniquement les filings activists sur la periode, agrege par filer.
async function handleScheduleDGActivists(url, env, origin) {
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '30', 10), 1), 90);
  const data = await env.CACHE.get('13dg-recent', 'json');
  if (!data) return jsonResponse({ error: '13D/G data not loaded yet' }, 503, origin);

  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);
  const activistFilings = (data.filings || []).filter(f =>
    f.isActivist && (f.fileDate || '') >= cutoff
  );

  // Agrege par filer pour afficher "Elliott x5, Ackman x2..."
  const byFiler = {};
  for (const f of activistFilings) {
    const key = f.activistLabel || f.filerName || 'Unknown';
    if (!byFiler[key]) byFiler[key] = { label: key, count: 0, tickers: [], filings: [] };
    byFiler[key].count++;
    if (f.ticker && !byFiler[key].tickers.includes(f.ticker)) {
      byFiler[key].tickers.push(f.ticker);
    }
    byFiler[key].filings.push(f);
  }
  const aggregated = Object.values(byFiler).sort((a, b) => b.count - a.count);

  return jsonResponse({
    updatedAt: data.updatedAt,
    lookbackDays: days,
    total: activistFilings.length,
    byFiler: aggregated,
    filings: activistFilings.slice(0, 100),
  }, 200, origin);
}

// GET /api/admin/db-stats
// Compte les lignes par table D1 + les cles KV par prefixe.
// Retourne les min/max dates pour comprendre la fraicheur des donnees.
async function handleAdminDbStats(env, origin) {
  const result = { d1: {}, kv: {}, d1Size: null, kvSizeEstimate: null };

  // --- D1 : taille totale via PRAGMA (SQLite native)
  if (env.HISTORY) {
    try {
      const pageCountRes = await env.HISTORY.prepare('PRAGMA page_count').first();
      const pageSizeRes = await env.HISTORY.prepare('PRAGMA page_size').first();
      const pc = pageCountRes?.page_count || 0;
      const ps = pageSizeRes?.page_size || 0;
      if (pc && ps) {
        result.d1Size = {
          bytes: pc * ps,
          pages: pc,
          pageSize: ps,
          limitBytes: 10 * 1024 * 1024 * 1024, // Free plan : 10 GB
        };
      }
    } catch {}
  }

  // --- D1 : count + date range par table
  if (env.HISTORY) {
    try {
      const queries = [
        { name: 'insider_transactions_history', sql: 'SELECT COUNT(*) as cnt, MIN(filing_date) as min_d, MAX(filing_date) as max_d FROM insider_transactions_history', dateField: 'filing_date' },
        { name: 'etf_snapshots', sql: 'SELECT COUNT(*) as cnt, MIN(date) as min_d, MAX(date) as max_d FROM etf_snapshots', dateField: 'date' },
        { name: 'fund_holdings_history', sql: 'SELECT COUNT(*) as cnt, MIN(report_date) as min_d, MAX(report_date) as max_d FROM fund_holdings_history', dateField: 'report_date' },
        { name: 'score_history', sql: 'SELECT COUNT(*) as cnt, MIN(date) as min_d, MAX(date) as max_d FROM score_history', dateField: 'date' },
      ];
      for (const q of queries) {
        try {
          const r = await env.HISTORY.prepare(q.sql).first();
          result.d1[q.name] = {
            rows: r?.cnt || 0,
            minDate: r?.min_d || null,
            maxDate: r?.max_d || null,
            dateField: q.dateField,
          };
        } catch (err) {
          result.d1[q.name] = { error: String(err && err.message || err) };
        }
      }
      // Bonus : nb de tickers uniques en insider_transactions_history (pour couverture)
      try {
        const r = await env.HISTORY.prepare(
          'SELECT COUNT(DISTINCT ticker) as tickers, COUNT(DISTINCT insider) as insiders, COUNT(DISTINCT cik) as companies FROM insider_transactions_history WHERE source = ?'
        ).bind('SEC').first();
        if (r) {
          result.d1.insider_transactions_history.uniqueTickers = r.tickers || 0;
          result.d1.insider_transactions_history.uniqueInsiders = r.insiders || 0;
          result.d1.insider_transactions_history.uniqueCompanies = r.companies || 0;
        }
      } catch {}
    } catch (e) {
      result.d1._error = String(e && e.message || e);
    }
  } else {
    result.d1._error = 'HISTORY binding not configured';
  }

  // --- KV : count par prefixe connu
  const prefixes = ['sub:', 'wl:', 'wl-prev:', 'wl-last-cron-run', 'insider-', 'clusters-', 'etf-', '13f-', 'google-', 'sitemap', 'lastRun:'];
  for (const prefix of prefixes) {
    try {
      const keys = await listAllKvKeys(env, prefix, 3000);
      result.kv[prefix] = keys.length;
    } catch (err) {
      result.kv[prefix] = -1;
    }
  }

  return jsonResponse({
    timestamp: new Date().toISOString(),
    ...result,
  }, 200, origin);
}

// ============================================================
// ADMIN : error log (liste + clear + compteur quotidien)
// ============================================================
async function handleAdminErrors(env, origin) {
  try {
    const list = await env.CACHE.get('err:list', 'json').catch(() => []);
    const errors = Array.isArray(list) ? list : [];

    // Compteurs des 7 derniers jours
    const now = new Date();
    const dailyCounts = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const iso = d.toISOString().slice(0, 10);
      const n = parseInt(await env.CACHE.get(`err:count:${iso}`).catch(() => '0') || '0', 10);
      dailyCounts.push({ date: iso, count: n });
    }

    return jsonResponse({
      total: errors.length,
      errors,
      dailyCounts,
      lastError: errors[0] || null,
      generatedAt: new Date().toISOString(),
    }, 200, origin);
  } catch (err) {
    return jsonResponse({ error: 'Failed to list errors', detail: err.message || String(err) }, 500, origin);
  }
}

async function handleAdminErrorsClear(env, origin) {
  try {
    await env.CACHE.delete('err:list').catch(() => {});
    return jsonResponse({ ok: true, cleared: true }, 200, origin);
  } catch (err) {
    return jsonResponse({ error: 'Clear failed' }, 500, origin);
  }
}

// ============================================================
// ADMIN : health check (trigger manuel + dernier statut)
// ============================================================
async function handleAdminRunHealthCheck(env, origin) {
  try {
    // Force un nouveau check en retirant le cooldown
    await env.CACHE.delete('health:last-alert').catch(() => {});
    await runHealthCheck(env);
    const result = await env.CACHE.get('health:last-check', 'json').catch(() => null);
    return jsonResponse({ ok: true, result }, 200, origin);
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message || String(err) }, 500, origin);
  }
}

async function handleAdminHealthStatus(env, origin) {
  try {
    const check = await env.CACHE.get('health:last-check', 'json').catch(() => null);
    const alert = await env.CACHE.get('health:last-alert', 'json').catch(() => null);
    return jsonResponse({
      check,
      alert,
      now: Math.floor(Date.now() / 1000),
    }, 200, origin);
  } catch (err) {
    return jsonResponse({ error: err.message || String(err) }, 500, origin);
  }
}

// ============================================================
// ADMIN : statut du dernier backup (GitHub Actions → R2)
// ============================================================
// Lit meta/last-backup.json depuis le bucket R2 kairos-backups.
// Le workflow .github/workflows/backup.yml ecrit ce fichier apres chaque
// run. On calcule l'age du backup et un flag fresh (< 25h) / stale (> 48h).
async function handleAdminBackupStatus(env, origin) {
  try {
    if (!env.BACKUPS) {
      return jsonResponse({
        error: 'R2 binding BACKUPS not configured',
        hint: 'Add [[r2_buckets]] binding=BACKUPS bucket_name=kairos-backups to wrangler.toml and deploy.',
      }, 503, origin);
    }
    const obj = await env.BACKUPS.get('meta/last-backup.json');
    if (!obj) {
      return jsonResponse({
        hasBackup: false,
        message: 'Aucun backup trouve. Le workflow GitHub Actions n\'a pas encore tourne.',
      }, 200, origin);
    }
    const meta = await obj.json();
    const nowMs = Date.now();
    const backupMs = meta.ts ? new Date(meta.ts).getTime() : 0;
    const ageHours = backupMs ? Math.round((nowMs - backupMs) / 3600000) : null;
    let freshness = 'unknown';
    if (ageHours !== null) {
      if (ageHours < 25) freshness = 'fresh';
      else if (ageHours < 48) freshness = 'warning';
      else freshness = 'stale';
    }
    return jsonResponse({
      hasBackup: true,
      ageHours,
      freshness,
      meta,
      now: new Date(nowMs).toISOString(),
    }, 200, origin);
  } catch (err) {
    return jsonResponse({ error: err.message || String(err) }, 500, origin);
  }
}

// ============================================================
// ADMIN : Ponderation du Kairos Score (GET + PUT)
// ============================================================
// Les poids par defaut somment a 100. On accepte aussi une somme
// differente (ex: 120 ou 80) — on normalisera cote front si besoin.
const SCORE_WEIGHT_KEYS = ['insider','smartMoney','govGuru','momentum','valuation','analyst','health','earnings'];
const SCORE_DEFAULT_WEIGHTS = {
  insider: 20, smartMoney: 20, govGuru: 10, momentum: 15,
  valuation: 10, analyst: 10, health: 10, earnings: 5,
};
const SCORE_WEIGHT_LABELS = {
  insider: 'Signal des initiés',
  smartMoney: 'Hedge funds (13F)',
  govGuru: 'Politiciens & gourous',
  momentum: 'Momentum du cours',
  valuation: 'Valorisation',
  analyst: 'Consensus analystes',
  health: 'Santé financière',
  earnings: 'Momentum résultats',
};

async function handleAdminScoreWeightsGet(env, origin) {
  try {
    let current = null;
    try { current = await env.CACHE.get('config:score-weights', 'json'); } catch {}
    const weights = current && typeof current === 'object' ? current : SCORE_DEFAULT_WEIGHTS;
    const sum = SCORE_WEIGHT_KEYS.reduce((s, k) => s + (weights[k] || 0), 0);
    return jsonResponse({
      weights,
      defaults: SCORE_DEFAULT_WEIGHTS,
      labels: SCORE_WEIGHT_LABELS,
      keys: SCORE_WEIGHT_KEYS,
      sum,
      isDefault: !current,
    }, 200, origin);
  } catch (err) {
    return jsonResponse({ error: err.message || String(err) }, 500, origin);
  }
}

async function handleAdminScoreWeightsPut(request, env, origin) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return jsonResponse({ error: 'Invalid JSON body' }, 400, origin);
    }
    const weights = {};
    for (const k of SCORE_WEIGHT_KEYS) {
      const v = Number(body[k]);
      if (!Number.isFinite(v) || v < 0 || v > 100) {
        return jsonResponse({ error: `Invalid weight for '${k}' : must be a number between 0 and 100.` }, 400, origin);
      }
      weights[k] = Math.round(v * 100) / 100; // 2 decimals max
    }
    const sum = SCORE_WEIGHT_KEYS.reduce((s, k) => s + weights[k], 0);
    if (sum < 1) {
      return jsonResponse({ error: 'Sum of weights must be > 0' }, 400, origin);
    }
    if (sum > 200) {
      return jsonResponse({ error: `Sum of weights too high (${sum}) — max 200` }, 400, origin);
    }
    // Save (infinite TTL, ecrase la precedente config)
    await env.CACHE.put('config:score-weights', JSON.stringify(weights));
    return jsonResponse({ ok: true, weights, sum, savedAt: new Date().toISOString() }, 200, origin);
  } catch (err) {
    return jsonResponse({ error: err.message || String(err) }, 500, origin);
  }
}

// ============================================================
// ADMIN : déclenchement manuel du cron watchlist-digest
// ============================================================
async function handleAdminRunWatchlistCron(env, origin) {
  try {
    const started = Date.now();
    // runDailyWatchlistDigest est défini plus bas dans le fichier
    const result = await runDailyWatchlistDigest(env);
    const durationSec = Math.round((Date.now() - started) / 1000);
    return jsonResponse({
      ok: true,
      durationSec,
      result: result || { message: 'Cron exécuté' },
      timestamp: new Date().toISOString(),
    }, 200, origin);
  } catch (err) {
    console.error('Manual cron trigger failed:', err);
    return jsonResponse({
      ok: false,
      error: err.message || String(err),
    }, 500, origin);
  }
}

// ============================================================
// GOOGLE ANALYTICS 4 — Data API (intégration native dans admin)
// ============================================================
// On utilise un compte de service Google :
// - GA4_SERVICE_ACCOUNT_JSON : JSON complet de la clé du service account
// - GA4_PROPERTY_ID : ID numérique de la propriété GA4 (ex: 532249211)
// Stratégie : signer un JWT RS256 → exchange contre un access token OAuth → query Data API
// Token caché 50 min dans KV (validité Google = 1h)
// ============================================================

// Convert PEM (private key) → ArrayBuffer
function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(b64);
  const buf = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
  return buf;
}

function base64UrlEncode(input) {
  let str;
  if (input instanceof ArrayBuffer) {
    const bytes = new Uint8Array(input);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    str = btoa(bin);
  } else {
    str = btoa(input);
  }
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Génère un access token OAuth Google (depuis JWT signé)
async function getGoogleAccessToken(env) {
  // Cache token en KV pour éviter de re-signer à chaque requête
  const cached = await env.CACHE.get('ga4:access_token', 'json').catch(() => null);
  if (cached && cached.expiresAt > Math.floor(Date.now() / 1000) + 60) {
    return cached.token;
  }

  const sa = JSON.parse(env.GA4_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'RS256', typ: 'JWT', kid: sa.private_key_id };
  const claims = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const claimsB64 = base64UrlEncode(JSON.stringify(claims));
  const message = `${headerB64}.${claimsB64}`;

  const keyBuf = pemToArrayBuffer(sa.private_key);
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBuf,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(message));
  const sigB64 = base64UrlEncode(sigBuf);
  const jwt = `${message}.${sigB64}`;

  // Échange JWT → access token
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const data = await resp.json();
  if (!data.access_token) {
    console.error('GA4 token exchange failed:', data);
    throw new Error('GA4 token exchange failed: ' + (data.error_description || data.error || 'unknown'));
  }

  // Cache 50 min (validité réelle 60 min)
  await env.CACHE.put(
    'ga4:access_token',
    JSON.stringify({ token: data.access_token, expiresAt: now + 3000 }),
    { expirationTtl: 3000 }
  );
  return data.access_token;
}

// Appelle GA Data API : runReport
async function ga4RunReport(env, body) {
  const token = await getGoogleAccessToken(env);
  const propertyId = env.GA4_PROPERTY_ID;
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    console.error('GA4 runReport failed:', resp.status, errText);
    throw new Error(`GA4 API ${resp.status}: ${errText.slice(0, 200)}`);
  }
  return await resp.json();
}

// GET /api/admin/ga4-stats?days=7 → KPI + courbe + top pages + sources + pays
async function handleAdminGA4Stats(url, env, origin) {
  try {
    if (!env.GA4_SERVICE_ACCOUNT_JSON || !env.GA4_PROPERTY_ID) {
      return jsonResponse({ error: 'GA4 not configured (missing secrets)' }, 503, origin);
    }
    const days = Math.max(1, Math.min(90, parseInt(url.searchParams.get('days') || '7', 10)));
    const startDate = `${days}daysAgo`;
    const endDate = 'today';

    // Lance les 4 requêtes en parallèle
    const [summary, daily, topPages, sources] = await Promise.all([
      // Résumé : utilisateurs, sessions, pageviews, bounce
      ga4RunReport(env, {
        dateRanges: [{ startDate, endDate }],
        metrics: [
          { name: 'totalUsers' },
          { name: 'activeUsers' },
          { name: 'sessions' },
          { name: 'screenPageViews' },
          { name: 'bounceRate' },
          { name: 'averageSessionDuration' },
        ],
      }),
      // Courbe par jour
      ga4RunReport(env, {
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: 'date' }],
        metrics: [{ name: 'totalUsers' }, { name: 'screenPageViews' }],
        orderBys: [{ dimension: { dimensionName: 'date' } }],
      }),
      // Top pages (par pageviews)
      ga4RunReport(env, {
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
        metrics: [{ name: 'screenPageViews' }, { name: 'totalUsers' }],
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        limit: 10,
      }),
      // Sources de trafic
      ga4RunReport(env, {
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: 'sessionDefaultChannelGroup' }],
        metrics: [{ name: 'totalUsers' }, { name: 'sessions' }],
        orderBys: [{ metric: { metricName: 'totalUsers' }, desc: true }],
        limit: 10,
      }),
    ]);

    // Parse summary
    const sumRow = summary.rows?.[0]?.metricValues || [];
    const kpis = {
      totalUsers: parseInt(sumRow[0]?.value || '0', 10),
      activeUsers: parseInt(sumRow[1]?.value || '0', 10),
      sessions: parseInt(sumRow[2]?.value || '0', 10),
      pageViews: parseInt(sumRow[3]?.value || '0', 10),
      bounceRate: parseFloat(sumRow[4]?.value || '0'),
      avgSessionDuration: parseFloat(sumRow[5]?.value || '0'),
    };

    // Parse daily
    const series = (daily.rows || []).map(r => ({
      date: r.dimensionValues[0].value, // YYYYMMDD
      users: parseInt(r.metricValues[0].value, 10),
      pageViews: parseInt(r.metricValues[1].value, 10),
    }));

    // Parse top pages
    const pages = (topPages.rows || []).map(r => ({
      path: r.dimensionValues[0].value,
      title: r.dimensionValues[1].value,
      pageViews: parseInt(r.metricValues[0].value, 10),
      users: parseInt(r.metricValues[1].value, 10),
    }));

    // Parse sources
    const channels = (sources.rows || []).map(r => ({
      channel: r.dimensionValues[0].value,
      users: parseInt(r.metricValues[0].value, 10),
      sessions: parseInt(r.metricValues[1].value, 10),
    }));

    return jsonResponse({
      ok: true,
      days,
      kpis,
      series,
      topPages: pages,
      channels,
      generatedAt: new Date().toISOString(),
    }, 200, origin);
  } catch (err) {
    console.error('handleAdminGA4Stats error:', err);
    return jsonResponse({ error: err.message || 'Internal error' }, 500, origin);
  }
}

// GET /api/admin/traffic?days=7
// Interroge Cloudflare GraphQL Analytics API pour les stats de trafic de la zone.
// Requis en env : CF_ANALYTICS_TOKEN (API token avec Analytics:Read) + CF_ZONE_ID.
// Retourne : { series: [{ date, requests, pageViews, uniques }], total: {...}, granularity: 'day'|'hour' }
async function handleAdminTraffic(url, env, origin) {
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '7', 10), 1), 90);

  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ZONE_ID) {
    return jsonResponse({
      error: 'Cloudflare Analytics non configure',
      code: 'MISSING_CF_SECRETS',
      setup: [
        '1. Cree un API token sur https://dash.cloudflare.com/profile/api-tokens',
        '   Permissions requises : Zone > Analytics > Read',
        '2. Recupere le Zone ID de kairosinsider.fr (dashboard overview)',
        '3. Dans le dossier worker/ lance :',
        '   wrangler secret put CF_ANALYTICS_TOKEN',
        '   wrangler secret put CF_ZONE_ID',
        '4. Redeploy : wrangler deploy',
      ],
    }, 503, origin);
  }

  const today = new Date();
  const endDate = today.toISOString().slice(0, 10);
  const startDate = new Date(today.getTime() - (days - 1) * 86400 * 1000).toISOString().slice(0, 10);

  // Pour 1 jour, on utilise l'agregation horaire ; pour plus, agregation journaliere
  const granularity = days <= 1 ? 'hour' : 'day';

  let query;
  if (granularity === 'hour') {
    // Derniere 24h au granularity 1h
    const startDatetime = new Date(today.getTime() - 24 * 3600 * 1000).toISOString();
    query = {
      query: `query Traffic($zoneTag: String!, $startDatetime: Time!) {
        viewer {
          zones(filter: { zoneTag: $zoneTag }) {
            httpRequests1hGroups(
              limit: 48
              filter: { datetime_geq: $startDatetime }
              orderBy: [datetime_ASC]
            ) {
              dimensions { datetime }
              sum { requests bytes pageViews cachedRequests }
              uniq { uniques }
            }
          }
        }
      }`,
      variables: { zoneTag: env.CF_ZONE_ID, startDatetime },
    };
  } else {
    query = {
      query: `query Traffic($zoneTag: String!, $start: Date!, $end: Date!) {
        viewer {
          zones(filter: { zoneTag: $zoneTag }) {
            httpRequests1dGroups(
              limit: 100
              filter: { date_geq: $start, date_leq: $end }
              orderBy: [date_ASC]
            ) {
              dimensions { date }
              sum { requests bytes pageViews cachedRequests }
              uniq { uniques }
            }
          }
        }
      }`,
      variables: { zoneTag: env.CF_ZONE_ID, start: startDate, end: endDate },
    };
  }

  try {
    const resp = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.CF_ANALYTICS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(query),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return jsonResponse({
        error: 'Cloudflare GraphQL HTTP error',
        httpStatus: resp.status,
        detail: text.slice(0, 500),
      }, 502, origin);
    }
    const data = await resp.json();
    if (data.errors && data.errors.length) {
      return jsonResponse({
        error: 'Cloudflare GraphQL returned errors',
        errors: data.errors.map(e => ({ message: e.message, path: e.path })),
      }, 502, origin);
    }
    const zones = data.data?.viewer?.zones || [];
    const groups = zones[0]?.httpRequests1dGroups || zones[0]?.httpRequests1hGroups || [];

    const series = groups.map(g => ({
      key: g.dimensions.date || g.dimensions.datetime,
      requests: g.sum?.requests || 0,
      pageViews: g.sum?.pageViews || 0,
      bytes: g.sum?.bytes || 0,
      cached: g.sum?.cachedRequests || 0,
      uniques: g.uniq?.uniques || 0,
    }));

    // Totaux pour les KPIs
    const total = series.reduce((acc, p) => {
      acc.requests += p.requests;
      acc.pageViews += p.pageViews;
      acc.bytes += p.bytes;
      acc.cached += p.cached;
      acc.uniques += p.uniques; // Note: uniques d'une periode totale != somme des periodes (mais bonne approx pour affichage)
      return acc;
    }, { requests: 0, pageViews: 0, bytes: 0, cached: 0, uniques: 0 });

    return jsonResponse({
      days,
      granularity,
      start: granularity === 'hour' ? new Date(today.getTime() - 24 * 3600 * 1000).toISOString() : startDate,
      end: granularity === 'hour' ? today.toISOString() : endDate,
      series,
      total,
      cacheHitRate: total.requests ? Math.round((total.cached / total.requests) * 1000) / 10 : 0,
    }, 200, origin);
  } catch (e) {
    return jsonResponse({
      error: 'Cloudflare Analytics call failed',
      detail: String(e && e.message || e),
    }, 500, origin);
  }
}

// ============================================================
// ============================================================
// WATCHLIST + DAILY EMAIL DIGEST
// ============================================================
// Architecture :
//   - Le client ecrit /users/{uid}/watchlist dans Firebase RTDB (UI).
//   - Le client POST /api/watchlist/sync qui mirrored le tout en KV (cle wl:{uid}).
//   - Le cron (scheduled) parcourt env.CACHE.list({ prefix: 'wl:' }),
//     detecte les events sur chaque ticker (J vs J-1) et envoie un digest Brevo.
//   - Double opt-in via /watchlist/confirm?uid=X&token=Y (HMAC signe).
//   - Desabo 1 clic via /watchlist/unsubscribe?uid=X&token=Y.
//
// Donnees stockees (cle KV wl:{uid}) :
// {
//   email: "user@ex.com",
//   tickers: ["NVDA","AAPL"],
//   emailAlerts: true,
//   optIn: true,           // passe a true apres clic sur confirmation
//   optInSent: timestamp,  // pour ne pas renvoyer 10x
//   isPremium: bool,
//   updatedAt: timestamp,
//   lastDigestAt: timestamp (null si jamais envoye),
//   types: { insider:true, cluster:true, etf:true, score:true }
// }
// ============================================================

const WATCHLIST_FREE_LIMIT = 3;
const WATCHLIST_MAX_TICKERS = 100; // safety premium

// Liste des ETF a surveiller pour les rotations
const WATCHLIST_TRACKED_ETFS = [
  'NANC', 'GOP', 'GURU',
  'ARKK', 'ARKW', 'ARKG', 'ARKF', 'ARKQ',
  'BUZZ', 'MEME', 'JEPI', 'JEPQ',
  'ITA', 'URA', 'UFO', 'MJ',
];

// ============================================================
// HMAC tokens (opt-in / unsubscribe) - Web Crypto API
// ============================================================
async function hmacSha256(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  // Base64url encoding (compatible URL sans padding)
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function generateWatchlistToken(uid, action, env) {
  // action = 'confirm' ou 'unsub'
  const secret = env.WATCHLIST_SECRET || 'fallback-dev-secret-change-me';
  return hmacSha256(secret, `${action}:${uid}`);
}

async function verifyWatchlistToken(uid, action, token, env) {
  if (!token || !uid) return false;
  const expected = await generateWatchlistToken(uid, action, env);
  // Comparaison en temps constant
  if (expected.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

// ============================================================
// Validation d'un ticker (safe-list minimale)
// ============================================================
function normalizeWatchlistTicker(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const t = raw.trim().toUpperCase();
  if (!/^[A-Z0-9.\-]{1,12}$/.test(t)) return null;
  return t;
}

// ============================================================
// POST /api/watchlist/sync
// Body : { tickers: [...], emailAlerts: bool, types: {...} }
// Reponse : { ok, tickers, requiresOptIn: bool }
// ============================================================
async function handleWatchlistSync(request, env, user, isPremium, origin) {
  try {
    const body = await request.json().catch(() => ({}));
    const rawTickers = Array.isArray(body.tickers) ? body.tickers : [];
    const emailAlerts = body.emailAlerts !== false;

    // Normalisation + dedupe
    const seen = new Set();
    const tickers = [];
    for (const t of rawTickers) {
      const n = normalizeWatchlistTicker(t);
      if (n && !seen.has(n)) { seen.add(n); tickers.push(n); }
    }

    // Paywall : 3 tickers max en free
    const limit = isPremium ? WATCHLIST_MAX_TICKERS : WATCHLIST_FREE_LIMIT;
    if (tickers.length > limit) {
      return jsonResponse({
        error: isPremium ? 'Too many tickers' : 'Premium subscription required',
        code: isPremium ? 'LIMIT_EXCEEDED' : 'PREMIUM_REQUIRED',
        limit,
      }, 403, origin);
    }

    // Types d'evenements : whitelist
    const allowedTypes = ['insider', 'cluster', 'etf', 'score'];
    const types = {};
    const incomingTypes = (body.types && typeof body.types === 'object') ? body.types : {};
    for (const k of allowedTypes) types[k] = incomingTypes[k] !== false; // default true

    // Lire la config actuelle pour preserver optIn / lastDigestAt
    const existing = await env.CACHE.get(`wl:${user.uid}`, 'json') || {};
    const now = Date.now();

    const record = {
      email: user.email || existing.email || '',
      tickers,
      emailAlerts,
      types,
      isPremium,
      optIn: existing.optIn === true,
      optInSent: existing.optInSent || null,
      lastDigestAt: existing.lastDigestAt || null,
      updatedAt: now,
      createdAt: existing.createdAt || now,
    };

    await env.CACHE.put(`wl:${user.uid}`, JSON.stringify(record));

    // Si premiere inscription avec emailAlerts ON et pas de opt-in, envoyer le mail de confirmation
    let confirmationSent = false;
    if (emailAlerts && !record.optIn && tickers.length > 0 && record.email) {
      // Cooldown : ne pas renvoyer dans les 10 min
      const canSend = !record.optInSent || (now - record.optInSent > 10 * 60 * 1000);
      if (canSend) {
        try {
          await sendWatchlistOptinEmail(record.email, user.uid, tickers, env);
          record.optInSent = now;
          await env.CACHE.put(`wl:${user.uid}`, JSON.stringify(record));
          confirmationSent = true;
        } catch (e) {
          console.error('optin email failed:', e);
        }
      }
    }

    return jsonResponse({
      ok: true,
      tickers,
      optIn: record.optIn,
      emailAlerts,
      requiresOptIn: emailAlerts && !record.optIn,
      confirmationSent,
    }, 200, origin);
  } catch (err) {
    console.error('handleWatchlistSync:', err);
    return jsonResponse({ error: 'Internal error' }, 500, origin);
  }
}

// ============================================================
// GET /api/watchlist/get
// Retourne la watchlist + prefs du user courant
// ============================================================
async function handleWatchlistGet(env, user, origin) {
  const record = await env.CACHE.get(`wl:${user.uid}`, 'json') || {
    tickers: [], emailAlerts: true, optIn: false,
    types: { insider: true, cluster: true, etf: true, score: true },
  };
  return jsonResponse({
    ok: true,
    tickers: record.tickers || [],
    emailAlerts: record.emailAlerts !== false,
    optIn: record.optIn === true,
    types: record.types || { insider: true, cluster: true, etf: true, score: true },
    lastDigestAt: record.lastDigestAt || null,
  }, 200, origin);
}

// ============================================================
// POST /api/watchlist/test-now
// Genere un digest immediatement pour debug
// ============================================================
async function handleWatchlistTestNow(env, user, origin) {
  const record = await env.CACHE.get(`wl:${user.uid}`, 'json');
  if (!record || !record.tickers || record.tickers.length === 0) {
    return jsonResponse({ error: 'No watchlist tickers' }, 400, origin);
  }
  if (!record.email) {
    return jsonResponse({ error: 'No email on file' }, 400, origin);
  }

  const events = await detectEventsForWatchlist(record.tickers, record.types || {}, env);
  if (events.length === 0) {
    return jsonResponse({ ok: true, events: 0, sent: false, message: 'No events detected today' }, 200, origin);
  }

  try {
    await sendWatchlistDigestEmail(record.email, user.uid, events, env);
    record.lastDigestAt = Date.now();
    await env.CACHE.put(`wl:${user.uid}`, JSON.stringify(record));
    return jsonResponse({ ok: true, events: events.length, sent: true }, 200, origin);
  } catch (e) {
    console.error('test-now email failed:', e);
    return jsonResponse({ error: 'Email send failed', detail: String(e) }, 500, origin);
  }
}

// ============================================================
// GET /watchlist/confirm?uid=X&token=Y (public, depuis email)
// ============================================================
async function handleWatchlistConfirmOptin(url, env, origin) {
  const uid = url.searchParams.get('uid');
  const token = url.searchParams.get('token');
  const ok = await verifyWatchlistToken(uid, 'confirm', token, env);
  if (!ok) {
    return htmlResponse(watchlistPageTemplate({
      title: 'Lien invalide',
      message: 'Ce lien de confirmation n\'est pas valide ou a expire. Retournez sur votre dashboard pour en generer un nouveau.',
      cta: { href: 'https://kairosinsider.fr/dashboard.html', label: 'Retour au dashboard' },
      icon: '⚠️',
    }), 400);
  }

  const record = await env.CACHE.get(`wl:${uid}`, 'json');
  if (!record) {
    return htmlResponse(watchlistPageTemplate({
      title: 'Watchlist introuvable',
      message: 'Nous n\'avons pas trouve de watchlist associee a ce compte.',
      cta: { href: 'https://kairosinsider.fr/dashboard.html', label: 'Retour au dashboard' },
      icon: '❓',
    }), 404);
  }

  record.optIn = true;
  record.optInConfirmedAt = Date.now();
  await env.CACHE.put(`wl:${uid}`, JSON.stringify(record));

  return htmlResponse(watchlistPageTemplate({
    title: 'Confirmation enregistree ✓',
    message: `Parfait ! Vous recevrez desormais un digest quotidien a 8h si des evenements sont detectes sur vos ${(record.tickers || []).length} ticker(s) surveille(s).`,
    cta: { href: 'https://kairosinsider.fr/dashboard.html#watchlist', label: 'Gerer ma watchlist' },
    icon: '✅',
  }), 200);
}

// ============================================================
// GET /watchlist/unsubscribe?uid=X&token=Y (public, depuis email)
// ============================================================
async function handleWatchlistUnsubscribe(url, env, origin) {
  const uid = url.searchParams.get('uid');
  const token = url.searchParams.get('token');
  const ok = await verifyWatchlistToken(uid, 'unsub', token, env);
  if (!ok) {
    return htmlResponse(watchlistPageTemplate({
      title: 'Lien invalide',
      message: 'Ce lien de desabonnement n\'est pas valide.',
      cta: { href: 'https://kairosinsider.fr/dashboard.html', label: 'Retour au dashboard' },
      icon: '⚠️',
    }), 400);
  }
  const record = await env.CACHE.get(`wl:${uid}`, 'json');
  if (record) {
    record.emailAlerts = false;
    record.unsubscribedAt = Date.now();
    await env.CACHE.put(`wl:${uid}`, JSON.stringify(record));
  }
  return htmlResponse(watchlistPageTemplate({
    title: 'Desabonnement confirme',
    message: 'Vous ne recevrez plus de digest quotidien. Vous pouvez reactiver les alertes a tout moment depuis votre dashboard.',
    cta: { href: 'https://kairosinsider.fr/dashboard.html#watchlist', label: 'Reactiver les alertes' },
    icon: '👋',
  }), 200);
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function watchlistPageTemplate({ title, message, cta, icon }) {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — Kairos Insider</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; background:#0A0F1E; margin:0; padding:0; color:#F9FAFB; min-height:100vh; display:flex; align-items:center; justify-content:center; }
.card { max-width:480px; margin:20px; padding:40px 32px; background:#111827; border:1px solid rgba(255,255,255,0.08); border-radius:16px; text-align:center; }
.icon { font-size:48px; margin-bottom:16px; }
.logo { font-family:'Space Grotesk', Arial, sans-serif; font-size:18px; font-weight:700; background:linear-gradient(135deg,#3B82F6 0%,#8B5CF6 100%); -webkit-background-clip:text; color:transparent; margin-bottom:24px; }
h1 { font-size:24px; margin:0 0 14px; font-weight:700; }
p { font-size:15px; line-height:1.6; color:#9CA3AF; margin:0 0 24px; }
.btn { display:inline-block; background:linear-gradient(135deg,#3B82F6,#8B5CF6); color:#fff !important; padding:14px 28px; border-radius:10px; text-decoration:none; font-weight:600; font-size:15px; }
</style></head><body><div class="card">
<div class="logo">Kairos Insider</div>
<div class="icon">${icon || ''}</div>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
${cta ? `<a href="${escapeHtml(cta.href)}" class="btn">${escapeHtml(cta.label)}</a>` : ''}
</div></body></html>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ============================================================
// DETECTION D'EVENEMENTS pour une watchlist
// Retourne une liste d'events groupes par ticker :
// [{ ticker, events: [{ type, severity, summary, url }] }]
// ============================================================
async function detectEventsForWatchlist(tickers, types, env) {
  const tickerSet = new Set(tickers.map(t => t.toUpperCase()));
  const results = new Map(); // ticker -> events[]
  const pushEvt = (ticker, evt) => {
    if (!results.has(ticker)) results.set(ticker, []);
    results.get(ticker).push(evt);
  };

  // ----- 1) Clusters insiders (KV insider-clusters) -----
  // On compare avec un snapshot precedent stocke en KV sous 'wl-prev:clusters'
  if (types.cluster !== false) {
    try {
      const curr = await env.CACHE.get('insider-clusters', 'json');
      const prev = await env.CACHE.get('wl-prev:clusters', 'json');
      const prevMap = new Map();
      (prev?.clusters || []).forEach(c => { if (c.ticker) prevMap.set(c.ticker.toUpperCase(), c); });

      for (const c of (curr?.clusters || [])) {
        const tk = (c.ticker || '').toUpperCase();
        if (!tk || !tickerSet.has(tk)) continue;

        const prevC = prevMap.get(tk);
        const isNew = !prevC;
        const insidersChanged = prevC && c.insiderCount !== prevC.insiderCount;

        if (isNew && c.insiderCount >= 2) {
          pushEvt(tk, {
            type: 'cluster',
            severity: c.insiderCount >= 3 ? 'high' : 'medium',
            title: `🚨 Nouveau cluster insider detecte`,
            summary: `${c.insiderCount} dirigeants de ${c.company || tk} ont depose une declaration recente${c.totalValue ? ' (total estime ~' + fmtUsdShort(c.totalValue) + ')' : ''}.`,
          });
        } else if (insidersChanged && c.insiderCount > prevC.insiderCount) {
          pushEvt(tk, {
            type: 'cluster',
            severity: 'medium',
            title: `📈 Cluster insider renforce`,
            summary: `${prevC.insiderCount} → ${c.insiderCount} dirigeants actifs chez ${c.company || tk}.`,
          });
        }
      }

      // Stocke le snapshot courant pour le diff du lendemain
      if (curr) await env.CACHE.put('wl-prev:clusters', JSON.stringify(curr));
    } catch (e) {
      console.error('cluster detect failed:', e);
    }
  }

  // ----- 2) Rotations ETF (snapshots J-1 vs J en KV par ETF) -----
  // Pour chaque ETF, on compare etf-{symbol} courant vs wl-prev:etf-{symbol}
  if (types.etf !== false) {
    for (const symbol of WATCHLIST_TRACKED_ETFS) {
      try {
        const kvKey = etfKvKeyFor(symbol);
        const curr = await env.CACHE.get(kvKey, 'json');
        if (!curr || !curr.holdings) continue;

        const prevKey = `wl-prev:etf-${symbol.toLowerCase()}`;
        const prev = await env.CACHE.get(prevKey, 'json');

        if (prev && prev.holdings) {
          const prevTickers = new Set((prev.holdings || []).map(h => (h.ticker || '').toUpperCase()));
          const currTickers = new Set((curr.holdings || []).map(h => (h.ticker || '').toUpperCase()));

          // Entrees
          for (const tk of currTickers) {
            if (!tk || !tickerSet.has(tk) || prevTickers.has(tk)) continue;
            pushEvt(tk, {
              type: 'etf',
              severity: 'medium',
              title: `💼 Entree dans l'ETF ${symbol}`,
              summary: `${tk} vient d'entrer dans ${symbol} (${etfLabelFor(symbol)}).`,
            });
          }
          // Sorties
          for (const tk of prevTickers) {
            if (!tk || !tickerSet.has(tk) || currTickers.has(tk)) continue;
            pushEvt(tk, {
              type: 'etf',
              severity: 'medium',
              title: `📤 Sortie de l'ETF ${symbol}`,
              summary: `${tk} a ete retire de ${symbol} (${etfLabelFor(symbol)}).`,
            });
          }
        }

        // Snapshot pour demain
        await env.CACHE.put(prevKey, JSON.stringify(curr));
      } catch (e) {
        console.error(`ETF ${symbol} detect failed:`, e);
      }
    }
  }

  // ----- 3) Variation du Kairos Score (D1 score_history sur 2 jours) -----
  if (types.score !== false && env.HISTORY) {
    for (const tk of tickers) {
      try {
        const stmt = env.HISTORY.prepare(
          'SELECT date, total FROM score_history WHERE ticker = ? ORDER BY date DESC LIMIT 2'
        );
        const { results: rows } = await stmt.bind(tk).all();
        if (rows && rows.length >= 2) {
          const today = rows[0].total;
          const prev = rows[1].total;
          if (today != null && prev != null) {
            const diff = today - prev;
            if (Math.abs(diff) >= 10) {
              pushEvt(tk, {
                type: 'score',
                severity: Math.abs(diff) >= 20 ? 'high' : 'medium',
                title: diff > 0 ? `📊 Kairos Score en hausse` : `📉 Kairos Score en baisse`,
                summary: `${prev} → ${today} (${diff > 0 ? '+' : ''}${diff} points).`,
              });
            }
          }
        }
      } catch (e) {
        console.error(`score detect ${tk} failed:`, e);
      }
    }
  }

  // ----- 4) Fonds offensifs (13D/G) — nouvelles déclarations dans les 7 derniers jours
  if (types.activist !== false) {
    try {
      const data = await env.CACHE.get('13dg-recent', 'json');
      if (data && Array.isArray(data.filings)) {
        const cutoff = new Date(Date.now() - 7 * 86400 * 1000).toISOString().slice(0, 10);
        for (const f of data.filings) {
          const tk = (f.ticker || '').toUpperCase();
          if (!tk || !tickerSet.has(tk)) continue;
          if ((f.fileDate || '') < cutoff) continue; // trop vieux (snapshot J-1 pour dedup fait par KV 'wl-prev:13dg')

          // Severity : high si activist connu ou %>=5, medium sinon
          const isActivist = !!f.isActivist;
          const pct = f.percentOfClass;
          const shares = f.sharesOwned;
          const priceApprox = f.purchasePriceApprox;

          // Construction du titre + summary enrichis
          const formShort = (f.form || '').replace('SCHEDULE ', '').trim();
          const stats = [];
          if (pct != null) stats.push(`${pct.toFixed(1)}% du capital`);
          if (shares != null) {
            const s = shares >= 1e9 ? (shares/1e9).toFixed(1)+'B' : shares >= 1e6 ? (shares/1e6).toFixed(1)+'M' : shares >= 1e3 ? (shares/1e3).toFixed(0)+'K' : String(Math.round(shares));
            stats.push(`${s} titres`);
          }
          if (priceApprox != null) {
            const p = priceApprox >= 1e9 ? '$'+(priceApprox/1e9).toFixed(2)+'B' : priceApprox >= 1e6 ? '$'+(priceApprox/1e6).toFixed(1)+'M' : '$'+Math.round(priceApprox/1e3)+'K';
            stats.push(`~${p} investis`);
          }

          pushEvt(tk, {
            type: 'activist',
            severity: isActivist ? 'high' : 'medium',
            title: isActivist
              ? `⚡ Fonds offensif détecté (${formShort})`
              : `📋 Nouveau gros actionnaire (${formShort})`,
            summary: `${f.filerName || 'Investisseur'} vient de déclarer${stats.length ? ' · ' + stats.join(' · ') : ' >5% du capital'}.`,
          });
        }
      }
    } catch (e) {
      console.error('activist detect failed:', e);
    }
  }

  // Resultat : un tableau [{ ticker, events }] trie par severite descendante
  const out = [];
  for (const [ticker, events] of results.entries()) {
    // Tri interne : high d'abord
    events.sort((a, b) => (b.severity === 'high' ? 1 : 0) - (a.severity === 'high' ? 1 : 0));
    out.push({ ticker, events });
  }
  // Priorise les tickers avec evenement 'high'
  out.sort((a, b) => {
    const aHigh = a.events.some(e => e.severity === 'high') ? 1 : 0;
    const bHigh = b.events.some(e => e.severity === 'high') ? 1 : 0;
    return bHigh - aHigh;
  });
  return out;
}

function etfKvKeyFor(symbol) {
  const s = symbol.toUpperCase();
  if (s === 'NANC' || s === 'GOP') return `etf-congress-${s.toLowerCase()}`;
  if (s === 'GURU') return 'etf-guru';
  if (s.startsWith('ARK')) return `etf-ark-${s.toLowerCase()}`;
  return `etf-${s.toLowerCase()}`;
}

function etfLabelFor(symbol) {
  const s = symbol.toUpperCase();
  const labels = {
    NANC: 'Democrates US', GOP: 'Republicains US',
    GURU: 'Top 60 hedge funds',
    ARKK: 'ARK Innovation', ARKW: 'ARK Internet', ARKG: 'ARK Biotech',
    ARKF: 'ARK Fintech', ARKQ: 'ARK Robotique',
    BUZZ: 'Social Sentiment', MEME: 'Reddit/WSB',
    JEPI: 'JPM Equity Premium', JEPQ: 'JPM Nasdaq Premium',
    ITA: 'Defense & Aerospace', URA: 'Uranium', UFO: 'Espace', MJ: 'Cannabis',
  };
  return labels[s] || s;
}

function fmtUsdShort(n) {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'Md';
  if (abs >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'k';
  return '$' + Math.round(n);
}

// ============================================================
// CRON : Daily digest (7h15 UTC = 8h15 Paris ete / 7h15 hiver)
// ============================================================
// ============================================================
// HEALTH CHECK : alerte admin si 0 jobs OK dans les 24h
// Tourne dans scheduled() chaque jour à 6h15 UTC
// Cooldown 20h pour éviter de spammer
// ============================================================
async function runHealthCheck(env) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const HOURS_STALE = 24 * 3600;

    // Cooldown : skip si déjà alerté dans les 20 dernières heures
    const lastAlert = await env.CACHE.get('health:last-alert', 'json').catch(() => null);
    if (lastAlert && lastAlert.ts && (now - lastAlert.ts) < 20 * 3600) {
      log.info('health.alert.cooldown_active');
      return;
    }

    // Collecte tous les lastRun
    const keys = await listAllKvKeys(env, 'lastRun:', 200).catch(() => []);
    const jobs = [];
    for (const k of keys) {
      const data = await env.CACHE.get(k, 'json').catch(() => null);
      if (!data) continue;
      jobs.push({
        name: k.slice('lastRun:'.length),
        ts: data.ts || 0,
        status: data.status || 'unknown',
        error: data.error || '',
      });
    }
    // Ajoute le cron watchlist
    const cronData = await env.CACHE.get('wl-last-cron-run', 'json').catch(() => null);
    if (cronData) {
      jobs.push({
        name: 'cron-watchlist-digest',
        ts: cronData.ts || 0,
        status: cronData.status || 'ok',
        error: cronData.error || '',
      });
    }

    const anomalies = [];
    const recentOk = jobs.filter(j => j.status === 'ok' && (now - j.ts) < HOURS_STALE);
    const recentFail = jobs.filter(j => j.status === 'failed' && (now - j.ts) < HOURS_STALE);
    const stale = jobs.filter(j => j.ts > 0 && (now - j.ts) > 2 * HOURS_STALE); // > 48h

    if (jobs.length === 0) {
      anomalies.push('Aucun job enregistré dans KV (pipeline totalement silencieux)');
    } else if (recentOk.length === 0) {
      anomalies.push(`0 jobs OK dans les 24h sur ${jobs.length} enregistrés`);
    }
    if (recentFail.length > 0) {
      anomalies.push(`${recentFail.length} job(s) en erreur dans les 24h : ${recentFail.map(j => j.name).join(', ')}`);
    }
    if (stale.length > 0) {
      anomalies.push(`${stale.length} job(s) stale (>48h) : ${stale.map(j => j.name).join(', ')}`);
    }

    if (anomalies.length === 0) {
      log.info('health.ok', { totalJobs: jobs.length, recentOk: recentOk.length });
      // Log le health OK pour le dashboard
      await env.CACHE.put('health:last-check', JSON.stringify({
        ts: now, status: 'ok', jobs: jobs.length, recentOk: recentOk.length,
      }), { expirationTtl: 7 * 86400 });
      return;
    }

    log.warn('health.anomalies_detected', { anomalies, totalJobs: jobs.length });
    await env.CACHE.put('health:last-check', JSON.stringify({
      ts: now, status: 'anomaly', jobs: jobs.length, recentOk: recentOk.length,
      anomalies,
    }), { expirationTtl: 7 * 86400 });

    // Envoi email admin via Brevo
    const adminEmail = env.SUPPORT_INBOX_EMAIL || 'natquinson@gmail.com';
    const html = `
      <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1F2937">
        <h2 style="color:#EF4444;border-bottom:2px solid #EF4444;padding-bottom:8px">🚨 Health check alerte</h2>
        <p>Le health check quotidien du pipeline Kairos Insider a détecté des anomalies :</p>
        <ul style="line-height:1.8">
          ${anomalies.map(a => `<li style="color:#1F2937">${a.replace(/</g, '&lt;')}</li>`).join('')}
        </ul>
        <h3 style="margin-top:24px;font-size:14px;color:#6B7280">État des jobs</h3>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead>
            <tr style="background:#F3F4F6"><th style="padding:8px;text-align:left">Job</th><th style="padding:8px">Status</th><th style="padding:8px">Âge</th></tr>
          </thead>
          <tbody>
            ${jobs.sort((a,b) => (b.ts||0)-(a.ts||0)).slice(0, 15).map(j => {
              const ageSec = j.ts ? (now - j.ts) : 0;
              const age = j.ts ? Math.round(ageSec / 3600) + 'h' : '—';
              // Un job peut etre "ok" en dernier run mais n'avoir pas tourne
              // depuis >48h (ex. GitHub Action kill par timeout). Le status STALE
              // a priorite sur l'ancien status "ok" pour eviter un faux positif.
              const isStale = j.ts > 0 && ageSec > 2 * HOURS_STALE;
              const displayStatus = isStale ? 'STALE' : j.status.toUpperCase();
              const color = isStale ? '#F59E0B'
                          : j.status === 'ok' ? '#10B981'
                          : j.status === 'failed' ? '#EF4444'
                          : '#F59E0B';
              const ageColor = isStale ? '#F59E0B' : '#6B7280';
              const ageWeight = isStale ? '600' : '400';
              return `<tr style="border-bottom:1px solid #E5E7EB">
                <td style="padding:8px">${j.name.replace(/</g, '&lt;')}</td>
                <td style="padding:8px;color:${color};font-weight:600">${displayStatus}</td>
                <td style="padding:8px;color:${ageColor};font-weight:${ageWeight}">${age}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
        <div style="margin-top:20px;padding:12px;background:#FEF3C7;border-radius:6px;font-size:12px">
          💡 Accède au dashboard admin : <a href="https://kairosinsider.fr/dashboard.html#admin" style="color:#3B82F6">kairosinsider.fr/dashboard.html</a>
        </div>
      </div>`;

    try {
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': env.BREVO_API_KEY,
          'Content-Type': 'application/json',
          'accept': 'application/json',
        },
        body: JSON.stringify({
          sender: { name: 'Kairos Health Check', email: env.BREVO_SENDER_EMAIL || 'contact@kairosinsider.fr' },
          to: [{ email: adminEmail, name: 'Admin' }],
          subject: `🚨 [Kairos Alert] ${anomalies.length} anomalie${anomalies.length > 1 ? 's' : ''} détectée${anomalies.length > 1 ? 's' : ''}`,
          htmlContent: html,
        }),
      });
      await env.CACHE.put('health:last-alert', JSON.stringify({ ts: now, anomalies }), { expirationTtl: 7 * 86400 });
      log.info('health.alert_email_sent', { to: adminEmail });
    } catch (e) {
      console.error('[health] Brevo send failed:', e);
    }
  } catch (err) {
    console.error('[health] runHealthCheck exception:', err);
  }
}

async function runDailyWatchlistDigest(env) {
  const started = Date.now();
  let scanned = 0, sent = 0, skipped = 0, errors = 0;

  try {
    // Iterer sur toutes les cles wl:*
    let cursor = undefined;
    do {
      const listResp = await env.CACHE.list({ prefix: 'wl:', cursor });
      for (const key of listResp.keys) {
        scanned++;
        try {
          const record = await env.CACHE.get(key.name, 'json');
          if (!record) { skipped++; continue; }
          if (!record.emailAlerts) { skipped++; continue; }
          if (!record.optIn) { skipped++; continue; }
          if (!record.email) { skipped++; continue; }
          if (!Array.isArray(record.tickers) || record.tickers.length === 0) { skipped++; continue; }

          const events = await detectEventsForWatchlist(record.tickers, record.types || {}, env);
          if (events.length === 0) { skipped++; continue; }

          // Extrait uid depuis la cle (wl:{uid})
          const uid = key.name.slice(3);
          await sendWatchlistDigestEmail(record.email, uid, events, env);

          record.lastDigestAt = Date.now();
          await env.CACHE.put(key.name, JSON.stringify(record));
          sent++;
        } catch (e) {
          console.error('cron error on', key.name, ':', e);
          errors++;
        }
      }
      cursor = listResp.list_complete ? undefined : listResp.cursor;
    } while (cursor);
  } catch (e) {
    console.error('[cron] top-level failure:', e);
  }

  const duration = Date.now() - started;
  console.log(`[cron] watchlist digest done: scanned=${scanned} sent=${sent} skipped=${skipped} errors=${errors} duration=${duration}ms`);
  // Log dans KV pour observabilite (format unifie lastRun:*)
  const now = new Date();
  await env.CACHE.put('wl-last-cron-run', JSON.stringify({
    ts: Math.floor(now.getTime() / 1000),
    iso: now.toISOString(),
    status: errors > 0 ? 'partial' : 'ok',
    durationSec: Math.round(duration / 100) / 10,
    summary: `scanned=${scanned} sent=${sent} skipped=${skipped} errors=${errors}`,
    emailsSent: sent,
    // Ancien format conserve pour backcompat
    at: now.toISOString(), scanned, sent, skipped, errors, duration,
  }));
}

// ============================================================
// EMAIL : Digest watchlist (HTML inline via Brevo)
// ============================================================
async function sendWatchlistDigestEmail(email, uid, tickersEvents, env) {
  if (!email || !uid || !Array.isArray(tickersEvents) || tickersEvents.length === 0) return;

  const unsubToken = await generateWatchlistToken(uid, 'unsub', env);
  const unsubUrl = `https://kairos-insider-api.natquinson.workers.dev/watchlist/unsubscribe?uid=${encodeURIComponent(uid)}&token=${unsubToken}`;
  const dashUrl = 'https://kairosinsider.fr/dashboard.html#watchlist';

  const totalEvents = tickersEvents.reduce((s, t) => s + t.events.length, 0);
  const hasHigh = tickersEvents.some(t => t.events.some(e => e.severity === 'high'));

  const subject = hasHigh
    ? `🚨 ${totalEvents} evenements sur votre watchlist (dont signaux forts)`
    : `Digest Kairos — ${totalEvents} evenement${totalEvents > 1 ? 's' : ''} sur vos ${tickersEvents.length} ticker${tickersEvents.length > 1 ? 's' : ''}`;

  const dateStr = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

  const cards = tickersEvents.map(t => {
    const actionUrl = `https://kairosinsider.fr/action.html?ticker=${encodeURIComponent(t.ticker)}`;
    const evtRows = t.events.map(e => `
      <div style="padding:10px 12px;background:rgba(59,130,246,0.04);border-left:3px solid ${severityColor(e.severity)};border-radius:6px;margin:8px 0">
        <div style="font-weight:600;color:#F9FAFB;font-size:14px;margin-bottom:4px">${escapeHtml(e.title)}</div>
        <div style="color:#9CA3AF;font-size:13px;line-height:1.5">${escapeHtml(e.summary)}</div>
      </div>
    `).join('');
    return `
      <div style="background:#111827;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:20px;margin-bottom:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <div style="font-family:'Space Grotesk',Arial,sans-serif;font-size:18px;font-weight:700;color:#F9FAFB">${escapeHtml(t.ticker)}</div>
          <a href="${actionUrl}" style="color:#3B82F6;font-size:12px;text-decoration:none;font-weight:600">Voir l'analyse →</a>
        </div>
        ${evtRows}
      </div>
    `;
  }).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; background:#0A0F1E; margin:0; padding:0; color:#F9FAFB; }
.wrap { max-width:620px; margin:0 auto; padding:32px 20px; }
.logo { font-family:'Space Grotesk', Arial, sans-serif; font-size:22px; font-weight:700; background:linear-gradient(135deg,#3B82F6 0%,#8B5CF6 100%); -webkit-background-clip:text; color:transparent; margin-bottom:8px; }
.date { color:#6B7280; font-size:12px; margin-bottom:24px; }
h1 { font-size:22px; margin:0 0 10px; color:#F9FAFB; line-height:1.3; font-weight:700; }
.intro { color:#9CA3AF; font-size:14px; margin-bottom:24px; }
.btn { display:inline-block; background:linear-gradient(135deg,#3B82F6 0%,#8B5CF6 100%); color:#fff !important; padding:12px 24px; border-radius:10px; text-decoration:none; font-weight:600; font-size:14px; }
.footer { text-align:center; color:#6B7280; font-size:11px; margin-top:32px; padding-top:24px; border-top:1px solid rgba(255,255,255,0.05); line-height:1.8; }
.footer a { color:#9CA3AF; text-decoration:none; margin:0 8px; }
</style></head>
<body><div class="wrap">
<div class="logo">Kairos Insider</div>
<div class="date">Digest du ${dateStr}</div>
<h1>${totalEvents} evenement${totalEvents > 1 ? 's' : ''} detecte${totalEvents > 1 ? 's' : ''} sur votre watchlist</h1>
<p class="intro">Voici les mouvements smart-money reperes ce matin sur vos ${tickersEvents.length} ticker${tickersEvents.length > 1 ? 's' : ''} surveille${tickersEvents.length > 1 ? 's' : ''} :</p>
${cards}
<div style="text-align:center;margin:24px 0"><a href="${dashUrl}" class="btn">Ouvrir mon dashboard →</a></div>
<div class="footer">
  <p style="margin:0">Kairos Insider — Voyez ce que les pros voient.</p>
  <p style="margin:8px 0 0">
    <a href="${dashUrl}">Gerer mes preferences</a> · <a href="${unsubUrl}">Me desabonner</a>
  </p>
  <p style="margin:8px 0 0">
    <a href="https://kairosinsider.fr/cgv.html">CGV</a> · <a href="https://kairosinsider.fr/privacy.html">Confidentialite</a>
  </p>
</div>
</div></body></html>`;

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
      subject,
      htmlContent: html,
      replyTo: { email: env.BREVO_SENDER_EMAIL || 'contact@kairosinsider.fr', name: 'Kairos Insider' },
      headers: {
        'List-Unsubscribe': `<${unsubUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Brevo digest ${resp.status}: ${errText}`);
  }
  console.log(`[watchlist] digest sent to ${email} (${totalEvents} events)`);
}

function severityColor(s) {
  if (s === 'high') return '#EF4444';
  if (s === 'medium') return '#3B82F6';
  return '#6B7280';
}

// ============================================================
// EMAIL : Double opt-in (confirmation initiale)
// ============================================================
async function sendWatchlistOptinEmail(email, uid, tickers, env) {
  const confirmToken = await generateWatchlistToken(uid, 'confirm', env);
  const confirmUrl = `https://kairos-insider-api.natquinson.workers.dev/watchlist/confirm?uid=${encodeURIComponent(uid)}&token=${confirmToken}`;

  const tickersHtml = tickers.slice(0, 10).map(t => `<code style="background:rgba(59,130,246,0.15);color:#60A5FA;padding:2px 8px;border-radius:4px;font-family:'SF Mono',Consolas,monospace;font-size:13px;margin:0 4px">${escapeHtml(t)}</code>`).join('');
  const moreHint = tickers.length > 10 ? `<span style="color:#9CA3AF">et ${tickers.length - 10} autres</span>` : '';

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; background:#0A0F1E; margin:0; padding:0; color:#F9FAFB; }
.wrap { max-width:560px; margin:0 auto; padding:32px 20px; }
.card { background:#111827; border:1px solid rgba(255,255,255,0.08); border-radius:16px; padding:36px 28px; }
.logo { font-family:'Space Grotesk', Arial, sans-serif; font-size:22px; font-weight:700; background:linear-gradient(135deg,#3B82F6 0%,#8B5CF6 100%); -webkit-background-clip:text; color:transparent; margin-bottom:24px; }
h1 { font-size:24px; margin:0 0 14px; font-weight:700; }
p { font-size:14px; line-height:1.65; color:#9CA3AF; margin:0 0 16px; }
.btn { display:inline-block; background:linear-gradient(135deg,#3B82F6 0%,#8B5CF6 100%); color:#fff !important; padding:14px 28px; border-radius:10px; text-decoration:none; font-weight:600; font-size:15px; margin:8px 0; }
.footer { text-align:center; color:#6B7280; font-size:11px; margin-top:24px; padding-top:20px; border-top:1px solid rgba(255,255,255,0.05); }
</style></head>
<body><div class="wrap"><div class="card">
<div class="logo">Kairos Insider</div>
<h1>Confirmez votre watchlist ⭐</h1>
<p>Vous venez d'ajouter ${tickers.length} ticker${tickers.length > 1 ? 's' : ''} a votre watchlist :</p>
<p style="line-height:2.4">${tickersHtml} ${moreHint}</p>
<p>Pour recevoir un digest quotidien a 8h avec les evenements smart-money detectes (insiders, hedge funds, rotations ETF, variation Kairos Score), confirmez simplement votre adresse en cliquant ci-dessous :</p>
<p style="text-align:center"><a href="${confirmUrl}" class="btn">✓ Confirmer mes alertes quotidiennes</a></p>
<p style="font-size:12px;color:#6B7280">Si vous n'avez pas ajoute ces tickers, vous pouvez ignorer cet email. Aucune alerte ne sera envoyee sans confirmation.</p>
<div class="footer">
  <p style="margin:0">Kairos Insider — Voyez ce que les pros voient.</p>
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
      subject: 'Confirmez votre watchlist Kairos Insider',
      htmlContent: html,
      replyTo: { email: env.BREVO_SENDER_EMAIL || 'contact@kairosinsider.fr', name: 'Kairos Insider' },
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Brevo optin ${resp.status}: ${errText}`);
  }
}
