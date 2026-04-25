/**
 * Kairos Insider — Radar Portefeuille (Auto-sync API)
 *
 * Endpoints :
 *   GET  /api/portfolio/brokers           → liste des brokers supportés + leur statut
 *   GET  /api/portfolio/connections       → connexions actives de l'utilisateur
 *   POST /api/portfolio/connect           → crée une nouvelle connexion (stocke creds chiffrées en KV)
 *   POST /api/portfolio/disconnect        → révoque une connexion
 *   POST /api/portfolio/sync              → déclenche un sync manuel
 *   GET  /api/portfolio/positions         → positions live (join Kairos Score + alertes)
 *   GET  /api/portfolio/snapshots         → historique valeur portefeuille (pour chart équité)
 *   GET  /api/portfolio/alerts            → alertes smart money sur les positions détenues
 *
 * Sécurité :
 *   - Les credentials broker sont chiffrés via Web Crypto API (AES-GCM) avec
 *     un secret dérivé de env.PORTFOLIO_ENCRYPTION_KEY + user.uid (clé par utilisateur).
 *   - Stockés en KV (pas en D1) car on ne veut JAMAIS les lire dans une query
 *     accidentelle de debug/admin.
 *   - La clé KV est référencée dans portfolio_connections.credentials_kv_key.
 *
 * Broker adapters (modulaire) :
 *   - Chaque broker = 1 module avec { fetchPositions(creds), validateCreds(creds) }
 *   - Interface commune → facile d'ajouter Interactive Brokers, Saxo, etc.
 *   - Phase 1 : IG Markets (prioritaire, API REST officielle FR)
 *   - Phase 2 : IBKR (Client Portal Gateway), Saxo (OpenAPI), Trade Republic (reverse eng)
 *
 * Rate limiting sync :
 *   - Max 1 sync manuel toutes les 60 sec (éviter spam API broker)
 *   - Cron quotidien 7h Paris : sync auto pour toutes les connexions 'active'
 */

// ============================================================
// CATALOGUE DES BROKERS SUPPORTÉS
// ============================================================
// Chaque broker a un statut : 'live' | 'beta' | 'soon' | 'csv'
//   live = connexion API opérationnelle
//   beta = en test, connexion possible mais instable
//   soon = roadmap, non encore implémenté
//   csv  = uniquement import CSV (pas d'API disponible publiquement)

export const SUPPORTED_BROKERS = [
  {
    id: 'ig',
    name: 'IG Markets',
    country: 'UK/FR',
    flag: '🇬🇧',
    logo: '/assets/brokers/ig.png',
    status: 'live',                           // ✅ Phase 2 : adapter IG actif
    description: 'API REST officielle · 17 000 produits · FR/UK/DE',
    authFields: [
      { name: 'username', label: 'Nom d\'utilisateur IG', type: 'text', required: true, placeholder: 'Le même qu\'à la connexion sur ig.com' },
      { name: 'password', label: 'Mot de passe', type: 'password', required: true },
      { name: 'apiKey',   label: 'Clé API', type: 'text', required: true, placeholder: 'Format : 32+ caractères alphanum' },
      { name: 'environment', label: 'Environnement', type: 'select', options: ['demo', 'live'], default: 'live', required: true },
    ],
    docsUrl: 'https://labs.ig.com/gettingstarted',
    // Bloc d'aide affiché au-dessus du form (checklist 4 points)
    helpHtml: `<div style="background:rgba(59,130,246,0.05);border:1px solid rgba(59,130,246,0.25);border-radius:10px;padding:12px 14px;margin-bottom:16px;font-size:12px;line-height:1.55;color:var(--text-secondary)">
      <strong style="color:var(--accent-blue);display:block;margin-bottom:6px">📋 Checklist avant connexion :</strong>
      <ol style="margin:0;padding-left:18px">
        <li><strong>Clé API distincte par environnement</strong> : la clé "live" ne marche pas en demo et vice-versa. Génère la bonne sur <a href="https://www.ig.com/uk/myig/settings/api-keys" target="_blank" rel="noopener" style="color:var(--accent-blue)">My IG → Settings → API Keys</a>.</li>
        <li><strong>Active la clé après création</strong> (statut doit être "Enabled", pas "Disabled").</li>
        <li><strong>Pas de 2FA bloquante</strong> : si tu as activé le 2FA SMS, l'API peut le contourner. Si tu as activé le 2FA app, ça marche aussi.</li>
        <li><strong>Pas d'IP whitelist trop stricte</strong> : si tu as restreint la clé à une IP spécifique, le worker Kairos (Cloudflare edge, IP variable) ne pourra pas se connecter. <strong>Désactive la restriction IP</strong> sur la clé.</li>
      </ol>
    </div>`,
  },
  {
    id: 'ibkr',
    name: 'Interactive Brokers',
    country: 'US',
    flag: '🇺🇸',
    logo: '/assets/brokers/ibkr.png',
    status: 'soon',
    description: 'Client Portal Gateway · Institutionnel · Pro traders',
    authFields: [],
    docsUrl: 'https://www.interactivebrokers.com/api/doc.html',
  },
  {
    id: 'saxo',
    name: 'Saxo Bank',
    country: 'DK/FR',
    flag: '🇩🇰',
    logo: '/assets/brokers/saxo.png',
    status: 'soon',
    description: 'OpenAPI OAuth2 · Multi-asset · Institutionnel',
    authFields: [],
    docsUrl: 'https://www.developer.saxo/openapi/learn',
  },
  {
    id: 'trade-republic',
    name: 'Trade Republic',
    country: 'DE/FR',
    flag: '🇩🇪',
    logo: '/assets/brokers/trade-republic.png',
    status: 'soon',
    description: 'Broker retail populaire en France · Pas d\'API officielle',
    authFields: [],
    docsUrl: null,
  },
  {
    id: 'degiro',
    name: 'Degiro (flatexDEGIRO)',
    country: 'NL/FR',
    flag: '🇳🇱',
    logo: '/assets/brokers/degiro.png',
    status: 'soon',
    description: 'Discount broker européen · Pas d\'API officielle',
    authFields: [],
    docsUrl: null,
  },
  {
    id: 'boursorama',
    name: 'BoursoBank (Boursorama)',
    country: 'FR',
    flag: '🇫🇷',
    logo: '/assets/brokers/boursorama.png',
    status: 'soon',
    description: 'Banque en ligne · Bourse · Reverse engineering possible via DSP2',
    authFields: [],
    docsUrl: null,
  },
  {
    id: 'etoro',
    name: 'eToro',
    country: 'IL',
    flag: '🇮🇱',
    logo: '/assets/brokers/etoro.png',
    status: 'soon',
    description: 'Social trading · Crypto + actions · API partenaire fermée',
    authFields: [],
    docsUrl: null,
  },
  {
    id: 'bourse-direct',
    name: 'Bourse Direct',
    country: 'FR',
    flag: '🇫🇷',
    logo: '/assets/brokers/bourse-direct.png',
    status: 'soon',
    description: 'Broker spécialisé bourse FR · PEA PME · Pas d\'API publique',
    authFields: [],
    docsUrl: null,
  },
  {
    id: 'fortuneo',
    name: 'Fortuneo',
    country: 'FR',
    flag: '🇫🇷',
    logo: '/assets/brokers/fortuneo.png',
    status: 'soon',
    description: 'Banque en ligne · Bourse · Pas d\'API publique',
    authFields: [],
    docsUrl: null,
  },
  {
    id: 'csv',
    name: 'Import CSV manuel',
    country: '—',
    flag: '📂',
    logo: null,
    status: 'live',                           // mode fallback universel déjà en place
    description: 'Fallback universel · Tous brokers supportés (IG, TR, Degiro, Boursorama, eToro, IBKR, Revolut, XTB…)',
    authFields: [],
    docsUrl: null,
  },
];

// ============================================================
// CRYPTO : chiffrement AES-GCM des credentials broker
// ============================================================
// Clé dérivée de env.PORTFOLIO_ENCRYPTION_KEY + uid via HKDF (PBKDF2 fallback).
// Les creds sont stockées sous forme { iv: base64, ct: base64 } en KV.

async function deriveKey(env, uid) {
  if (!env.PORTFOLIO_ENCRYPTION_KEY) {
    throw new Error('PORTFOLIO_ENCRYPTION_KEY not configured');
  }
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(env.PORTFOLIO_ENCRYPTION_KEY),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: enc.encode(`kairos-portfolio:${uid}`),
      iterations: 100000,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function toBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function fromBase64(str) {
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

async function encryptCreds(env, uid, plainObj) {
  const key = await deriveKey(env, uid);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(JSON.stringify(plainObj))
  );
  return { iv: toBase64(iv), ct: toBase64(ct) };
}

async function decryptCreds(env, uid, encObj) {
  const key = await deriveKey(env, uid);
  const iv = fromBase64(encObj.iv);
  const ct = fromBase64(encObj.ct);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ct
  );
  const dec = new TextDecoder();
  return JSON.parse(dec.decode(plain));
}

// ============================================================
// BROKER ADAPTERS (Phase 1 : IG uniquement, skeletons pour les autres)
// ============================================================
// Interface commune : async fetchPositions(creds, env) => {
//   positions: [{ ticker, isin, quantity, avg_cost, current_price, value_eur, pnl, pnl_pct }],
//   totalValue, currency, accountId
// }

// Helper logout IG (libère un slot dans le quota 30 logins/h)
async function igLogout(baseUrl, apiKey, cst, xst) {
  try {
    await fetch(`${baseUrl}/session`, {
      method: 'DELETE',
      headers: {
        'X-IG-API-KEY': apiKey,
        'CST': cst,
        'X-SECURITY-TOKEN': xst,
        'Version': '1',
      },
    });
  } catch (e) {
    // Best-effort, on ignore les erreurs de cleanup
  }
}

// Bases URL IG (live vs demo)
const IG_API_BASES = {
  demo: 'https://demo-api.ig.com/gateway/deal',
  live: 'https://api.ig.com/gateway/deal',
};

// Taux de change figés (MVP) — à remplacer par un fetch API forex en Phase 3
// Justifié par : moins de 5% d'erreur sur les majeures sur 1 mois, suffisant
// pour afficher une valeur indicative en EUR.
const FX_TO_EUR_FIXED = {
  EUR: 1.0,
  USD: 0.92,
  GBP: 1.17,
  CHF: 1.05,
  JPY: 0.0061,
  CAD: 0.68,
  AUD: 0.62,
};

function convertToEur(amount, currency) {
  if (amount == null || isNaN(amount)) return null;
  const rate = FX_TO_EUR_FIXED[currency] ?? 1.0;
  return amount * rate;
}

// Extrait le ticker "lisible" depuis l'EPIC IG.
// IG instrumentType possibles :
//   SHARES, OPT_SHARES                 → action (mappable Kairos)
//   INDICES, BUNGEE_INDICES, OPT_INDICES → indice (non mappable, mais position gardée)
//   COMMODITIES, OPT_COMMODITIES, BUNGEE_COMMODITIES → matière première
//   CURRENCIES, OPT_CURRENCIES, BUNGEE_CURRENCIES → forex
//   RATES, OPT_RATES, SECTORS, BINARY, etc.
// Patterns EPIC courants :
//   UA.D.AAPL.CASH.IP        → AAPL (action US cash CFD)
//   UA.D.AAPL.DAILY.IP       → AAPL (action DFB CFD)
//   UC.D.NVDA.CASH.IP        → NVDA
//   IX.D.SPTRD.IFD.IP        → SPTRD (indice — ticker_kairos=null)
//   CC.D.GBPUSD.TODAY.IP     → GBPUSD (forex — ticker_kairos=null)
//
// On retourne le ticker_kairos UNIQUEMENT pour les actions (SHARES/OPT_SHARES),
// car notre base de données Kairos Score ne contient que des actions cotées.
// Pour les autres instruments, ticker_kairos = null mais la position EST conservée.
function extractTickerFromEpic(epic, instrumentType) {
  if (!epic || typeof epic !== 'string') return null;
  // Mappable seulement pour les types ACTION
  const isActionLike = instrumentType === 'SHARES' || instrumentType === 'OPT_SHARES';
  if (!isActionLike) return null;
  const parts = epic.split('.');
  if (parts.length < 3) return null;
  const candidate = parts[2];
  // Le ticker doit être 1-6 chars alphanumériques majuscules
  if (!/^[A-Z0-9]{1,6}$/.test(candidate)) return null;
  return candidate;
}

// Détermine la "catégorie" de la position pour l'affichage (utile dans l'UI
// pour grouper par type ou afficher un badge "Action / CFD / Indice / Forex").
function classifyInstrument(instrumentType) {
  if (!instrumentType) return 'autre';
  if (instrumentType === 'SHARES' || instrumentType === 'OPT_SHARES') return 'action';
  if (instrumentType.includes('INDICES')) return 'indice';
  if (instrumentType.includes('COMMODITIES')) return 'commodity';
  if (instrumentType.includes('CURRENCIES') || instrumentType === 'RATES') return 'forex';
  if (instrumentType === 'SECTORS') return 'secteur';
  if (instrumentType === 'BINARY') return 'binaire';
  return 'autre';
}

const BROKER_ADAPTERS = {
  ig: {
    /**
     * IG Markets REST API
     * Doc : https://labs.ig.com/rest-trading-api-reference
     *
     * Flow :
     *   1) POST /session (Version:2) avec { identifier, password } + X-IG-API-KEY
     *      → headers response contiennent CST + X-SECURITY-TOKEN
     *   2) GET /positions (Version:2) avec X-IG-API-KEY + CST + X-SECURITY-TOKEN
     *   3) DELETE /session (cleanup, free up daily login quota)
     *
     * Rate limits IG (par compte) :
     *   - 30 logins / heure
     *   - 60 trading requests / minute
     *   - 10 non-trading requests / minute (positions, accounts...)
     *
     * On utilise environment 'live' OU 'demo' (URLs différentes).
     */
    async validateCreds(creds) {
      const required = ['username', 'password', 'apiKey'];
      for (const f of required) {
        if (!creds[f] || typeof creds[f] !== 'string') {
          return { ok: false, error: `Champ manquant : ${f}` };
        }
        // Trim côté serveur : élimine les espaces invisibles copiés-collés
        // (ex: copier la clé depuis IG colle parfois un \r ou un espace en fin)
        creds[f] = creds[f].trim();
        if (creds[f].length < 3) {
          return { ok: false, error: `Champ trop court : ${f}` };
        }
      }
      const env = (creds.environment || 'live').toLowerCase();
      if (!['live', 'demo'].includes(env)) {
        return { ok: false, error: 'Environnement doit être "live" ou "demo"' };
      }
      creds.environment = env;
      return { ok: true };
    },

    async fetchPositions(creds, env) {
      const igEnv = (creds.environment || 'live').toLowerCase();
      const baseUrl = IG_API_BASES[igEnv] || IG_API_BASES.live;

      // ===== ETAPE 1 : Authentification =====
      let sessionResp;
      try {
        sessionResp = await fetch(`${baseUrl}/session`, {
          method: 'POST',
          headers: {
            'X-IG-API-KEY': creds.apiKey,
            'Version': '2',
            'Content-Type': 'application/json',
            'Accept': 'application/json; charset=UTF-8',
          },
          body: JSON.stringify({
            identifier: creds.username,
            password: creds.password,
          }),
        });
      } catch (e) {
        return { error: `IG : impossible de joindre l'API (${e.message || e})`, positions: [], totalValue: 0 };
      }

      if (!sessionResp.ok) {
        let errBody = '';
        try { errBody = await sessionResp.text(); } catch {}
        const errCode = sessionResp.status;

        // Tente d'extraire l'errorCode exact d'IG (au format JSON)
        let igErrorCode = '';
        try {
          const parsed = JSON.parse(errBody);
          if (parsed && parsed.errorCode) igErrorCode = parsed.errorCode;
        } catch {}

        // Mapping errorCode IG → message FR clair (issu de la doc IG)
        const igErrorMap = {
          'error.security.api-key-invalid': 'Clé API invalide. Vérifie qu\'elle correspond bien à l\'environnement (live OU demo) — elles sont distinctes.',
          'error.security.api-key-disabled': 'Cette clé API est désactivée. Active-la dans My IG > Settings > API Keys.',
          'error.security.api-key-revoked': 'Clé API révoquée. Génères-en une nouvelle.',
          'error.security.api-key-restricted': 'Cette clé API est restreinte (IP whitelist activée chez IG ?). Vérifie My IG > Settings > API Keys.',
          'error.security.invalid-details': 'Identifiants invalides : nom d\'utilisateur ou mot de passe incorrect.',
          'error.security.account-suspended': 'Compte IG suspendu. Contacte le support IG.',
          'error.security.client-token-invalid': 'Token client invalide. Patiente quelques minutes et réessaie.',
          'error.security.account-temporarily-locked': 'Compte temporairement bloqué (trop de tentatives). Patiente 1h.',
          'error.public-api.exceeded-account-allowance': 'Trop de tentatives de login (max 30/h). Patiente 1h.',
          'error.security.account-permission-required': 'Permissions insuffisantes sur ce compte. Active l\'accès API dans My IG.',
          'error.security.encrypted-password-required': 'Compte exigeant un mot de passe chiffré (V3 API). Non supporté actuellement.',
        };

        let userMsg = igErrorMap[igErrorCode];
        if (!userMsg) {
          if (errCode === 401 || errCode === 403) {
            userMsg = `IG : authentification refusée (${igErrorCode || 'HTTP ' + errCode}). Vérifie : (1) clé API correspondant à l'environnement choisi, (2) nom d'utilisateur ET mot de passe, (3) que la clé API est activée dans My IG.`;
          } else if (errCode === 404) {
            userMsg = 'IG : compte inexistant. Vérifie l\'environnement (live ou demo).';
          } else {
            userMsg = `IG : erreur HTTP ${errCode}${igErrorCode ? ' (' + igErrorCode + ')' : ''}`;
          }
        }
        return { error: userMsg, positions: [], totalValue: 0, igErrorCode, raw: errBody.slice(0, 300) };
      }

      const cst = sessionResp.headers.get('CST');
      const xst = sessionResp.headers.get('X-SECURITY-TOKEN');
      if (!cst || !xst) {
        return { error: 'IG : tokens de session manquants (CST/X-SECURITY-TOKEN)', positions: [], totalValue: 0 };
      }

      let sessionData = {};
      try { sessionData = await sessionResp.json(); } catch {}
      const accountId = sessionData.currentAccountId || sessionData.accountId || 'default';
      const userCurrency = sessionData.currencyIsoCode || 'EUR';

      // ===== ETAPE 2 : Récupération des positions =====
      let posResp;
      try {
        posResp = await fetch(`${baseUrl}/positions`, {
          method: 'GET',
          headers: {
            'X-IG-API-KEY': creds.apiKey,
            'CST': cst,
            'X-SECURITY-TOKEN': xst,
            'Version': '2',
            'Accept': 'application/json; charset=UTF-8',
          },
        });
      } catch (e) {
        // cleanup avant de retourner
        await igLogout(baseUrl, creds.apiKey, cst, xst);
        return { error: `IG : impossible de récupérer les positions (${e.message || e})`, positions: [], totalValue: 0 };
      }

      if (!posResp.ok) {
        await igLogout(baseUrl, creds.apiKey, cst, xst);
        return { error: `IG : positions failed (HTTP ${posResp.status})`, positions: [], totalValue: 0 };
      }

      let posData = { positions: [] };
      try { posData = await posResp.json(); } catch {}
      const rawPositions = Array.isArray(posData.positions) ? posData.positions : [];

      // ===== ETAPE 3 : Parsing + mapping ticker_kairos =====
      const positions = rawPositions.map(p => {
        const pos = p.position || {};
        const mkt = p.market || {};

        const epic = mkt.epic || '';
        const instrumentName = mkt.instrumentName || '';
        const instrumentType = mkt.instrumentType || '';
        const tickerKairos = extractTickerFromEpic(epic, instrumentType);

        const direction = (pos.direction || 'BUY').toUpperCase();
        const size = Number(pos.size) || 0;
        const entryLevel = Number(pos.level) || 0;
        // Mid price : moyenne bid/offer pour valoriser la position
        const bid = Number(mkt.bid) || 0;
        const offer = Number(mkt.offer) || 0;
        const currentPrice = (bid && offer) ? (bid + offer) / 2 : (bid || offer || entryLevel);

        // P&L : sur SELL, plus le prix baisse plus on gagne
        const rawPnl = direction === 'SELL'
          ? (entryLevel - currentPrice) * size
          : (currentPrice - entryLevel) * size;
        const pnlPct = entryLevel > 0 ? (rawPnl / (entryLevel * Math.abs(size))) * 100 : 0;

        // Devise de la position : prio sur pos.currency (déclaré), sinon défaut user currency
        const currency = (pos.currency || userCurrency || 'EUR').toUpperCase();

        // Valeur courante en EUR (conversion taux fixe MVP)
        const currentValueNative = currentPrice * Math.abs(size);
        const currentValueEur = convertToEur(currentValueNative, currency);

        return {
          ticker: epic,                                 // EPIC raw IG (clé unique broker-side)
          ticker_kairos: tickerKairos,                  // ticker simplifié pour join Kairos Score (null si non-action)
          isin: null,                                   // IG ne renvoie pas l'ISIN dans /positions (Phase 3)
          quantity: direction === 'SELL' ? -Math.abs(size) : Math.abs(size),
          avg_cost_price: entryLevel,
          current_price: currentPrice,
          current_value_eur: currentValueEur,
          currency,
          unrealized_pnl: rawPnl,
          unrealized_pnl_pct: pnlPct,
          // Meta retourné dans la response API (frontend l'affichera)
          instrument_name: instrumentName,              // ex: "Apple Inc.", "EUR/USD", "France 40 (CAC 40)"
          instrument_class: classifyInstrument(instrumentType), // 'action' | 'indice' | 'forex' | 'commodity' | etc.
          direction,                                    // 'BUY' | 'SELL' (utile pour afficher long/short)
        };
      });

      // ===== ETAPE 4 : Logout (libère le quota daily login) =====
      await igLogout(baseUrl, creds.apiKey, cst, xst);

      const totalValueEur = positions.reduce((s, p) => s + (p.current_value_eur || 0), 0);

      return {
        positions,
        totalValue: totalValueEur,
        currency: 'EUR',
        accountId,
        broker: 'ig',
        environment: igEnv,
      };
    },
  },

  // Stubs pour les autres brokers
  ibkr: { validateCreds: async () => ({ ok: false, error: 'IBKR: pas encore supporté' }), fetchPositions: async () => ({ error: 'not implemented' }) },
  saxo: { validateCreds: async () => ({ ok: false, error: 'Saxo: pas encore supporté' }), fetchPositions: async () => ({ error: 'not implemented' }) },
  'trade-republic': { validateCreds: async () => ({ ok: false, error: 'Trade Republic: pas encore supporté' }), fetchPositions: async () => ({ error: 'not implemented' }) },
  degiro: { validateCreds: async () => ({ ok: false, error: 'Degiro: pas encore supporté' }), fetchPositions: async () => ({ error: 'not implemented' }) },
  boursorama: { validateCreds: async () => ({ ok: false, error: 'Boursorama: pas encore supporté' }), fetchPositions: async () => ({ error: 'not implemented' }) },
  etoro: { validateCreds: async () => ({ ok: false, error: 'eToro: pas encore supporté' }), fetchPositions: async () => ({ error: 'not implemented' }) },
  'bourse-direct': { validateCreds: async () => ({ ok: false, error: 'Bourse Direct: pas encore supporté' }), fetchPositions: async () => ({ error: 'not implemented' }) },
  fortuneo: { validateCreds: async () => ({ ok: false, error: 'Fortuneo: pas encore supporté' }), fetchPositions: async () => ({ error: 'not implemented' }) },
};

// ============================================================
// HANDLERS HTTP
// ============================================================

// GET /api/portfolio/brokers : catalogue des brokers (public info seulement, pas d'auth)
export function handlePortfolioBrokers(env, origin) {
  // On expose seulement les infos publiques (pas les adapters, pas le code interne)
  const publicBrokers = SUPPORTED_BROKERS.map(b => ({
    id: b.id,
    name: b.name,
    country: b.country,
    flag: b.flag,
    logo: b.logo,
    status: b.status,
    description: b.description,
    authFields: b.authFields,
    docsUrl: b.docsUrl,
    helpHtml: b.helpHtml || null,            // checklist d'aide affichée dans le form
  }));
  return { brokers: publicBrokers };
}

// GET /api/portfolio/connections : liste les connexions actives d'un user
export async function handlePortfolioConnections(uid, env) {
  if (!env.HISTORY) return { error: 'D1 not configured', connections: [] };
  try {
    const rows = (await env.HISTORY.prepare(
      `SELECT uid, broker, account_id, status, last_sync_at, last_error,
              positions_count, total_value_eur, created_at, updated_at
       FROM portfolio_connections
       WHERE uid = ?
       ORDER BY created_at DESC`
    ).bind(uid).all()).results || [];
    return { connections: rows };
  } catch (e) {
    return { error: String(e && e.message || e), connections: [] };
  }
}

// POST /api/portfolio/connect : crée une connexion (stocke creds chiffrées en KV)
// Body : { broker: 'ig', creds: { username, password, apiKey, environment } }
export async function handlePortfolioConnect(request, uid, env) {
  try {
    const body = await request.json();
    const broker = String(body.broker || '').toLowerCase();
    const creds = body.creds || {};

    // Validation broker
    const brokerInfo = SUPPORTED_BROKERS.find(b => b.id === broker);
    if (!brokerInfo) {
      return { error: `Broker inconnu : ${broker}`, code: 'UNKNOWN_BROKER' };
    }
    if (brokerInfo.status === 'soon') {
      return { error: `Le broker ${brokerInfo.name} n'est pas encore supporté`, code: 'BROKER_NOT_READY' };
    }
    if (brokerInfo.status === 'csv') {
      return { error: 'Utilisez l\'import CSV directement', code: 'USE_CSV' };
    }

    const adapter = BROKER_ADAPTERS[broker];
    if (!adapter) {
      return { error: 'Adapter manquant', code: 'NO_ADAPTER' };
    }

    // Validation des creds
    const valid = await adapter.validateCreds(creds);
    if (!valid.ok) {
      return { error: valid.error, code: 'INVALID_CREDS' };
    }

    // Chiffrement + stockage KV
    if (!env.CACHE) return { error: 'KV not configured' };
    const encrypted = await encryptCreds(env, uid, creds);
    const kvKey = `portfolio-creds:${uid}:${broker}:${Date.now().toString(36)}`;
    await env.CACHE.put(kvKey, JSON.stringify(encrypted), {
      expirationTtl: 365 * 24 * 3600,  // 1 an, refresh à chaque sync
    });

    // Insert/update en D1
    if (!env.HISTORY) return { error: 'D1 not configured' };
    const accountId = creds.accountId || 'default';
    await env.HISTORY.prepare(
      `INSERT INTO portfolio_connections (uid, broker, account_id, credentials_kv_key, status, last_sync_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', NULL, CURRENT_TIMESTAMP)
       ON CONFLICT(uid, broker, account_id) DO UPDATE SET
         credentials_kv_key = excluded.credentials_kv_key,
         status = 'active',
         last_error = NULL,
         updated_at = CURRENT_TIMESTAMP`
    ).bind(uid, broker, accountId, kvKey).run();

    return {
      ok: true,
      broker: brokerInfo.name,
      status: 'active',
      message: 'Connexion créée. Utilisez "Synchroniser" pour charger vos positions.',
    };
  } catch (e) {
    return { error: String(e && e.message || e), code: 'CONNECT_FAILED' };
  }
}

// POST /api/portfolio/disconnect : révoque une connexion
// Body : { broker: 'ig', accountId?: 'default' }
export async function handlePortfolioDisconnect(request, uid, env) {
  try {
    const body = await request.json();
    const broker = String(body.broker || '').toLowerCase();
    const accountId = body.accountId || 'default';
    if (!broker) return { error: 'Broker manquant', code: 'MISSING_BROKER' };

    if (!env.HISTORY) return { error: 'D1 not configured' };

    // Récupère la clé KV à supprimer
    const row = await env.HISTORY.prepare(
      `SELECT credentials_kv_key FROM portfolio_connections WHERE uid = ? AND broker = ? AND account_id = ?`
    ).bind(uid, broker, accountId).first();

    if (row && row.credentials_kv_key && env.CACHE) {
      try { await env.CACHE.delete(row.credentials_kv_key); } catch {}
    }

    // Supprime la connexion + positions associées
    await env.HISTORY.batch([
      env.HISTORY.prepare(`DELETE FROM portfolio_positions WHERE uid = ? AND broker = ? AND account_id = ?`).bind(uid, broker, accountId),
      env.HISTORY.prepare(`DELETE FROM portfolio_connections WHERE uid = ? AND broker = ? AND account_id = ?`).bind(uid, broker, accountId),
    ]);

    return { ok: true, message: 'Connexion révoquée et positions effacées.' };
  } catch (e) {
    return { error: String(e && e.message || e), code: 'DISCONNECT_FAILED' };
  }
}

// POST /api/portfolio/sync : déclenche un sync manuel pour toutes les connexions du user
export async function handlePortfolioSync(uid, env) {
  if (!env.HISTORY) return { error: 'D1 not configured' };
  if (!env.CACHE) return { error: 'KV not configured' };

  // Rate limit : max 1 sync par 60 sec par user (évite spam API broker)
  const rlKey = `portfolio-sync-rl:${uid}`;
  try {
    const last = await env.CACHE.get(rlKey);
    if (last) {
      return { error: 'Trop rapide. Patientez 60s entre 2 syncs.', code: 'RATE_LIMITED', retryAfter: 60 };
    }
    await env.CACHE.put(rlKey, '1', { expirationTtl: 60 });
  } catch {}

  // Charge toutes les connexions actives du user
  const conns = (await env.HISTORY.prepare(
    `SELECT uid, broker, account_id, credentials_kv_key FROM portfolio_connections WHERE uid = ? AND status = 'active'`
  ).bind(uid).all()).results || [];

  if (!conns.length) {
    return { error: 'Aucune connexion active. Connectez un broker d\'abord.', code: 'NO_CONNECTIONS' };
  }

  const results = [];
  for (const conn of conns) {
    try {
      // Charge + déchiffre les creds
      const rawCreds = await env.CACHE.get(conn.credentials_kv_key, 'json');
      if (!rawCreds) {
        results.push({ broker: conn.broker, error: 'Credentials expirées, reconnectez-vous' });
        continue;
      }
      const creds = await decryptCreds(env, uid, rawCreds);

      // Fetch positions via adapter
      const adapter = BROKER_ADAPTERS[conn.broker];
      if (!adapter) {
        results.push({ broker: conn.broker, error: 'Adapter introuvable' });
        continue;
      }
      const fetchResult = await adapter.fetchPositions(creds, env);

      if (fetchResult.error) {
        await env.HISTORY.prepare(
          `UPDATE portfolio_connections SET last_sync_at = CURRENT_TIMESTAMP, last_error = ?, status = 'error'
           WHERE uid = ? AND broker = ? AND account_id = ?`
        ).bind(fetchResult.error.slice(0, 300), uid, conn.broker, conn.account_id).run();
        results.push({ broker: conn.broker, error: fetchResult.error });
        continue;
      }

      // Upsert positions en D1 (réécrit à chaque sync : le dernier état gagne)
      const positions = fetchResult.positions || [];
      const targetAccount = fetchResult.accountId || conn.account_id;

      // Stratégie : DELETE puis INSERT batch (plus simple qu'un MERGE en SQLite,
      // et le volume reste petit — typiquement <50 positions par user).
      const stmts = [
        env.HISTORY.prepare(
          `DELETE FROM portfolio_positions WHERE uid = ? AND broker = ? AND account_id = ?`
        ).bind(uid, conn.broker, targetAccount),
      ];

      // Pré-fetch des Kairos Scores pour les tickers détenus (1 query, plus efficace)
      const tickersKairos = positions.map(p => p.ticker_kairos).filter(Boolean);
      const scoreMap = {};
      if (tickersKairos.length) {
        try {
          const placeholders = tickersKairos.map(() => '?').join(',');
          const rows = (await env.HISTORY.prepare(
            `SELECT ticker, total
             FROM score_history
             WHERE ticker IN (${placeholders})
             AND date = (SELECT MAX(date) FROM score_history WHERE ticker = score_history.ticker)`
          ).bind(...tickersKairos).all()).results || [];
          for (const r of rows) scoreMap[r.ticker] = r.total;
        } catch (e) {
          // Best-effort : si le join échoue, on continue sans score
        }
      }

      // Batch INSERT des positions
      for (const p of positions) {
        stmts.push(env.HISTORY.prepare(
          `INSERT INTO portfolio_positions
            (uid, broker, account_id, ticker, isin, ticker_kairos, quantity,
             avg_cost_price, current_price, current_value_eur, currency,
             unrealized_pnl, unrealized_pnl_pct, kairos_score, has_alerts,
             instrument_name, instrument_class, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
        ).bind(
          uid,
          conn.broker,
          targetAccount,
          String(p.ticker || '').slice(0, 60),       // EPIC peut être long (ex: UA.D.AAPL.CASH.IP)
          p.isin || null,
          p.ticker_kairos || null,
          p.quantity || 0,
          p.avg_cost_price || null,
          p.current_price || null,
          p.current_value_eur || null,
          (p.currency || 'EUR').slice(0, 3),
          p.unrealized_pnl || null,
          p.unrealized_pnl_pct || null,
          p.ticker_kairos ? (scoreMap[p.ticker_kairos] ?? null) : null,
          0,  // has_alerts : sera calculé en Phase 3 par un cron
          p.instrument_name ? String(p.instrument_name).slice(0, 200) : null,
          p.instrument_class || null,
        ));
      }

      // Snapshot quotidien (pour le chart équité)
      const today = new Date().toISOString().slice(0, 10);
      stmts.push(env.HISTORY.prepare(
        `INSERT INTO portfolio_snapshots
          (uid, broker, snapshot_date, total_value_eur, positions_count)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(uid, broker, snapshot_date) DO UPDATE SET
           total_value_eur = excluded.total_value_eur,
           positions_count = excluded.positions_count`
      ).bind(uid, conn.broker, today, fetchResult.totalValue || 0, positions.length));

      // Update connection status
      stmts.push(env.HISTORY.prepare(
        `UPDATE portfolio_connections
         SET last_sync_at = CURRENT_TIMESTAMP,
             last_error = NULL,
             status = 'active',
             positions_count = ?,
             total_value_eur = ?,
             account_id = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE uid = ? AND broker = ? AND account_id = ?`
      ).bind(positions.length, fetchResult.totalValue || 0, targetAccount, uid, conn.broker, conn.account_id));

      // Exécution batch (transaction atomique en D1)
      await env.HISTORY.batch(stmts);

      results.push({
        broker: conn.broker,
        ok: true,
        positionsCount: positions.length,
        totalValue: fetchResult.totalValue,
      });
    } catch (e) {
      results.push({ broker: conn.broker, error: String(e && e.message || e) });
    }
  }

  return { ok: true, results, syncedAt: new Date().toISOString() };
}

// GET /api/portfolio/positions : positions live (enrichies Kairos Score + alertes)
export async function handlePortfolioPositions(uid, env) {
  if (!env.HISTORY) return { error: 'D1 not configured', positions: [] };
  try {
    // Join portfolio_positions + score_history (dernier score connu par ticker_kairos)
    const rows = (await env.HISTORY.prepare(
      `SELECT p.broker, p.ticker, p.isin, p.ticker_kairos, p.quantity,
              p.avg_cost_price, p.current_price, p.current_value_eur, p.currency,
              p.unrealized_pnl, p.unrealized_pnl_pct,
              p.instrument_name, p.instrument_class,
              COALESCE(
                (SELECT s.total FROM score_history s
                 WHERE s.ticker = p.ticker_kairos
                 ORDER BY s.date DESC LIMIT 1),
                p.kairos_score
              ) AS kairos_score,
              p.has_alerts, p.updated_at
       FROM portfolio_positions p
       WHERE p.uid = ?
       ORDER BY p.current_value_eur DESC NULLS LAST, p.ticker ASC`
    ).bind(uid).all()).results || [];
    return { positions: rows, count: rows.length };
  } catch (e) {
    return { error: String(e && e.message || e), positions: [] };
  }
}

// GET /api/portfolio/snapshots?days=90 : historique valeur portefeuille pour chart équité
export async function handlePortfolioSnapshots(url, uid, env) {
  if (!env.HISTORY) return { error: 'D1 not configured', snapshots: [] };
  const days = Math.max(7, Math.min(365, parseInt(url.searchParams.get('days') || '90', 10)));
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);
  try {
    const rows = (await env.HISTORY.prepare(
      `SELECT snapshot_date, SUM(total_value_eur) AS total_value_eur,
              SUM(positions_count) AS positions_count,
              SUM(day_pnl_eur) AS day_pnl_eur
       FROM portfolio_snapshots
       WHERE uid = ? AND snapshot_date >= ?
       GROUP BY snapshot_date
       ORDER BY snapshot_date ASC`
    ).bind(uid, sinceStr).all()).results || [];
    return { snapshots: rows, days, since: sinceStr };
  } catch (e) {
    return { error: String(e && e.message || e), snapshots: [] };
  }
}

// GET /api/portfolio/alerts : alertes smart money sur les positions détenues (30 derniers jours)
// Pour chaque ticker détenu, on cherche : insider transactions récentes, 13D filings,
// score movers significatifs, rotations ETF.
export async function handlePortfolioAlerts(uid, env) {
  if (!env.HISTORY) return { error: 'D1 not configured', alerts: [] };
  try {
    // Récupère les tickers détenus
    const tickers = (await env.HISTORY.prepare(
      `SELECT DISTINCT ticker_kairos FROM portfolio_positions WHERE uid = ? AND ticker_kairos IS NOT NULL`
    ).bind(uid).all()).results || [];

    if (!tickers.length) return { alerts: [], count: 0, tickers: [] };

    const tickersList = tickers.map(r => r.ticker_kairos).filter(Boolean);
    const placeholders = tickersList.map(() => '?').join(',');

    // Insider transactions récentes (14j)
    const insiderAlerts = (await env.HISTORY.prepare(
      `SELECT ticker, insider, title, trans_type, value, trans_date,
              'insider' AS alert_type
       FROM insider_transactions_history
       WHERE ticker IN (${placeholders})
         AND trans_date >= date('now', '-14 days')
         AND ABS(COALESCE(value, 0)) >= 100000
       ORDER BY trans_date DESC
       LIMIT 50`
    ).bind(...tickersList).all()).results || [];

    // Score movers significatifs (delta ≥ 10 pts sur 7j)
    const scoreAlerts = (await env.HISTORY.prepare(
      `WITH score_delta AS (
         SELECT ticker,
                FIRST_VALUE(total) OVER (PARTITION BY ticker ORDER BY date DESC) AS score_now,
                FIRST_VALUE(total) OVER (PARTITION BY ticker ORDER BY date ASC) AS score_then,
                MAX(date) OVER (PARTITION BY ticker) AS last_date
         FROM score_history
         WHERE ticker IN (${placeholders})
           AND date >= date('now', '-7 days')
       )
       SELECT DISTINCT ticker, score_now, score_then, (score_now - score_then) AS delta, last_date,
              'score_mover' AS alert_type
       FROM score_delta
       WHERE ABS(score_now - score_then) >= 10`
    ).bind(...tickersList).all()).results || [];

    // Merge + trie par date
    const alerts = [
      ...insiderAlerts.map(a => ({
        type: 'insider',
        ticker: a.ticker,
        title: `${a.trans_type === 'buy' ? '🟢' : '🔴'} ${a.insider} (${a.title || 'insider'}) · ${a.trans_type === 'buy' ? 'achat' : 'vente'} ${a.value ? Math.round(a.value).toLocaleString('fr-FR') + ' $' : ''}`,
        date: a.trans_date,
      })),
      ...scoreAlerts.map(a => ({
        type: 'score_mover',
        ticker: a.ticker,
        title: `${a.delta > 0 ? '▲' : '▼'} Kairos Score ${a.score_then} → ${a.score_now} (${a.delta > 0 ? '+' : ''}${a.delta} pts)`,
        date: a.last_date,
      })),
    ].sort((x, y) => (y.date || '').localeCompare(x.date || ''));

    return {
      alerts: alerts.slice(0, 50),
      count: alerts.length,
      tickers: tickersList,
    };
  } catch (e) {
    return { error: String(e && e.message || e), alerts: [] };
  }
}
