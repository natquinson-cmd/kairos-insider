/**
 * Zonebourse consensus scraper - recommandations analystes EU.
 *
 * Source : https://www.zonebourse.com/cours/action/{NOM-ID}/consensus/
 * Donnees extraites :
 *   - Consensus (Achat / Conserver / Vendre / Surperformer / Sous-performer)
 *   - Recommandation moyenne (ACCUMULER / ACHETER / etc.)
 *   - Nombre d'analystes
 *   - Cours actuel (cross-check Yahoo)
 *   - Objectif de cours moyen
 *   - Ecart vs objectif (%)
 *
 * Workflow : recherche Zonebourse par nom -> URL -> scrape /consensus/
 * Cache 24h dans KV (zb-consensus:NOM_UPPERCASE).
 */

const ZB_BASE = 'https://www.zonebourse.com';
const ZB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36';

// Mapping direct nom -> URL slug pour les top EU (eviter une requete search)
// Format : { match (regex i): slug Zonebourse }
const KNOWN_SLUGS = {
  // CAC 40 / SBF 120 (FR)
  'LVMH': 'LVMH-MOET-HENNESSY-VUITTON-4669',
  'TOTALENERGIES': 'TOTALENERGIES-SE-4717',
  'TOTAL': 'TOTALENERGIES-SE-4717',
  'AIRBUS': 'AIRBUS-4637',
  'SANOFI': 'SANOFI-4684',
  'L\'OREAL': 'L-OREAL-4666',
  'LOREAL': 'L-OREAL-4666',
  'KERING': 'KERING-4660',
  'BNP PARIBAS': 'BNP-PARIBAS-4644',
  'BNP': 'BNP-PARIBAS-4644',
  'AIR LIQUIDE': 'AIR-LIQUIDE-4636',
  'SCHNEIDER': 'SCHNEIDER-ELECTRIC-4685',
  'SAINT-GOBAIN': 'COMPAGNIE-DE-SAINT-GOBAIN-4654',
  'AXA': 'AXA-4641',
  'VINCI': 'VINCI-4720',
  'STELLANTIS': 'STELLANTIS-N-V-103119113',
  'PERNOD RICARD': 'PERNOD-RICARD-4677',
  'CARREFOUR': 'CARREFOUR-4651',
  'DANONE': 'DANONE-4657',
  'CAPGEMINI': 'CAPGEMINI-4650',
  'ESSILORLUXOTTICA': 'ESSILORLUXOTTICA-32522',
  'HERMES': 'HERMES-INTERNATIONAL-4665',
  'SAFRAN': 'SAFRAN-4683',
  'LEGRAND': 'LEGRAND-31754',
  'PUBLICIS': 'PUBLICIS-GROUPE-SA-4682',
  'ENGIE': 'ENGIE-4659',
  'EDF': 'EDF-4658',
  'ORANGE': 'ORANGE-4673',
  'VEOLIA': 'VEOLIA-ENVIRONNEMENT-4719',
  'BOUYGUES': 'BOUYGUES-4646',
  'MICHELIN': 'COMPAGNIE-GENERALE-DES-ETABLI-4655',
  'RENAULT': 'RENAULT-4691',
  'STMICROELECTRONICS': 'STMICROELECTRONICS-N-V-9335',
  'DASSAULT SYSTEMES': 'DASSAULT-SYSTEMES-SE-4656',
  'DASSAULT AVIATION': 'DASSAULT-AVIATION-39600',
  'TELEPERFORMANCE': 'TELEPERFORMANCE-4707',
  'WORLDLINE': 'WORLDLINE-29404400',
  'SOITEC': 'SOITEC-4690',
  'SOPRA STERIA': 'SOPRA-STERIA-GROUP-23117',
  'ATOS': 'ATOS-4640',
  'BUREAU VERITAS': 'BUREAU-VERITAS-SA-32561',
  'EUROFINS': 'EUROFINS-SCIENTIFIC-43411',
  'REMY COINTREAU': 'REMY-COINTREAU-4694',
  'VIVENDI': 'VIVENDI-SE-4724',
  'BIC': 'SOCIETE-BIC-4687',
  'ACCOR': 'ACCOR-4632',
  'EDENRED': 'EDENRED-4731',
  'AMUNDI': 'AMUNDI-39395',
  'ICADE': 'ICADE-4664',
  'UBISOFT': 'UBISOFT-ENTERTAINMENT-4717280',
  'IPSEN': 'IPSEN-4647',
  // FTSE 100 / FTSE 250 (UK)
  'BARCLAYS': 'BARCLAYS-9583',
  'BP': 'BP-PLC-9590',
  'SHELL': 'SHELL-PLC-2070',
  'ASTRAZENECA': 'ASTRAZENECA-9583',
  'GLAXOSMITHKLINE': 'GSK-3994854',
  'GSK': 'GSK-3994854',
  'HSBC': 'HSBC-HOLDINGS-PLC-9636',
  'ROLLS-ROYCE': 'ROLLS-ROYCE-HOLDINGS-PLC-1413178',
  'BAE SYSTEMS': 'BAE-SYSTEMS-PLC-9582',
  'NATIONAL GRID': 'NATIONAL-GRID-9694',
  'LLOYDS': 'LLOYDS-BANKING-GROUP-PLC-9659',
  'UNILEVER': 'UNILEVER-PLC-9778',
  'DIAGEO': 'DIAGEO-PLC-9610',
  'BURBERRY': 'BURBERRY-GROUP-PLC-9595',
  // DAX (DE)
  'SAP': 'SAP-SE-435845',
  'SIEMENS': 'SIEMENS-AG-436232',
  'BMW': 'BAYERISCHE-MOTOREN-WERKE-436017',
  'MERCEDES': 'MERCEDES-BENZ-GROUP-AG-9039',
  'VOLKSWAGEN': 'VOLKSWAGEN-AG-436737',
  'BAYER': 'BAYER-AKTIENGESELLSCHAFT-436019',
  'ALLIANZ': 'ALLIANZ-SE-436053',
  'ADIDAS': 'ADIDAS-AG-436037',
  'DEUTSCHE BANK': 'DEUTSCHE-BANK-AG-436157',
  'DEUTSCHE TELEKOM': 'DEUTSCHE-TELEKOM-AG-436161',
  // AEX (NL)
  'ASML': 'ASML-HOLDING-N-V-447228',
  'PROSUS': 'PROSUS-N-V-100036775',
  'AHOLD': 'KONINKLIJKE-AHOLD-DELHAIZE-N-V-1413212',
  'HEINEKEN': 'HEINEKEN-N-V-447337',
  'ING': 'ING-GROEP-N-V-447331',
  'PHILIPS': 'KONINKLIJKE-PHILIPS-N-V-447339',
  // SMI (CH)
  'NESTLE': 'NESTLE-S-A-119639',
  'ROCHE': 'ROCHE-HOLDING-AG-119685',
  'NOVARTIS': 'NOVARTIS-AG-119642',
  'UBS': 'UBS-GROUP-AG-29953336',
  'ZURICH INSURANCE': 'ZURICH-INSURANCE-GROUP-AG-119729',
  'ABB': 'ABB-LTD-12107',
  'GLENCORE': 'GLENCORE-PLC-13624551',
  'RICHEMONT': 'COMPAGNIE-FINANCIERE-RICHEMON-119569',
  'SWISS RE': 'SWISS-RE-LTD-1413220',
  // FTSE MIB (IT)
  'ENI': 'ENI-S-P-A-50480',
  'ENEL': 'ENEL-S-P-A-50479',
  'INTESA SANPAOLO': 'INTESA-SANPAOLO-S-P-A-50466',
  'UNICREDIT': 'UNICREDIT-S-P-A-50483',
  'GENERALI': 'ASSICURAZIONI-GENERALI-S-P-A-50416',
  'FERRARI': 'FERRARI-N-V-65862218',
  'STMICRO': 'STMICROELECTRONICS-N-V-9335',
  // IBEX 35 (ES)
  'IBERDROLA': 'IBERDROLA-S-A-1413220',
  'BANCO SANTANDER': 'BANCO-SANTANDER-S-A-9580',
  'SANTANDER': 'BANCO-SANTANDER-S-A-9580',
  'BBVA': 'BANCO-BILBAO-VIZCAYA-ARGENTAR-9579',
  'TELEFONICA': 'TELEFONICA-S-A-9742',
  'INDITEX': 'INDUSTRIA-DE-DISENO-TEXTIL-S-A-1413222',
  'REPSOL': 'REPSOL-S-A-9698',
  'AENA': 'AENA-S-M-E-S-A-21459851',
};


function lookupSlug(companyName, ticker) {
  if (!companyName) return null;
  const upper = String(companyName).toUpperCase().trim();
  // Direct match
  if (KNOWN_SLUGS[upper]) return KNOWN_SLUGS[upper];
  // Partial match : si le nom contient un de nos keys
  for (const [key, slug] of Object.entries(KNOWN_SLUGS)) {
    if (upper.includes(key)) return slug;
  }
  return null;
}


/**
 * Parse les donnees consensus depuis le HTML Zonebourse /consensus/
 * Retourne null si pas trouve.
 */
function parseConsensusHtml(html) {
  if (!html || html.length < 1000) return null;

  const result = {
    consensus: null,
    recommendationMean: null,
    analystCount: null,
    targetMean: null,
    targetCurrency: null,
    lastClose: null,
    lastCloseCurrency: null,
    ecartTargetPct: null,
  };

  const stripped = html.replace(/<[^>]+>/g, ' | ').replace(/\s+/g, ' ');

  // Consensus + recommandation : pattern observed
  // 'alt="Consensus"   | Achat    | Recommandation moyenne | ACCUMULER | Nombre d Analystes | 27'
  // 'Dernier Cours de Cloture | 467,45 | EUR | Objectif de cours Moyen | 595,17 | EUR'
  // 'Ecart / Objectif Moyen | +27,32 %'

  // 1. Consensus
  let m = stripped.match(/alt="Consensus"\s*\|\s*([A-Za-zéèêàâ\-]+)\s*\|/i);
  if (!m) m = stripped.match(/Consensus\s*\|\s*([A-Z][A-Za-zéèêàâ]{2,15})\s*\|/);
  if (m) result.consensus = m[1].trim();

  // 2. Recommandation moyenne (toutes majuscules)
  m = stripped.match(/Recommandation\s*moyenne\s*\|\s*([A-Z][A-ZÉÈÀ\s]{2,25}?)\s*\|/);
  if (m) result.recommendationMean = m[1].trim();

  // 3. Nombre d'Analystes (apostrophe peut etre HTML entity &#039;)
  m = stripped.match(/Nombre\s*d['&#0-9]*;?\s*Analystes\s*\|\s*([0-9]+)/);
  if (m) result.analystCount = parseInt(m[1], 10);

  // 4. Dernier cours de Cloture
  m = stripped.match(/Dernier\s*Cours\s*de\s*Cloture\s*\|\s*([0-9 ]+(?:[,.][0-9]+)?)\s*\|\s*([A-Z]{3})/);
  if (m) {
    result.lastClose = parseFloat(m[1].replace(/\s/g, '').replace(',', '.'));
    result.lastCloseCurrency = m[2];
  }

  // 5. Objectif de cours Moyen
  m = stripped.match(/Objectif\s*de\s*cours\s*Moyen\s*\|\s*([0-9 ]+(?:[,.][0-9]+)?)\s*\|\s*([A-Z]{3})/);
  if (m) {
    result.targetMean = parseFloat(m[1].replace(/\s/g, '').replace(',', '.'));
    result.targetCurrency = m[2];
  }

  // 6. Ecart vs Objectif (%)
  m = stripped.match(/Ecart\s*\/\s*Objectif\s*Moyen\s*\|\s*([+-]?[0-9 ]+(?:[,.][0-9]+)?)\s*%/);
  if (m) result.ecartTargetPct = parseFloat(m[1].replace(/\s/g, '').replace(',', '.'));

  if (result.consensus || result.recommendationMean || result.targetMean) {
    return result;
  }
  return null;
}


/**
 * Parse les fondamentaux depuis la page principale Zonebourse :
 * /cours/action/SLUG/
 *
 * Retourne :
 *   { marketCap, peRatio, eps, dividendYield, high52w, low52w,
 *     dayHigh, dayLow, volume }
 */
function parseFundamentalsHtml(html) {
  if (!html || html.length < 1000) return null;
  const result = {
    marketCap: null,        // en M EUR
    marketCapCurrency: null,
    peRatio: null,
    forwardPE: null,
    eps: null,
    dividendYield: null,    // en %
    high52w: null,
    low52w: null,
    dayHigh: null,
    dayLow: null,
    volume: null,
    psRatio: null,
    pbRatio: null,
  };

  const stripped = html.replace(/<[^>]+>/g, ' | ').replace(/\s+/g, ' ');

  // Helper pour parser un nombre fr (espace pour milliers, virgule pour decimales)
  const parseFr = (s) => {
    if (!s) return null;
    const cleaned = String(s).replace(/\s/g, '').replace(/&nbsp;/g, '').replace(',', '.');
    const n = parseFloat(cleaned);
    return isNaN(n) ? null : n;
  };

  // Capitalisation : 'Capi (M EUR) | 233 234' ou 'Capitalisation | 233 234 M EUR'
  let m = stripped.match(/Capi(?:talisation)?\s*[\(\|]?\s*M?\s*EUR?\s*\)?\s*\|\s*([0-9 ]+(?:[,.][0-9]+)?)/i);
  if (m) {
    result.marketCap = parseFr(m[1]);
    result.marketCapCurrency = 'EUR';
  }

  // PER : 'PER 2025 | 22,5' ou 'P/E ratio | 22.5'
  m = stripped.match(/PER\s*(?:20\d{2})?\s*\|\s*([0-9 ]+(?:[,.][0-9]+)?)/i);
  if (m) result.peRatio = parseFr(m[1]);

  // BPA : 'BPA 2025 | 24,55'
  m = stripped.match(/BPA\s*(?:20\d{2})?\s*\|\s*([0-9 ]+(?:[,.][0-9]+)?)/i);
  if (m) result.eps = parseFr(m[1]);

  // Rendement / dividende : 'Rendement | 2,5%' ou 'Dividende | 2,5%'
  m = stripped.match(/(?:Rendement|Dividend\s*yield)\s*\|\s*([0-9 ]+(?:[,.][0-9]+)?)\s*%/i);
  if (m) result.dividendYield = parseFr(m[1]);

  // P/S ratio
  m = stripped.match(/P\s*\/\s*Ventes\s*\|\s*([0-9 ]+(?:[,.][0-9]+)?)/i);
  if (m) result.psRatio = parseFr(m[1]);

  // 52w high/low (parfois '+ haut 52 sem.' / '+ bas 52 sem.')
  m = stripped.match(/\+\s*haut\s*(?:52\s*sem\.|annuel)\s*\|\s*([0-9 ]+(?:[,.][0-9]+)?)/i);
  if (m) result.high52w = parseFr(m[1]);
  m = stripped.match(/\+\s*bas\s*(?:52\s*sem\.|annuel)\s*\|\s*([0-9 ]+(?:[,.][0-9]+)?)/i);
  if (m) result.low52w = parseFr(m[1]);

  // Has at least 1 fundamental ?
  const hasAny = Object.values(result).some(v => v !== null && v !== undefined);
  return hasAny ? result : null;
}


/**
 * Récupère le consensus Zonebourse pour une société.
 *
 * @param {string} companyName - "LVMH", "Nestle", "ASML"...
 * @param {object} env - Cloudflare worker env (avec env.CACHE)
 * @returns {Promise<object|null>}
 */
export async function fetchZonebourseConsensus(companyName, env) {
  if (!companyName) return null;

  const cacheKey = `zb-consensus:${String(companyName).toUpperCase().trim()}`;

  // Check cache 24h
  try {
    const cached = await env.CACHE.get(cacheKey, 'json');
    if (cached && cached.fetchedAt) {
      const age = (Date.now() - new Date(cached.fetchedAt).getTime()) / 1000;
      if (age < 86400) return cached;
    }
  } catch {}

  // Lookup slug
  const slug = lookupSlug(companyName);
  if (!slug) {
    // No slug found - return null (could implement search fallback later)
    return null;
  }

  const consensusUrl = `${ZB_BASE}/cours/action/${slug}/consensus/`;
  let html = '';
  try {
    const resp = await fetch(consensusUrl, {
      headers: {
        'User-Agent': ZB_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
        'Accept-Language': 'fr-FR,fr;q=0.9',
      },
    });
    if (!resp.ok) return null;
    html = await resp.text();
  } catch (e) {
    return null;
  }

  const parsed = parseConsensusHtml(html);
  if (!parsed) return null;

  const result = {
    ...parsed,
    source: 'zonebourse',
    sourceUrl: consensusUrl,
    company: companyName,
    fetchedAt: new Date().toISOString(),
  };

  // Cache 24h
  try {
    await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 86400 + 3600 });
  } catch {}

  return result;
}


/**
 * Wrapper : prend un ticker Yahoo (MC.PA, NESN.SW, BARC.L) ou un nom et
 * tente d'inférer la société pour chercher le consensus.
 *
 * Strategie :
 *   1. Si on a un company name (ex: depuis quote.company.name) -> direct
 *   2. Si on a un ticker EU avec mapping inversé connu -> nom
 *   3. Sinon null
 */
export async function lookupConsensusFromTicker(ticker, companyName, env) {
  // Priorité au companyName si fourni
  if (companyName) {
    const result = await fetchZonebourseConsensus(companyName, env);
    if (result) return result;
  }

  // Fallback : ticker -> nom via mapping inverse
  if (ticker) {
    try {
      const { lookupCompanyFromYahooSymbol } = await import('./eu_yahoo_symbols.js');
      const inferred = lookupCompanyFromYahooSymbol ? lookupCompanyFromYahooSymbol(ticker) : null;
      if (inferred) return fetchZonebourseConsensus(inferred, env);
    } catch {}

    // Try ticker direct (parfois match : LVMH match key "LVMH")
    return fetchZonebourseConsensus(ticker, env);
  }

  return null;
}
