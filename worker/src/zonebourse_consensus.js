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
  'LVMH': 'LVMH-4669',  // Zonebourse a raccourci slugs en 2026, redirige depuis ancien
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


// Helpers cache (notFound vs slug found)
async function _cacheSlugMiss(env, cacheKey) {
  if (env && env.CACHE) {
    try {
      await env.CACHE.put(cacheKey, JSON.stringify({ notFound: true, fetchedAt: new Date().toISOString() }),
        { expirationTtl: 86400 });
    } catch {}
  }
  return null;
}
async function _cacheSlugHit(env, cacheKey, slug) {
  if (env && env.CACHE) {
    try {
      await env.CACHE.put(cacheKey, JSON.stringify({ slug, fetchedAt: new Date().toISOString() }),
        { expirationTtl: 7 * 86400 });
    } catch {}
  }
  return slug;
}


/**
 * Recherche dynamique du slug Zonebourse + VALIDATION par fetch de la page.
 *
 * STRATEGIE v3 (apres bug LVMH du 30 avril 2026) :
 *  1. Search Zonebourse par nom -> liste de slugs candidats
 *  2. Pre-filtre : query stripped doit etre dans slug stripped (3-6 chars)
 *  3. **VALIDATION FORTE** : pour chaque candidat (max 5), fetch /consensus/
 *     et verifier que le <title> contient `| TICKERSHORT |` (ex: `| MC |`).
 *     Le ticker court est unique par cotation Zonebourse, donc c'est
 *     l'identifiant le plus fiable.
 *  4. Fallback heuristique : si pas de ticker fourni, prendre le slug
 *     avec le plus PETIT ID numerique (= cotation principale historique
 *     vs pages news avec IDs > 10M).
 *
 * Pourquoi c'est necessaire :
 *  - Zonebourse a plusieurs cotations par titre (Paris MC, Moscow MOH, etc.)
 *  - Les IDs sont reattribues sans avertir (SANOFI-4684 devient HAULOTTE)
 *  - La search retourne des results 'trending' par defaut (BNP-PARIBAS-4618)
 *    meme pour des queries non liees -> validation par titre INDISPENSABLE
 *
 * @param {string} companyName - Nom de la societe (Yahoo longName ou shortName)
 * @param {string|null} yahooSymbol - Symbole Yahoo complet (MC.PA, BARC.L) pour
 *                                    extraire le ticker court qui sert de validation
 * @param {object} env - env Cloudflare Worker (pour cache KV)
 * @returns {Promise<string|null>} - Slug Zonebourse valide ou null
 */
async function searchZonebourseSlug(companyName, yahooSymbol, env) {
  if (!companyName) return null;

  // Ticker court = ce qui apparait avant le suffixe Yahoo (MC.PA -> MC).
  // Sera utilise pour valider les candidats : Zonebourse encode ce ticker
  // dans le <title> de chaque page entre pipes (`| MC |`).
  const tickerShort = yahooSymbol
    ? String(yahooSymbol).split('.')[0].toUpperCase()
    : null;

  // v3 : bump apres validation par fetch de title (vs v2 qui acceptait n'importe
  // quel slug match-prefixe). Format clef : zb-slug:v3:NOM|TICKER pour cache
  // separe par ticker (LVMH MC.PA != LVMH XYZ.MOH).
  const cacheKey = `zb-slug:v3:${stripAccents(companyName.toUpperCase()).trim()}|${tickerShort || ''}`;

  if (env && env.CACHE) {
    try {
      const cached = await env.CACHE.get(cacheKey, 'json');
      if (cached && cached.slug) return cached.slug;
      if (cached && cached.notFound) return null;
    } catch {}
  }

  try {
    // Cleanup : enlever S.A., PLC, AG, etc. pour mieux searcher
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

    const links = Array.from(html.matchAll(/href="\/cours\/action\/([A-Z0-9-]+)\/?"/gi))
      .map(m => m[1]);
    const unique = Array.from(new Set(links));

    if (unique.length === 0) return _cacheSlugMiss(env, cacheKey);

    // PRE-FILTRE : slug stripped doit contenir les 3-6 premiers chars de la query
    // (evite les results trending qui n'ont rien a voir : ALPHABET, MICROSOFT, etc.)
    const queryStripped = stripAccents(cleanQuery.toUpperCase()).replace(/[^A-Z0-9]/g, '');
    let candidates = unique;
    if (queryStripped.length >= 3) {
      const prefix = queryStripped.slice(0, Math.min(6, queryStripped.length));
      candidates = unique.filter(slug => {
        const slugStripped = slug.toUpperCase().replace(/[^A-Z0-9]/g, '');
        return slugStripped.includes(prefix);
      });
      if (candidates.length === 0) candidates = unique;  // relâche si trop strict
    }

    // VALIDATION FORTE : fetcher chaque candidat (max 5) et verifier que le
    // <title> contient `| TICKERSHORT |`. Cela elimine :
    //  - Les pages news/transcripts (IDs longs sans consensus, title sans ticker)
    //  - Les autres cotations du meme titre (Moscow, NY, etc. - mauvais ticker)
    //  - Les slugs reattribues a un autre titre
    if (tickerShort && tickerShort.length >= 1 && tickerShort.length <= 8) {
      const tickerRegex = new RegExp(`\\|\\s*${tickerShort.replace(/[^A-Z0-9]/gi, '')}\\s*\\|`, 'i');
      // Limit a 5 fetches pour rester sous le quota subrequests Cloudflare (50/req)
      for (const slug of candidates.slice(0, 5)) {
        try {
          const consensusUrl = `${ZB_BASE}/cours/action/${slug}/consensus/`;
          const r = await fetch(consensusUrl, {
            headers: { 'User-Agent': ZB_UA, 'Accept': 'text/html' },
          });
          if (!r.ok) continue;
          const h = await r.text();
          const titleMatch = h.match(/<title>([^<]{1,200})<\/title>/i);
          if (!titleMatch) continue;
          const title = titleMatch[1];
          // Title attendu format : "COMPANY: ... | TICKERSHORT | ISIN | Zonebourse"
          if (tickerRegex.test(title) &&
              (h.includes('consensus-gauge') || h.includes('Recommandation moyenne'))) {
            return _cacheSlugHit(env, cacheKey, slug);
          }
        } catch {}
      }
    }

    // FALLBACK : pas de ticker fourni, ou aucun candidat n'a passe la validation.
    // Heuristique : prendre le slug avec le plus PETIT ID numerique a la fin.
    // Les cotations principales historiques ont des IDs 4XXX (ex: LVMH-4669),
    // les pages news/secondaires ont des IDs > 10M (LVMH-111960885).
    const fallback = candidates.sort((a, b) => {
      const aId = parseInt((a.match(/-(\d+)$/) || [])[1] || '0', 10);
      const bId = parseInt((b.match(/-(\d+)$/) || [])[1] || '0', 10);
      return aId - bId;
    })[0];

    if (fallback) return _cacheSlugHit(env, cacheKey, fallback);
    return _cacheSlugMiss(env, cacheKey);
  } catch {
    return null;
  }
}


// Lookup : UNIQUEMENT via search dynamique avec validation par fetch de title.
// KNOWN_SLUGS reste utilise comme priorite 1 pour les top stocks connus
// (mais Zonebourse reattribue les IDs sans avertir, donc validation runtime).
async function lookupSlug(companyName, yahooSymbol, env) {
  // Priorite 1 : KNOWN_SLUGS pour cas connus (test rapide, evite le fetch search)
  const known = lookupSlugLocal(companyName);
  if (known) {
    // Valide le slug connu en fetchant sa page (attrape les IDs reattribues)
    if (yahooSymbol) {
      const tickerShort = String(yahooSymbol).split('.')[0].toUpperCase();
      try {
        const r = await fetch(`${ZB_BASE}/cours/action/${known}/consensus/`, {
          headers: { 'User-Agent': ZB_UA, 'Accept': 'text/html' },
        });
        if (r.ok) {
          const h = await r.text();
          const titleMatch = h.match(/<title>([^<]{1,200})<\/title>/i);
          if (titleMatch) {
            const tickerRegex = new RegExp(`\\|\\s*${tickerShort.replace(/[^A-Z0-9]/gi, '')}\\s*\\|`, 'i');
            if (tickerRegex.test(titleMatch[1]) &&
                (h.includes('consensus-gauge') || h.includes('Recommandation moyenne'))) {
              return known;  // KNOWN_SLUGS confirme valide
            }
          }
        }
      } catch {}
      // Si la validation KNOWN_SLUGS echoue -> tomber dans search dynamique
    } else {
      return known;  // pas de ticker pour valider, on fait confiance au mapping
    }
  }
  // Priorite 2 : search dynamique avec validation
  return await searchZonebourseSlug(companyName, yahooSymbol, env);
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
    gaugeNote: null,  // Note 0-10 (ex: 7.8) extraite de la jauge Zonebourse
  };

  // 0. Note de la jauge consensus (ex: 'class="consensus-gauge" title="Note: 7.8 / 10"')
  // Permet de synthetiser un breakdown buy/hold/sell plausible quand seul la
  // recommandation moyenne est dispo (Zonebourse ne fournit pas le detail des votes).
  let m = html.match(/consensus-gauge[^"]*"\s*title="Note\s*:?\s*([0-9]+(?:[,.][0-9]+)?)\s*\/\s*10"/i);
  if (!m) m = html.match(/Note\s*:?\s*([0-9]+(?:[,.][0-9]+)?)\s*\/\s*10/i);
  if (m) result.gaugeNote = parseFloat(m[1].replace(',', '.'));

  // 1. Consensus principal : 'alt="Consensus"></div>Achat</div>' ou similar
  // Pattern : apres alt="Consensus" et fermeture div, le mot principal
  m = html.match(/alt="Consensus"[^>]*>\s*<\/div>\s*([A-Za-zéèêàâç\-]+)/i);
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
  // IMPORTANT : on stocke en FRACTION (0.025 pour 2.5%) pour matcher le format
  // stockanalysis.com - le frontend multiplie par 100 pour afficher.
  // Sans cette division, LVMH 2.88% s'affichait comme 288% (bug rapporte).
  m = stripped.match(/(?:Rendement|Dividend\s*yield)\s*\|\s*([0-9 ]+(?:[,.][0-9]+)?)\s*%/i);
  if (m) {
    const pct = parseFr(m[1]);
    if (pct != null) result.dividendYield = pct / 100;  // % -> fraction
  }

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

  // Rendement % - stocke en FRACTION pour matcher stockanalysis.com format
  // (le frontend fait dividendYield * 100 pour afficher).
  m = html.match(/Rendement[\s\S]{0,150}?>\s*([0-9]+(?:[,.][0-9]+)?)\s*%/i);
  if (m) {
    const pct = parseFloat(m[1].replace(',', '.'));
    if (!isNaN(pct)) result.dividendYield = pct / 100;  // % -> fraction
  }

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
 * @param {object} [opts] - Options additionnelles
 * @param {string} [opts.yahooSymbol] - Symbole Yahoo (MC.PA, BARC.L) pour validation
 *                                       par ticker court (ex: MC pour MC.PA)
 * @returns {Promise<object|null>}
 */
export async function fetchZonebourseConsensus(companyName, env, opts = {}) {
  if (!companyName) return null;

  const yahooSymbol = opts.yahooSymbol || null;

  // v9 : bump apres fix dividendYield (% -> fraction) + ajout gaugeNote (synthese
  // breakdown buy/hold/sell). v8 contenait LVMH dividendYield = 2.88 (en %, faux).
  const cacheKey = `zb-consensus:v9:${String(companyName).toUpperCase().trim()}|${yahooSymbol || ''}`;

  // Check cache 24h
  try {
    const cached = await env.CACHE.get(cacheKey, 'json');
    if (cached && cached.fetchedAt) {
      const age = (Date.now() - new Date(cached.fetchedAt).getTime()) / 1000;
      if (age < 86400) return cached;
    }
  } catch {}

  // Lookup slug : KNOWN_SLUGS valide puis search dynamique avec validation
  const slug = await lookupSlug(companyName, yahooSymbol, env);
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
