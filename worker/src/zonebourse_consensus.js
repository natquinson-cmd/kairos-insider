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
  'THALES': 'THALES-4709',
  'AIR FRANCE-KLM': 'AIR-FRANCE-KLM-4634',
  'AIR FRANCE': 'AIR-FRANCE-KLM-4634',
  'BNPP': 'BNP-PARIBAS-4644',
  'CREDIT AGRICOLE': 'CREDIT-AGRICOLE-S-A-4639',
  'SOCIETE GENERALE': 'SOCIETE-GENERALE-4690',
  'SOGEN': 'SOCIETE-GENERALE-4690',
  'EUROAPI': 'EUROAPI-117432569',
  'GETLINK': 'GETLINK-SE-4661',
  'EUROTUNNEL': 'GETLINK-SE-4661',
  'CREDIT MUTUEL': 'CREDIT-MUTUEL-ARKEA-4640',
  'PUBLICIS GROUPE': 'PUBLICIS-GROUPE-SA-4682',
  'BIC': 'SOCIETE-BIC-4687',
  'ALSTOM': 'ALSTOM-4638',
  'ARKEMA': 'ARKEMA-4639',
  'CARMILA': 'CARMILA-22538103',
  'CASINO': 'CASINO-GUICHARD-PERRACHON-4651',
  'GROUPE LDLC': 'GROUPE-LDLC-65888',
  'IMERYS': 'IMERYS-4664',
  'IPSOS': 'IPSOS-4647',
  'JCDECAUX': 'JCDECAUX-S-A-4665',
  'KORIAN': 'KORIAN-31754',
  'LAGARDERE': 'LAGARDERE-S-A-4661',
  'NEOEN': 'NEOEN-71033927',
  'NEXANS': 'NEXANS-4671',
  'NEXITY': 'NEXITY-22538100',
  'PEUGEOT INVEST': 'PEUGEOT-INVEST-22557547',
  'RUBIS': 'RUBIS-4683',
  'SCOR': 'SCOR-SE-4685',
  'SOPRA': 'SOPRA-STERIA-GROUP-23117',
  'SPIE': 'SPIE-23093110',
  'SUEZ': 'SUEZ-4707',
  'TF1': 'TF1-4717',
  'UNIBAIL': 'UNIBAIL-RODAMCO-WESTFIELD-SE-110049311',
  'URW': 'UNIBAIL-RODAMCO-WESTFIELD-SE-110049311',
  'VALEO': 'VALEO-4717',
  'VALLOUREC': 'VALLOUREC-4716',
  'VEOLIA ENVIRONNEMENT': 'VEOLIA-ENVIRONNEMENT-4719',
  'WENDEL': 'WENDEL-4720',
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


// Normalise les accents : 'Nestlé S.A.' -> 'NESTLE S.A.'
function stripAccents(s) {
  if (!s) return '';
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function lookupSlugLocal(companyName) {
  if (!companyName) return null;
  const upperRaw = String(companyName).toUpperCase().trim();
  const upper = stripAccents(upperRaw);
  if (KNOWN_SLUGS[upperRaw]) return KNOWN_SLUGS[upperRaw];
  if (KNOWN_SLUGS[upper]) return KNOWN_SLUGS[upper];
  for (const [key, slug] of Object.entries(KNOWN_SLUGS)) {
    if (upper.includes(stripAccents(key))) return slug;
  }
  return null;
}


/**
 * Recherche dynamique du slug Zonebourse via leur moteur de recherche.
 * Cache 7 jours dans KV (le slug ne change pas souvent).
 * Plus fiable que le mapping statique qui devient obsolete avec les IDs Zonebourse.
 */
async function searchZonebourseSlug(companyName, env) {
  if (!companyName) return null;
  const cacheKey = `zb-slug:v1:${stripAccents(companyName.toUpperCase()).trim()}`;

  // Cache 7 jours
  if (env && env.CACHE) {
    try {
      const cached = await env.CACHE.get(cacheKey, 'json');
      if (cached && cached.slug) return cached.slug;
      if (cached && cached.notFound) return null;  // memorise les misses
    } catch {}
  }

  try {
    // Cleanup company name : enlever 'S.A.', 'PLC', 'AG', etc. pour mieux searcher
    const cleanQuery = String(companyName)
      .replace(/[,.]?\s*(S\.?A\.?|S\.?A\.?S\.?|PLC|N\.?V\.?|AG|SE|SPA|S\.?p\.?A\.?|LTD|GROUP|GROUPE|HOLDING|HOLDINGS).*$/i, '')
      .trim()
      .slice(0, 60);
    if (!cleanQuery) return null;

    const url = `${ZB_BASE}/recherche/?q=${encodeURIComponent(cleanQuery)}&type=cours`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': ZB_UA, 'Accept': 'text/html', 'Accept-Language': 'fr-FR,fr;q=0.9' },
    });
    if (!resp.ok) return null;
    const html = await resp.text();

    // Extraire les premiers liens /cours/action/SLUG/
    const links = Array.from(html.matchAll(/href="(\/cours\/action\/([A-Z0-9-]+))\/?"/gi))
      .map(m => ({ path: m[1], slug: m[2] }));
    const unique = Array.from(new Set(links.map(l => l.slug)));

    if (unique.length === 0) {
      if (env && env.CACHE) {
        try {
          await env.CACHE.put(cacheKey, JSON.stringify({ notFound: true, fetchedAt: new Date().toISOString() }),
            { expirationTtl: 86400 });  // misses cachees 1j seulement
        } catch {}
      }
      return null;
    }

    // Heuristique : preferer le slug qui matche le mieux le nom recherche
    // (premier resultat = plus pertinent selon Zonebourse)
    const best = unique[0];
    if (env && env.CACHE) {
      try {
        await env.CACHE.put(cacheKey, JSON.stringify({ slug: best, fetchedAt: new Date().toISOString() }),
          { expirationTtl: 7 * 86400 });
      } catch {}
    }
    return best;
  } catch {
    return null;
  }
}


// Lookup hybride : local mapping (instant) puis search dynamique (1 hit)
async function lookupSlug(companyName, env) {
  // 1. Mapping local
  const local = lookupSlugLocal(companyName);
  if (local) return local;
  // 2. Search dynamique
  return await searchZonebourseSlug(companyName, env);
}


/**
 * Parse les donnees consensus depuis le HTML Zonebourse /consensus/
 * Retourne null si pas trouve.
 *
 * Structure HTML observee :
 *   alt="Consensus"></div>Achat</div>
 *   <div>Recommandation moyenne</div><div ...>ACCUMULER</div>
 *   <div>Nombre d&#039;Analystes</div><div ...>27</div>
 *   Dernier Cours de Cloture</div><div ...>467,45</div><div>EUR</div>
 *   Objectif de cours Moyen</div><div ...>595,17</div><div>EUR</div>
 *   Ecart / Objectif Moyen</div><div ...>+27,32 %</div>
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

  // 1. Consensus principal : 'alt="Consensus"></div>Achat</div>' ou similar
  // Pattern : apres alt="Consensus" et fermeture div, le mot principal
  let m = html.match(/alt="Consensus"[^>]*>\s*<\/div>\s*([A-Za-zéèêàâç\-]+)/i);
  if (!m) m = html.match(/alt="Consensus"[^>]*>([A-Za-zéèêàâç\-]{4,20})/i);
  if (m) result.consensus = m[1].trim();

  // 2. Recommandation moyenne : 'Recommandation moyenne</div><div ...>ACCUMULER</div>'
  m = html.match(/Recommandation\s+moyenne\s*<\/div>\s*<div[^>]*>\s*([A-ZÀ-Ý][A-ZÀ-Ý\s]{2,25}?)\s*<\/div>/i);
  if (m) result.recommendationMean = m[1].trim().replace(/\s+/g, ' ');

  // 3. Nombre d'Analystes : 'Nombre d&#039;Analystes</div><div ...>27</div>'
  m = html.match(/Nombre\s+d[&#0-9]*;?\s*Analystes\s*<\/div>\s*<div[^>]*>\s*([0-9]+)\s*<\/div>/i);
  if (m) result.analystCount = parseInt(m[1], 10);

  // 4. Dernier Cours de Cloture - pattern SPECIFIQUE
  m = html.match(/Dernier\s+Cours\s+de\s+Cloture\s*<\/div>\s*<div[^>]{0,150}>\s*<span[^>]*class="last[^"]*"[^>]*>\s*([0-9\s]+(?:[,.][0-9]+)?)\s*<\/span>\s*([A-Z]{3})/i);
  if (m) {
    result.lastClose = parseFloat(m[1].replace(/\s/g, '').replace(',', '.'));
    result.lastCloseCurrency = m[2];
  }

  // 5. Objectif de cours Moyen - pattern reel SPECIFIQUE
  // Le HTML a 'Objectif de cours Moyen' suivi DIRECTEMENT par la valeur dans
  // un span class="last". On limite la distance pour eviter de matcher autre chose.
  m = html.match(/Objectif\s+de\s+cours\s+Moyen\s*<\/div>\s*<div[^>]{0,150}>\s*<span[^>]*class="last[^"]*"[^>]*>\s*([0-9\s]+(?:[,.][0-9]+)?)\s*<\/span>\s*([A-Z]{3})/i);
  if (m) {
    result.targetMean = parseFloat(m[1].replace(/\s/g, '').replace(',', '.'));
    result.targetCurrency = m[2];
  }

  // 6. Ecart vs Objectif - pattern :
  // 'Ecart / Objectif Moyen</div><div ...><span class="variation..."><span class="c-block...">+27,32 %</span></span>'
  // OU directement : '+27,32 %' dans un span
  m = html.match(/Ecart\s*\/\s*Objectif\s+Moyen[\s\S]{0,500}?>\s*([+\-]?[0-9\s]+(?:[,.][0-9]+)?)\s*(?:%|&nbsp;%)/i);
  if (m) result.ecartTargetPct = parseFloat(m[1].replace(/\s/g, '').replace(' ', '').replace(',', '.'));

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
 * Parse les fondamentaux + agenda depuis la page principale Zonebourse.
 * Retourne {fundamentals, nextEarningsDate, upcomingEvents}.
 */
function parseFundamentalsAndAgenda(html) {
  const result = {
    marketCap: null, marketCapCurrency: null,
    peRatio: null, eps: null, dividendYield: null,
    high52w: null, low52w: null, volume: null,
    dayHigh: null, dayLow: null,
    nextEarningsDate: null,
    upcomingEvents: [],
  };
  if (!html || html.length < 2000) return result;

  // Mcap : '<span ...>233,90 Md €</span>' OU 'Capi (M EUR) | 233 234'
  let m = html.match(/(?:Capitalisation|Capi[^a-z])[\s\S]{0,200}?>\s*([0-9\s]+(?:[,.][0-9]+)?)\s*(?:M|Md|Mio|Mds)\s*€/i);
  if (m) {
    let val = parseFloat(m[1].replace(/\s/g, '').replace(',', '.'));
    if (m[0].toLowerCase().includes('md')) val *= 1000;  // milliards -> millions
    result.marketCap = Math.round(val);
    result.marketCapCurrency = 'EUR';
  }

  // PER 2025/2026 : 'PER 2025</div><div ...>22,5</div>'
  m = html.match(/PER\s*20\d{2}[\s\S]{0,150}?>\s*([0-9]+(?:[,.][0-9]+)?)\s*</i);
  if (m) result.peRatio = parseFloat(m[1].replace(',', '.'));

  // BPA : 'BPA 2025'
  m = html.match(/BPA\s*20\d{2}[\s\S]{0,150}?>\s*([0-9]+(?:[,.][0-9]+)?)\s*</i);
  if (m) result.eps = parseFloat(m[1].replace(',', '.'));

  // Rendement %
  m = html.match(/Rendement[\s\S]{0,150}?>\s*([0-9]+(?:[,.][0-9]+)?)\s*%/i);
  if (m) result.dividendYield = parseFloat(m[1].replace(',', '.'));

  // High/Low 52w : '+ haut 52 sem.</...><...>500</...>'
  m = html.match(/\+?\s*haut\s+annuel[\s\S]{0,150}?>\s*([0-9\s]+(?:[,.][0-9]+)?)\s*</i);
  if (m) result.high52w = parseFloat(m[1].replace(/\s/g, '').replace(',', '.'));
  m = html.match(/\+?\s*bas\s+annuel[\s\S]{0,150}?>\s*([0-9\s]+(?:[,.][0-9]+)?)\s*</i);
  if (m) result.low52w = parseFloat(m[1].replace(/\s/g, '').replace(',', '.'));

  // Volume du jour
  m = html.match(/Volume[\s\S]{0,150}?>\s*([0-9\s]+(?:[,.][0-9]+)?)\s*<(?!\/td)/i);
  if (m) result.volume = parseFloat(m[1].replace(/\s/g, '').replace(',', '.'));

  // Prochaine publication earnings : 'Prochain rendez-vous</...>06/05/2026'
  m = html.match(/(?:Prochain\s+rendez|Prochaine\s+publication|Resultats)[\s\S]{0,300}?(\d{2}[\/-]\d{2}[\/-]\d{4})/i);
  if (m) result.nextEarningsDate = m[1];

  return result;
}


async function fetchZonebourseFundamentals(slug, env) {
  if (!slug) return null;
  const cacheKey = `zb-fund:v2:${slug}`;
  try {
    const cached = await env.CACHE.get(cacheKey, 'json');
    if (cached && cached.fetchedAt) {
      const age = (Date.now() - new Date(cached.fetchedAt).getTime()) / 1000;
      if (age < 86400) return cached;
    }
  } catch {}

  const url = `${ZB_BASE}/cours/action/${slug}/`;
  let html = '';
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': ZB_UA, 'Accept': 'text/html', 'Accept-Language': 'fr-FR,fr;q=0.9' },
    });
    if (!resp.ok) return null;
    html = await resp.text();
  } catch {
    return null;
  }
  const parsed = parseFundamentalsAndAgenda(html);
  const result = {
    ...parsed,
    source: 'zonebourse',
    sourceUrl: url,
    fetchedAt: new Date().toISOString(),
  };
  try {
    await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 86400 + 3600 });
  } catch {}
  return result;
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

  // v4 : bump apres ajout dynamic slug search via Zonebourse search engine
  const cacheKey = `zb-consensus:v4:${String(companyName).toUpperCase().trim()}`;

  // Check cache 24h
  try {
    const cached = await env.CACHE.get(cacheKey, 'json');
    if (cached && cached.fetchedAt) {
      const age = (Date.now() - new Date(cached.fetchedAt).getTime()) / 1000;
      if (age < 86400) return cached;
    }
  } catch {}

  // Lookup slug : local mapping puis search dynamique
  const slug = await lookupSlug(companyName, env);
  if (!slug) {
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

  // Egalement fetcher fundamentals depuis la page principale (en parallele)
  const fundamentals = await fetchZonebourseFundamentals(slug, env);

  const result = {
    ...parsed,
    source: 'zonebourse',
    sourceUrl: consensusUrl,
    company: companyName,
    slug,
    fundamentals: fundamentals || null,
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
