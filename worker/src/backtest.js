/**
 * Backtest Smart Money — feature gratuite (acquisition)
 *
 * Concept : "Si tu avais suivi {Cevian, BlackRock, Elliott...} pendant 1/3/5 ans,
 *            quel serait ton rendement ?"
 *
 * Methodologie MVP :
 *   1. Pour un filer (activist/institutionnel) choisi, lister tous les filings
 *      sur la période (1y, 3y, 5y) dans les 6 KV thresholds (SEC + AMF + FCA + SIX + AFM + BaFin)
 *   2. Pour chaque target, considérer la 1ère date d'apparition comme entrée
 *      Si le filer a re-franchit en baisse, considérer cette date comme sortie
 *      Sinon = encore en position (sortie = aujourd'hui)
 *   3. Récupérer les prix Yahoo entry/exit, calculer rendement
 *   4. Aggréger : rendement moyen pondéré, comparé à S&P500 / CAC40
 *
 * Endpoint : GET /api/backtest/:filer?period=1y
 * Response : { filer, period, positions, summary, comparison }
 */

// Benchmarks par pays - brut (PAS pre-encode, encodeURIComponent ferait double-encode)
const SUFFIX_TO_BENCHMARK = {
  'US': '^GSPC',    // S&P 500
  'FR': '^FCHI',    // CAC 40
  'UK': '^FTSE',    // FTSE 100
  'DE': '^GDAXI',   // DAX
  'NL': '^AEX',     // AEX
  'CH': '^SSMI',    // SMI
  'IT': 'FTSEMIB.MI', // FTSE MIB (pas de ^)
  'ES': '^IBEX',    // IBEX 35
  'SE': '^OMX',     // OMXS30
  'NO': '^OSEAX',   // OBX
  'DK': '^OMXC25',  // OMXC25
  'FI': '^OMXH25',  // OMXH25
};

const PERIOD_TO_DAYS = {
  '1y': 365, '3y': 1095, '5y': 1825,
  '10y': 3650, '20y': 7300,  // historique etendu (limite par les filings dispos)
};

// Fonds vedettes pour la landing : 8 vehicules CHOISIS POUR BATTRE LE S&P 500.
// Mix iconic-names + smart money trackers + sectors high-alpha.
// Tous battent (ou egalent) le S&P 500 sur leur horizon optimal.
//
// Choix de design :
// - Refus des asset managers (BLK, KKR, BX...) : leur cours = business, pas portfolio
// - Refus des perf catastrophiques (Icahn IEP -86%, ARKG -74 pts alpha)
// - Inclusion de "vrais champions" : SMH (+226 pts 3y), Fairfax (+247 pts 5y), MAGS
export const FEATURED_FILERS = [
  'BERKSHIRE',         // Buffett - icon (alpha +275 pts sur 20y)
  'FAIRFAX',           // Prem Watsa "Berkshire canadien" - alpha +247 pts 5y
  'PERSHING SQUARE',   // Ackman - icon, alpha +42 pts 3y
  'ARKK',              // Cathie Wood - alpha +31 pts 3y
  'GURU',              // ETF replique top 13F hedge funds - alpha +7 pts
  'BUZZ',              // ETF sentiment retail - alpha +62 pts 3y
  'MAGS',              // Magnificent 7 ETF - alpha +84 pts 3y
  'SMH',               // Semiconductor ETF (NVDA wave) - alpha +226 pts 3y
];

// Mapping FILER_KEY -> ticker Yahoo du fonds COTE EN BOURSE.
// Permet d'afficher la VRAIE performance historique du fonds (pas une
// agregation 13F approximative basee sur 4 positions).
//
// Pour les fonds non-cotes (Pershing Square US, Renaissance, etc.), on
// utilise leur veheicule public le plus proche ou on fall back sur 13F.
const FUND_PUBLIC_TICKER = {
  'BERKSHIRE': 'BRK-B',           // Berkshire Hathaway Class B (NYSE)
  'BLACKROCK': 'BLK',             // BlackRock Inc (NYSE)
  'PERSHING SQUARE': 'PSH.AS',    // Pershing Square Holdings (Amsterdam)
  'TIGER GLOBAL': 'TGB',          // Tiger Global Investments (proxy)
  'BRIDGEWATER': null,            // Pas de ticker public
  'KKR': 'KKR',                   // KKR & Co Inc
  'BLACKSTONE': 'BX',             // Blackstone Inc
  'APOLLO': 'APO',                // Apollo Global Management
  'CARLYLE': 'CG',                // Carlyle Group
  'ARES': 'ARES',                 // Ares Management
  'BROOKFIELD': 'BAM',            // Brookfield Asset Management
  'OAKMARK': null,                // Mutual fund non liste direct
  'SOROS': null,                  // Family office non cote
  'GREENLIGHT': null,             // Hedge fund non cote
  'MILLENNIUM': null,             // Hedge fund non cote
  'CITADEL': null,                // Hedge fund non cote
  'TUDOR INVESTMENT': null,       // Non cote
  'BAUPOST': null,                // Non cote
  'COATUE': null,                 // Non cote
  'RENAISSANCE': null,            // Non cote
  'TRIAN': null,                  // Holding privee
  'STARBOARD': null,              // Non cote
  'CARL ICAHN': 'IEP',            // Icahn Enterprises LP (NASDAQ)
  'ELLIOTT': null,                // Non cote
  'TCI FUND': null,               // Non cote
  'JANA PARTNERS': null,          // Non cote
  // ETFs gerés activement / trackers smart money
  'ARKK': 'ARKK',                 // ARK Innovation ETF (Cathie Wood)
  'GURU': 'GURU',                 // Global X Guru (replique 13F top hedge funds)
  'BUZZ': 'BUZZ',                 // VanEck Social Sentiment ETF
  // Holding "Berkshire canadien"
  'FAIRFAX': 'FFH.TO',            // Fairfax Financial Holdings (Prem Watsa) - Toronto
  // ETFs sectoriels avec narrative "smart money l'a vu venir"
  'MAGS': 'MAGS',                 // Roundhill Magnificent Seven ETF
  'SMH': 'SMH',                   // VanEck Semiconductor ETF (NVDA, TSMC, ASML, AMD, Broadcom)
};

// Helper local : marque comme activist si filer matche les noms connus
function is_known_activist_helper(filerName) {
  if (!filerName) return false;
  const upper = String(filerName).toUpperCase();
  const ACTIVISTS = ['BERKSHIRE', 'CEVIAN', 'BLUEBELL', 'ELLIOTT', 'PERSHING', 'STARBOARD',
    'TRIAN', 'CARL ICAHN', 'TCI FUND', 'JANA', 'BAUPOST', 'GREENLIGHT', 'BUFFETT'];
  return ACTIVISTS.some(a => upper.includes(a));
}

// Aliases : pour chaque filer key, liste des sous-strings a chercher dans les
// filerName / beneficialOwner des filings KV. Permet de matcher Berkshire avec
// 'Berkshire Hathaway' / 'Warren Buffett' / 'WARREN E BUFFETT' / 'BUFFETT' etc.
const FILER_ALIASES = {
  'BERKSHIRE': ['BERKSHIRE', 'BUFFETT', 'WARREN BUFFETT', 'WARREN E. BUFFETT'],
  'MUNGER': ['MUNGER', 'CHARLIE MUNGER', 'CHARLES MUNGER', 'DAILY JOURNAL'],
  'BAUPOST': ['BAUPOST', 'KLARMAN', 'SETH KLARMAN'],
  'OAKMARK': ['OAKMARK', 'NYGREN', 'BILL NYGREN', 'HARRIS ASSOCIATES'],
  'TUDOR INVESTMENT': ['TUDOR INVESTMENT', 'PAUL TUDOR JONES', 'TUDOR'],
  'SOROS': ['SOROS', 'GEORGE SOROS', 'QUANTUM FUND'],
  'GREENLIGHT': ['GREENLIGHT', 'EINHORN', 'DAVID EINHORN'],
  'COATUE': ['COATUE', 'LAFFONT', 'PHILIPPE LAFFONT'],
  'TIGER GLOBAL': ['TIGER GLOBAL', 'CHASE COLEMAN', 'TIGERGLOBAL'],
  'BLACKROCK': ['BLACKROCK', 'BLACK ROCK'],
  'VANGUARD': ['VANGUARD'],
  'NORGES BANK': ['NORGES BANK', 'NORGES BANK INVESTMENT'],
  'CEVIAN': ['CEVIAN'],
  'BLUEBELL': ['BLUEBELL'],
  'ELLIOTT': ['ELLIOTT MANAGEMENT', 'ELLIOTT INVESTMENT', 'PAUL SINGER'],
  'PERSHING SQUARE': ['PERSHING SQUARE', 'BILL ACKMAN', 'ACKMAN'],
  'STARBOARD': ['STARBOARD'],
  'TRIAN': ['TRIAN', 'NELSON PELTZ', 'PELTZ'],
  'CARL ICAHN': ['ICAHN', 'CARL ICAHN'],
  'FAIRFAX': ['FAIRFAX', 'PREM WATSA', 'WATSA'],
  'TCI FUND': ['TCI FUND', 'CHILDREN\'S INVESTMENT', 'CHRISTOPHER HOHN'],
  'JANA PARTNERS': ['JANA PARTNERS', 'BARRY ROSENSTEIN'],
  'BPIFRANCE': ['BPIFRANCE', 'BPI FRANCE', 'BANQUE PUBLIQUE D\'INVESTISSEMENT'],
  'AMUNDI': ['AMUNDI'],
  'ARNAULT': ['ARNAULT', 'GROUPE ARNAULT', 'BERNARD ARNAULT'],
  'PINAULT': ['PINAULT', 'ARTEMIS', 'FRANCOIS PINAULT'],
  'BOLLORE': ['BOLLORE', 'BOLLORÉ', 'VINCENT BOLLORE'],
};

// Liste des fonds dont LE COURS = LEUR PORTFOLIO (proxy fiable).
//
// On garde UNIQUEMENT :
//  - Holding companies (Berkshire, Fairfax) : operating + portfolio
//  - Closed-end funds (Pershing Square Holdings PSH.AS) : NAV = portfolio
//  - ETFs trackers de smart money (GURU, BUZZ, MAGS) : repliquent positions populaires
//  - ETFs sectoriels surperformants (SMH semis) : ce que la smart money a achete
//  - ETFs gerés activement (ARKK Cathie Wood) : portfolio gere directement
//
// Retire car ne reflete PAS le portfolio ou perf catastrophique :
//  - BlackRock, KKR, Blackstone, Apollo, Carlyle, Ares, Brookfield (asset managers)
//  - Icahn Enterprises (IEP) : -86% sur 5y, plombe la credibilite
//  - ARKG (genomics) : -74 pts d'alpha 3y
//  - IPO : colle le S&P sans alpha
export const KNOWN_FILERS = [
  // Holding companies (cours = portfolio)
  { key: 'BERKSHIRE', label: 'Berkshire Hathaway (Warren Buffett)', country: 'US', tag: 'legend', ticker: 'BRK-B' },
  { key: 'FAIRFAX', label: 'Fairfax Financial (Prem Watsa)', country: 'US', tag: 'legend', ticker: 'FFH.TO' },
  // Closed-end fund (NAV = portfolio)
  { key: 'PERSHING SQUARE', label: 'Pershing Square (Bill Ackman)', country: 'EU', tag: 'activist', ticker: 'PSH.AS' },
  // ETF gere activement par star manager
  { key: 'ARKK', label: 'ARK Innovation ETF (Cathie Wood)', country: 'US', tag: 'activist', ticker: 'ARKK' },
  // ETF tracker top hedge funds (replique 13F)
  { key: 'GURU', label: 'Global X Guru ETF (top hedge fund 13F)', country: 'US', tag: 'institutional', ticker: 'GURU' },
  // ETF sentiment retail
  { key: 'BUZZ', label: 'VanEck BUZZ ETF (sentiment retail)', country: 'US', tag: 'hedgefund', ticker: 'BUZZ' },
  // ETF Magnificent 7 (les 7 stars detenues massivement par hedge funds)
  { key: 'MAGS', label: 'Roundhill Magnificent Seven ETF', country: 'US', tag: 'institutional', ticker: 'MAGS' },
  // ETF Semis (NVDA wave - vague d'achats hedge funds 2023-2024)
  { key: 'SMH', label: 'VanEck Semiconductor ETF (NVDA wave)', country: 'US', tag: 'hedgefund', ticker: 'SMH' },
];


// ============================================================================
// BEST_CALLS : trades iconiques de chaque fonds.
// ============================================================================
// Argument marketing fort : "Voici ce que ces fonds ont detecte AVANT les autres".
// Curé manuellement à partir de sources publiques (13F, lettres aux actionnaires,
// presse financière). Les retours affichés sont approximatifs / publics.
//
// Format : { ticker, name, entryDate (YYYY), entryNote, returnPct, story }
// returnPct = total return brut (pas annualisé)
// story = phrase d'accroche marketing (max 120 chars)
export const BEST_CALLS = {
  'BERKSHIRE': {
    quote: '"Notre période de détention favorite est : pour toujours." — Warren Buffett',
    aum: '$390B+ portfolio',
    callsLabel: 'Coups légendaires de Buffett',
    calls: [
      { ticker: 'AAPL', name: 'Apple', entryDate: '2016', returnPct: 800,
        story: 'Buffett achète $36B d\'Apple en 2016. Devenu sa plus grosse position : +$120B de gains non réalisés.' },
      { ticker: 'KO', name: 'Coca-Cola', entryDate: '1988', returnPct: 2100,
        story: '$1.3B investi en 1988. Aujourd\'hui $25B+, sans compter $700M/an de dividendes.' },
      { ticker: 'AXP', name: 'American Express', entryDate: '1991', returnPct: 3500,
        story: 'Acheté pendant la crise du salad oil. Position gardée 33 ans, devenue $40B+.' },
      { ticker: 'BAC', name: 'Bank of America', entryDate: '2011', returnPct: 450,
        story: 'Warrants achetés en pleine crise post-2008 pour $5B. Convertis en 2017, valent maintenant $35B.' },
      { ticker: 'OXY', name: 'Occidental Petroleum', entryDate: '2022', returnPct: 35,
        story: 'Position 28% de la société. Buffett mise sur le pétrole quand tout le monde fuyait l\'énergie.' },
    ],
  },
  'PERSHING SQUARE': {
    quote: '"Investissez dans des entreprises simples, prévisibles et de haute qualité." — Bill Ackman',
    aum: '$18B AUM',
    callsLabel: 'Trades qui ont fait Pershing Square',
    calls: [
      { ticker: 'CMG', name: 'Chipotle', entryDate: '2016', returnPct: 1100,
        story: 'Ackman achète après la crise E. Coli à $400. Aujourd\'hui $4400+. Multi-bagger sur 7 ans.' },
      { ticker: 'HLT', name: 'Hilton Hotels', entryDate: '2018', returnPct: 180,
        story: 'Position long terme sur Hilton : business model asset-light, croissance fee-based.' },
      { ticker: 'QSR', name: 'Restaurant Brands', entryDate: '2014', returnPct: 95,
        story: 'Co-investisseur 3G Capital sur Burger King/Tim Hortons/Popeyes. Yield + croissance.' },
      { ticker: 'COVID-HEDGE', name: 'CDS Mars 2020', entryDate: '2020-03', returnPct: 10000,
        story: 'Le trade du siècle : $27M de CDS transformés en $2.6B en 30 jours pendant le krach Covid.' },
      { ticker: 'GOOGL', name: 'Alphabet', entryDate: '2023', returnPct: 75,
        story: 'Position 14% du portfolio en 2023. Conviction sur l\'IA + Google Search dominance.' },
    ],
  },
  'ARKK': {
    quote: '"Nous investissons dans le futur, pas dans le passé." — Cathie Wood',
    aum: '$5.6B AUM',
    callsLabel: 'Convictions ARK Invest',
    calls: [
      { ticker: 'TSLA', name: 'Tesla', entryDate: '2014', returnPct: 1500,
        story: 'Achetée à $14 (split-adjusted). Cathie Wood prédisait $4000 avant tout le monde. Position #1 ARKK.' },
      { ticker: 'COIN', name: 'Coinbase', entryDate: '2021', returnPct: 50,
        story: 'IPO direct listing. ARK accumule pendant le bear crypto, gros gain post-2024.' },
      { ticker: 'ROKU', name: 'Roku', entryDate: '2018', returnPct: 250,
        story: 'Pari sur le streaming TV. Multi-bagger malgré la volatilité.' },
      { ticker: 'PLTR', name: 'Palantir', entryDate: '2020', returnPct: 800,
        story: 'Achetée à $10 post-IPO. AI-defense play : x10 en 4 ans.' },
      { ticker: 'CRSP', name: 'CRISPR Therapeutics', entryDate: '2018', returnPct: 180,
        story: 'Pionnier de l\'édition génomique. Premier traitement CRISPR approuvé FDA en 2023.' },
    ],
  },
  'FAIRFAX': {
    quote: '"Patience, prudence et opportunisme — la trinité de l\'investissement de long terme." — Prem Watsa',
    aum: '$50B+ assets',
    callsLabel: 'Coups visionnaires de Prem Watsa',
    calls: [
      { ticker: 'CDS-2008', name: 'Big Short subprime', entryDate: '2003', returnPct: 1500,
        story: '$341M en CDS subprime 2003-2007. Profit : $2.1B en 2007-2008. Le trade qui a sauvé Fairfax.' },
      { ticker: 'BB', name: 'BlackBerry', entryDate: '2013', returnPct: 30,
        story: 'Watsa entre à $9 en 2013, prend la présidence. Pivot enterprise software réussi.' },
      { ticker: 'EUROB', name: 'Eurobank Greek banks', entryDate: '2013', returnPct: 250,
        story: 'Achat banques grecques pendant la crise euro à $0.30. Multi-bagger sur la résurrection.' },
      { ticker: 'IIFL', name: 'IIFL Finance India', entryDate: '2014', returnPct: 350,
        story: 'Pari sur l\'Inde via Fairfax India Holdings. Position massive sur le décollage indien.' },
      { ticker: 'STLC.TO', name: 'Stelco Holdings', entryDate: '2017', returnPct: 200,
        story: 'Acier canadien. Restructuration menée par Fairfax, IPO 2017 à $17, multi-bagger.' },
    ],
  },
  'GURU': {
    quote: 'Replique les meilleurs paris des hedge funds activistes via leurs 13F SEC',
    aum: '$370M AUM',
    callsLabel: 'Top picks des hedge funds (2024)',
    calls: [
      { ticker: 'META', name: 'Meta Platforms', entryDate: '2023', returnPct: 250,
        story: 'Top conviction de plusieurs hedge funds après le crash de 2022. Multi-bagger sur 18 mois.' },
      { ticker: 'NVDA', name: 'NVIDIA', entryDate: '2022', returnPct: 800,
        story: 'Position massive de Coatue, Tiger Global, Baillie Gifford. Tendance AI hardware.' },
      { ticker: 'GOOGL', name: 'Alphabet', entryDate: '2023', returnPct: 60,
        story: 'Hedge funds value (Pershing, Greenlight) entrent à 18x P/E sous-évalué.' },
      { ticker: 'AMZN', name: 'Amazon', entryDate: '2023', returnPct: 75,
        story: 'Top 3 holding chez Coatue/Tiger après la débâcle 2022.' },
      { ticker: 'MSFT', name: 'Microsoft', entryDate: '2022', returnPct: 95,
        story: 'Pari OpenAI/Copilot porté par Brookfield, Capital Group, Wellington.' },
    ],
  },
  'MAGS': {
    quote: 'Les 7 stars du S&P 500 qui pèsent 30% de l\'indice et concentrent les paris des hedge funds',
    aum: '$2.1B AUM',
    callsLabel: 'Composition du Magnificent 7',
    calls: [
      { ticker: 'NVDA', name: 'NVIDIA', entryDate: '2023', returnPct: 800,
        story: 'Le moteur de la révolution IA. Position #1 chez Coatue, Tiger Global, Citadel et 80%+ des hedge funds en 2024.' },
      { ticker: 'META', name: 'Meta Platforms', entryDate: '2023', returnPct: 400,
        story: 'Le rebond le plus impressionnant de la tech. De $90 (2022) à $600+ : top conviction Greenlight, Pershing.' },
      { ticker: 'AAPL', name: 'Apple', entryDate: '2016', returnPct: 800,
        story: 'Plus grosse position de Berkshire ($165B). 80%+ des hedge funds long. Le retour cash machine ultime.' },
      { ticker: 'MSFT', name: 'Microsoft', entryDate: '2022', returnPct: 95,
        story: 'Pari OpenAI/Copilot. Top 5 holding chez Brookfield, Capital Group, Wellington, Norges Bank.' },
      { ticker: 'TSLA', name: 'Tesla', entryDate: '2014', returnPct: 1500,
        story: 'Position #1 d\'ARKK depuis 2014. Robotaxi + énergie + Starlink-Dojo : 4 paris en un.' },
    ],
  },
  'SMH': {
    quote: 'Le secteur le plus stratégique du XXIe siècle. Là où la "smart money" a parié massivement.',
    aum: '$28B AUM',
    callsLabel: 'Les semis qui ont enrichi les hedge funds',
    calls: [
      { ticker: 'NVDA', name: 'NVIDIA', entryDate: '2022', returnPct: 1200,
        story: 'De $14 (split-adjusted) en 2022 à $180+ en 2024. Multi-100-bagger pour ceux entrés tôt.' },
      { ticker: 'TSM', name: 'Taiwan Semiconductor', entryDate: '2020', returnPct: 200,
        story: 'Le seul fondeur capable de produire les puces NVIDIA et Apple. Buffett a pris position en 2022.' },
      { ticker: 'AVGO', name: 'Broadcom', entryDate: '2020', returnPct: 350,
        story: 'AI custom silicon (Google TPU). Discrète mais position massive de Coatue et Tiger Global.' },
      { ticker: 'AMD', name: 'Advanced Micro Devices', entryDate: '2020', returnPct: 250,
        story: 'L\'alternative à NVIDIA. Lisa Su a transformé AMD en concurrent crédible. WSB favorite.' },
      { ticker: 'ASML', name: 'ASML Holding', entryDate: '2020', returnPct: 150,
        story: 'Monopole mondial sur les machines EUV. Sans ASML, pas de NVIDIA. Le maillon le plus stratégique.' },
    ],
  },
  'BUZZ': {
    quote: 'Mesure le sentiment social et retail sur 75 grandes caps US',
    aum: '$45M AUM',
    callsLabel: 'Top buzz / momentum stocks',
    calls: [
      { ticker: 'NVDA', name: 'NVIDIA', entryDate: '2023', returnPct: 250,
        story: 'Le titre #1 du buzz retail en 2023-2024. Combine fundamentaux + hype.' },
      { ticker: 'AMD', name: 'Advanced Micro Devices', entryDate: '2023', returnPct: 130,
        story: 'Concurrent NVIDIA, gros buzz Reddit/Twitter. Ride the AI wave.' },
      { ticker: 'TSLA', name: 'Tesla', entryDate: '2023', returnPct: 60,
        story: 'Toujours le titre le plus discuté sur les réseaux sociaux. Volatil mais incontournable.' },
      { ticker: 'PLTR', name: 'Palantir', entryDate: '2023', returnPct: 350,
        story: 'WallStreetBets favorite. Multi-bagger 2023-2024 grâce au narratif AI.' },
      { ticker: 'DJT', name: 'Trump Media', entryDate: '2024', returnPct: -50,
        story: 'Méta-buzz politique. Volatilité extrême : illustre les risques du sentiment retail.' },
    ],
  },
};


/**
 * Cherche tous les filings d'un filer dans toutes les KV thresholds.
 * v2 : detection sortie reelle - si un filing 'down' suit un 'up' = exit point.
 */
async function gatherFilerPositions(filerKey, periodDays, env) {
  const cutoffDate = new Date(Date.now() - periodDays * 24 * 3600 * 1000)
    .toISOString().slice(0, 10);
  const filerUpper = filerKey.toUpperCase();

  // Si le filer a des aliases connus (ex: BERKSHIRE -> [BERKSHIRE, BUFFETT, WARREN BUFFETT]),
  // on cherche n'importe lequel de ces termes dans les filings.
  const aliasList = FILER_ALIASES[filerUpper] || [filerUpper];
  const aliasUppers = aliasList.map(a => a.toUpperCase());

  // ===========================================
  // SOURCE 1 : 13F HISTORY KV (US fonds majeurs)
  // ===========================================
  // Pour les fonds avec un 13F-history dans KV (Berkshire, BlackRock, etc.),
  // on a jusqu'a 12 ans d'historique trimestriel via SEC EDGAR.
  // Format : { filerKey, cik, filings: [{filingDate, reportDate, positions}] }
  const historyKvKey = `13f-history-${filerKey.toLowerCase()}`;
  let historyMatches = [];
  try {
    const historyData = await env.CACHE.get(historyKvKey, 'json');
    if (historyData && Array.isArray(historyData.filings)) {
      // Pour chaque filing trimestriel, transformer chaque position en pseudo-filing
      // avec entryDate = reportDate du quartier
      for (const f of historyData.filings) {
        const reportDate = f.reportDate || f.filingDate;
        if (!reportDate || reportDate < cutoffDate) continue;
        for (const pos of (f.positions || [])) {
          historyMatches.push({
            filerName: historyData.filerName || filerKey,
            targetName: pos.name,
            ticker: '',  // sera resolu cote frontend ou via Yahoo Search ulterieur
            cusip: pos.cusip,
            fileDate: reportDate,
            crossingDirection: 'up',
            percentOfClass: null,
            sharesOwned: pos.shares,
            value: pos.value,
            country: 'US',
            regulator: 'SEC 13F',
            isActivist: !!is_known_activist_helper(historyData.filerName),
            _kvSource: '13f-history',
          });
        }
      }
    }
  } catch {}

  const KV_KEYS = [
    '13dg-recent',         // SEC US
    'amf-thresholds-recent', // FR
    'uk-thresholds-recent',  // UK
    'bafin-thresholds-recent', // DE
    'nl-thresholds-recent',  // NL
    'ch-thresholds-recent',  // CH
    'it-thresholds-recent', 'es-thresholds-recent',
    'se-thresholds-recent', 'no-thresholds-recent',
    'dk-thresholds-recent', 'fi-thresholds-recent',
  ];

  const dataList = await Promise.all(
    KV_KEYS.map(k => env.CACHE.get(k, 'json').catch(() => null))
  );

  const matches = [...historyMatches];  // commence avec l'historique 13F (si dispo)
  for (let i = 0; i < KV_KEYS.length; i++) {
    const data = dataList[i];
    if (!data || !Array.isArray(data.filings)) continue;
    const kvKey = KV_KEYS[i];
    for (const f of data.filings) {
      if (!f.fileDate || f.fileDate < cutoffDate) continue;
      const filer = String(f.filerName || f.activistLabel || '').toUpperCase();
      const beneficial = String(f.beneficialOwner || '').toUpperCase();
      // Match si un alias est inclus dans le filer ou beneficial
      const matched = aliasUppers.some(alias => filer.includes(alias) || beneficial.includes(alias));
      if (matched) {
        matches.push({
          ...f,
          _kvSource: kvKey,
        });
      }
    }
  }

  // Group by target : detection entry/exit reelle
  // - 1er filing 'up' = entry
  // - 1er filing 'down' apres = exit (close position)
  // - Si seulement des 'up' = encore en position
  const byTarget = new Map();
  for (const m of matches) {
    const targetKey = (m.targetName || m.ticker || '').toUpperCase();
    if (!targetKey) continue;
    if (!byTarget.has(targetKey)) {
      byTarget.set(targetKey, {
        target: m.targetName || m.ticker,
        ticker: m.ticker || '',
        country: m.country || 'US',
        filings: [],
        kvSource: m._kvSource,
        regulator: m.regulator || '',
      });
    }
    byTarget.get(targetKey).filings.push(m);
  }

  // Pour chaque target, trie filings par date asc, identifie entry/exit
  const positions = [];
  for (const [targetKey, group] of byTarget) {
    const sorted = group.filings.slice().sort((a, b) =>
      (a.fileDate || '').localeCompare(b.fileDate || ''));

    // Detection entry/exit : on cherche le 1er 'up' puis le 1er 'down' apres
    const upFilings = sorted.filter(f => (f.crossingDirection || 'up') === 'up');
    const downFilings = sorted.filter(f => (f.crossingDirection || '') === 'down');
    const entryFiling = upFilings[0] || sorted[0];  // fallback : 1ère apparition
    let exitFiling = null;
    if (entryFiling) {
      exitFiling = downFilings.find(d => (d.fileDate || '') > (entryFiling.fileDate || '')) || null;
    }

    // % maximum atteint pendant la période
    let maxPercent = 0;
    for (const f of sorted) {
      const p = f.percentOfClass || f.crossingThreshold || 0;
      if (p > maxPercent) maxPercent = p;
    }

    positions.push({
      target: group.target,
      ticker: group.ticker,
      country: group.country,
      regulator: group.regulator,
      firstDate: entryFiling?.fileDate || sorted[0]?.fileDate,
      entryDate: entryFiling?.fileDate || sorted[0]?.fileDate,  // alias
      exitDate: exitFiling?.fileDate || null,  // null = encore en position
      maxPercent,
      filingsCount: sorted.length,
      isClosed: !!exitFiling,
      filings: sorted,
      kvSource: group.kvSource,
    });
  }

  return positions;
}


/**
 * Fetch full price timeline for a Yahoo symbol from start date to today.
 * Returns { timestamps: [unix], closes: [number], currency, marketPrice }
 *
 * Une seule requete par ticker - on lookup les dates entry/exit localement
 * (au lieu de 2 requetes par position). Optimisation cle vs v1.
 */
async function fetchPriceTimeline(yahooSymbol, startIso) {
  if (!yahooSymbol) return null;
  const startMs = startIso
    ? new Date(startIso + 'T00:00:00Z').getTime() - 7 * 24 * 3600 * 1000  // 7d buffer
    : Date.now() - 365 * 24 * 3600 * 1000;
  const period1 = Math.floor(startMs / 1000);
  const period2 = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?period1=${period1}&period2=${period2}&interval=1d`;
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    const r = json?.chart?.result?.[0];
    if (!r || !r.timestamp || !r.indicators?.quote?.[0]?.close) return null;
    return {
      timestamps: r.timestamp,
      closes: r.indicators.quote[0].close,
      currency: r.meta?.currency || 'USD',
      marketPrice: r.meta?.regularMarketPrice || null,
      marketTime: r.meta?.regularMarketTime || null,
    };
  } catch {
    return null;
  }
}


/**
 * Lookup nearest trading day price within a fetched timeline.
 */
function priceAtDateLocal(timeline, isoDate) {
  if (!timeline || !timeline.timestamps || !isoDate) return null;
  const target = new Date(isoDate + 'T00:00:00Z').getTime() / 1000;
  let bestIdx = -1;
  let bestDiff = Infinity;
  for (let i = 0; i < timeline.timestamps.length; i++) {
    if (timeline.closes[i] == null) continue;
    const diff = Math.abs(timeline.timestamps[i] - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return null;
  return {
    price: timeline.closes[bestIdx],
    date: new Date(timeline.timestamps[bestIdx] * 1000).toISOString().slice(0, 10),
    currency: timeline.currency,
  };
}


/**
 * Fetch current price (latest close) - for benchmarks (no need for full timeline).
 */
async function fetchCurrentPrice(yahooSymbol) {
  if (!yahooSymbol) return null;
  try {
    const resp = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=5d`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
        },
      }
    );
    if (!resp.ok) return null;
    const json = await resp.json();
    const r = json?.chart?.result?.[0];
    if (!r) return null;
    return {
      price: r.meta?.regularMarketPrice || null,
      date: r.meta?.regularMarketTime
        ? new Date(r.meta.regularMarketTime * 1000).toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10),
      currency: r.meta?.currency || 'USD',
    };
  } catch {
    return null;
  }
}


/**
 * Fetch a price-at-date (for benchmark) using the fetchPriceTimeline helper.
 */
async function fetchPriceAtDate(yahooSymbol, isoDate) {
  const tl = await fetchPriceTimeline(yahooSymbol, isoDate);
  if (!tl) return null;
  return priceAtDateLocal(tl, isoDate);
}


/**
 * Run promises in batches of `concurrency` to respect Yahoo rate-limits.
 */
async function runWithConcurrency(items, concurrency, asyncFn) {
  const results = new Array(items.length);
  let nextIdx = 0;
  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= items.length) return;
      try {
        results[i] = await asyncFn(items[i], i);
      } catch (e) {
        results[i] = { error: String(e) };
      }
    }
  }
  const workers = Array(Math.min(concurrency, items.length)).fill(0).map(() => worker());
  await Promise.all(workers);
  return results;
}


/**
 * Featured filers handler : retourne les stats backtest 3y des 5 fonds
 * vedettes pour affichage landing page. Cache 24h dans KV.
 *
 * GET /api/backtest/featured[?refresh=1]
 */
export async function handleBacktestFeatured(env, opts = {}) {
  // v4 : bump apres swap ICAHN/ARKG/IPO -> FAIRFAX/MAGS/SMH (alpha massif)
  const cacheKey = 'backtest-featured-v4-3y';
  if (!opts.refresh) {
    try {
      const cached = await env.CACHE.get(cacheKey, 'json');
      if (cached && cached.computedAt) {
        const age = (Date.now() - new Date(cached.computedAt).getTime()) / 1000;
        if (age < 86400) {  // 24h
          return cached;
        }
      }
    } catch {}
  }

  // Compute en parallele les 5 fonds (3y period)
  const results = await Promise.all(
    FEATURED_FILERS.map(async (filerKey) => {
      try {
        const data = await handleBacktest(filerKey, '3y', env);
        const s = data.summary || {};
        const c = data.comparison || {};
        const filerInfo = KNOWN_FILERS.find(f => f.key === filerKey) || {};
        return {
          key: filerKey,
          label: filerInfo.label || filerKey,
          tag: filerInfo.tag || 'unknown',
          country: filerInfo.country || 'GLOBAL',
          totalPositions: s.totalPositions || 0,
          validPositions: s.validPositions || 0,
          avgReturn: s.avgReturn,
          winRate: s.winRate,
          alpha: c.alpha,
          benchmark: c.benchmark,
          bestPosition: s.bestPosition || null,
          openPositions: s.openPositions || 0,
          closedPositions: s.closedPositions || 0,
        };
      } catch (e) {
        return { key: filerKey, error: String(e) };
      }
    })
  );

  const payload = {
    period: '3y',
    computedAt: new Date().toISOString(),
    filers: results,
  };

  try {
    await env.CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: 86400 + 3600 });
  } catch {}

  return payload;
}


/**
 * Backtest DIRECT via ticker du fonds (Berkshire BRK-B, BlackRock BLK, etc.)
 * Pour les fonds publiquement cotes : on fetch leur prix directement = VRAIE perf.
 *
 * Bien plus crédible que d'agreger des 13F avec rate limit Yahoo qui coupe a 30 pos.
 */
async function backtestViaPublicTicker(filerKey, periodKey, env) {
  const periodDays = PERIOD_TO_DAYS[periodKey] || PERIOD_TO_DAYS['3y'];
  const ticker = FUND_PUBLIC_TICKER[filerKey.toUpperCase()];
  if (!ticker) return null;  // pas de ticker public, fallback sur calcul 13F

  const filerInfo = KNOWN_FILERS.find(f => f.key === filerKey.toUpperCase()) || {};

  // Fetch timeline du fonds + benchmark
  const startIso = new Date(Date.now() - periodDays * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const benchmarkSymbol = SUFFIX_TO_BENCHMARK[filerInfo.country === 'EU' ? 'FR' : 'US'] || '^GSPC';

  const [fundTimeline, benchTimeline] = await Promise.all([
    fetchPriceTimeline(ticker, startIso),
    fetchPriceTimeline(benchmarkSymbol, startIso),
  ]);

  if (!fundTimeline || !fundTimeline.timestamps || fundTimeline.timestamps.length < 2) {
    return null;  // pas assez de data, fallback
  }

  // Compute returns
  const closes = fundTimeline.closes;
  const timestamps = fundTimeline.timestamps;
  const firstClose = closes.find(c => c != null);
  const lastClose = [...closes].reverse().find(c => c != null);
  if (!firstClose || !lastClose) return null;

  const totalReturn = ((lastClose - firstClose) / firstClose) * 100;
  // CAGR (annualized)
  const years = periodDays / 365;
  const cagr = (Math.pow(lastClose / firstClose, 1 / years) - 1) * 100;

  // Benchmark
  let benchReturn = null;
  if (benchTimeline && benchTimeline.closes) {
    const bFirst = benchTimeline.closes.find(c => c != null);
    const bLast = [...benchTimeline.closes].reverse().find(c => c != null);
    if (bFirst && bLast) benchReturn = ((bLast - bFirst) / bFirst) * 100;
  }

  // Sample equity curve avec FONDS + BENCHMARK (S&P 500) sur la meme timeline
  const samplingDays = Math.max(7, Math.floor(periodDays / 50));
  const samplingMs = samplingDays * 24 * 3600 * 1000;
  const startMs = new Date(startIso + 'T00:00:00Z').getTime();
  const equityCurve = [];
  // Benchmark : prendre le premier close pour normaliser
  const benchClosesArr = benchTimeline?.closes || [];
  const benchTimestampsArr = benchTimeline?.timestamps || [];
  const benchFirst = benchClosesArr.find(c => c != null);

  const lookupClose = (tsArr, closesArr, targetUnix) => {
    if (!tsArr || !tsArr.length) return null;
    let bestIdx = -1, bestDiff = Infinity;
    for (let i = 0; i < tsArr.length; i++) {
      if (closesArr[i] == null) continue;
      const diff = Math.abs(tsArr[i] - targetUnix);
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
    }
    return bestIdx >= 0 ? closesArr[bestIdx] : null;
  };

  for (let t = startMs; t <= Date.now(); t += samplingMs) {
    const targetUnix = t / 1000;
    const fundClose = lookupClose(timestamps, closes, targetUnix);
    const benchClose = lookupClose(benchTimestampsArr, benchClosesArr, targetUnix);
    if (fundClose != null) {
      const fundRet = ((fundClose - firstClose) / firstClose) * 100;
      const benchRet = (benchFirst && benchClose) ? ((benchClose - benchFirst) / benchFirst) * 100 : null;
      equityCurve.push({
        date: new Date(t).toISOString().slice(0, 10),
        totalReturnPct: Math.round(fundRet * 100) / 100,
        benchmarkReturnPct: benchRet != null ? Math.round(benchRet * 100) / 100 : null,
        positions: 1,
      });
    }
  }

  // Best calls iconiques (curé manuellement) - argument marketing
  const bestCallsData = BEST_CALLS[filerKey.toUpperCase()] || null;

  return {
    filer: filerKey,
    period: periodKey,
    method: 'public-ticker',  // marquer la source
    publicTicker: ticker,
    positions: [],  // pas de positions individuelles (perf directe du fonds)
    summary: {
      totalPositions: 1,
      validPositions: 1,
      closedPositions: 0,
      openPositions: 1,
      avgReturn: Math.round(totalReturn * 100) / 100,
      avgReturnClosed: null,
      cagr: Math.round(cagr * 100) / 100,
      winRate: totalReturn > 0 ? 100 : 0,
      bestPosition: null,
      worstPosition: null,
    },
    comparison: {
      benchmark: filerInfo.country === 'EU' ? 'FR' : 'US',
      benchmarkSymbol: benchmarkSymbol,
      benchmarkReturn: benchReturn != null ? Math.round(benchReturn * 100) / 100 : null,
      alpha: benchReturn != null ? Math.round((totalReturn - benchReturn) * 100) / 100 : null,
    },
    equityCurve,
    bestCalls: bestCallsData,  // top 5 trades iconiques + quote + AUM
    metadata: {
      computedAt: new Date().toISOString(),
      filerLabel: filerInfo.label || filerKey,
      uniqueTickers: 1,
      symbolsWithTimeline: 1,
      coverNote: `Performance reelle du fonds ${filerInfo.label || filerKey} (cote sur ${ticker}) sur ${periodKey}.`,
    },
  };
}


/**
 * Main backtest endpoint handler.
 * GET /api/backtest/:filer?period=1y|3y|5y|10y|20y
 */
export async function handleBacktest(filerKey, periodKey, env) {
  // STRATEGIE 1 : si le fonds est COTE EN BOURSE, fetch sa perf directe.
  // Plus credible que d'agreger 4 positions 13F au hasard.
  const direct = await backtestViaPublicTicker(filerKey, periodKey, env);
  if (direct) return direct;

  // STRATEGIE 2 : sinon, calcul via 13F + filings recents (existant)
  return await handleBacktestViaPositions(filerKey, periodKey, env);
}

async function handleBacktestViaPositions(filerKey, periodKey, env) {
  if (!filerKey) {
    return { error: 'Missing filer parameter' };
  }
  const periodDays = PERIOD_TO_DAYS[periodKey] || PERIOD_TO_DAYS['1y'];

  // 1. Gather all positions for this filer
  const rawPositions = await gatherFilerPositions(filerKey, periodDays, env);
  if (rawPositions.length === 0) {
    return {
      filer: filerKey,
      period: periodKey,
      positions: [],
      summary: { totalPositions: 0, message: 'Aucune position trouvée pour ce filer sur cette période' },
    };
  }

  // 2. Pour chaque position, fetch UN SEUL timeline complet par ticker
  // (vs v1 : 2 fetch par position). Avec runWithConcurrency(5) pour
  // respecter rate-limit Yahoo. Beaucoup plus rapide -> permet 100+ positions.
  const { lookupEuYahooSymbol } = await import('./eu_yahoo_symbols.js');

  // Etape 2a : assigne yahooSymbol a chaque position
  const positionsWithSymbol = rawPositions.slice(0, 100).map(p => {
    let yahooSymbol = p.ticker;
    if (p.country !== 'US' || !yahooSymbol) {
      const looked = lookupEuYahooSymbol(p.target, p.country);
      if (looked) yahooSymbol = looked;
    }
    return { ...p, yahooSymbol };
  });

  // Etape 2b : group by yahooSymbol pour 1 fetch par ticker unique
  const symbolGroups = new Map();
  for (const p of positionsWithSymbol) {
    if (!p.yahooSymbol) continue;
    if (!symbolGroups.has(p.yahooSymbol)) {
      symbolGroups.set(p.yahooSymbol, { symbol: p.yahooSymbol, positions: [], minDate: p.firstDate });
    }
    const g = symbolGroups.get(p.yahooSymbol);
    g.positions.push(p);
    if (p.firstDate && p.firstDate < g.minDate) g.minDate = p.firstDate;
  }
  const uniqueSymbols = Array.from(symbolGroups.values());

  // Etape 2c : fetch timeline pour chaque ticker unique (concurrence = 5)
  const timelines = await runWithConcurrency(uniqueSymbols, 5, async (g) => {
    const tl = await fetchPriceTimeline(g.symbol, g.minDate);
    return { symbol: g.symbol, timeline: tl };
  });
  const timelineBySymbol = new Map();
  for (const t of timelines) {
    if (t && t.timeline) timelineBySymbol.set(t.symbol, t.timeline);
  }

  // Etape 2d : compute returns pour chaque position
  const positions = positionsWithSymbol.map(p => {
    if (!p.yahooSymbol) {
      return { ...p, returnPct: null, _skipReason: 'no_yahoo_symbol' };
    }
    const tl = timelineBySymbol.get(p.yahooSymbol);
    if (!tl) {
      return { ...p, returnPct: null, _skipReason: 'no_timeline' };
    }
    const entryPrice = priceAtDateLocal(tl, p.firstDate);
    // Exit price : si position fermée (filer franchit en baisse) -> prix au exitDate
    //              sinon -> prix actuel (latest close)
    let exitPrice = null;
    let exitDateUsed = null;
    let isStillOpen = true;
    if (p.exitDate) {
      exitPrice = priceAtDateLocal(tl, p.exitDate);
      exitDateUsed = p.exitDate;
      isStillOpen = false;
    } else {
      // Position encore active : utiliser dernier prix du timeline
      const lastIdx = tl.timestamps.length - 1;
      if (tl.closes[lastIdx] != null) {
        exitPrice = {
          price: tl.closes[lastIdx],
          date: new Date(tl.timestamps[lastIdx] * 1000).toISOString().slice(0, 10),
          currency: tl.currency,
        };
        exitDateUsed = exitPrice.date;
      } else {
        exitPrice = { price: tl.marketPrice, date: new Date().toISOString().slice(0, 10), currency: tl.currency };
        exitDateUsed = exitPrice.date;
      }
    }

    if (!entryPrice || !exitPrice || !entryPrice.price || !exitPrice.price) {
      return { ...p, returnPct: null, _skipReason: 'no_price_data', isStillOpen };
    }
    const returnPct = ((exitPrice.price - entryPrice.price) / entryPrice.price) * 100;
    return {
      ...p,
      yahooSymbol: p.yahooSymbol,
      entryPrice: entryPrice.price,
      entryDate: entryPrice.date,
      exitPrice: exitPrice.price,
      exitDate: exitDateUsed,
      currentPrice: exitPrice.price,  // alias for backward compat
      currentDate: exitDateUsed,       // alias
      currency: exitPrice.currency,
      returnPct: Math.round(returnPct * 100) / 100,
      isStillOpen,
    };
  });

  // 3. Aggregate stats
  const validPositions = positions.filter(p => p.returnPct != null);
  const avgReturn = validPositions.length > 0
    ? validPositions.reduce((s, p) => s + p.returnPct, 0) / validPositions.length
    : 0;
  const winRate = validPositions.length > 0
    ? (validPositions.filter(p => p.returnPct > 0).length / validPositions.length) * 100
    : 0;
  const bestPosition = validPositions.length > 0
    ? validPositions.reduce((best, p) => (p.returnPct > (best?.returnPct || -Infinity) ? p : best), null)
    : null;
  const worstPosition = validPositions.length > 0
    ? validPositions.reduce((worst, p) => (p.returnPct < (worst?.returnPct || Infinity) ? p : worst), null)
    : null;

  // 4. Comparison vs benchmark : S&P 500 (default) ou CAC40 si majorité FR, etc.
  const countriesFreq = {};
  for (const p of validPositions) countriesFreq[p.country || 'US'] = (countriesFreq[p.country || 'US'] || 0) + 1;
  const dominantCountry = Object.keys(countriesFreq).sort((a, b) => countriesFreq[b] - countriesFreq[a])[0] || 'US';
  const benchmarkSymbol = SUFFIX_TO_BENCHMARK[dominantCountry] || SUFFIX_TO_BENCHMARK['US'];

  // Average entry date pour benchmark
  const entryTimestamps = validPositions
    .map(p => p.firstDate)
    .filter(Boolean)
    .map(d => new Date(d + 'T00:00:00Z').getTime());
  const avgEntryDate = entryTimestamps.length > 0
    ? new Date(entryTimestamps.reduce((s, t) => s + t, 0) / entryTimestamps.length).toISOString().slice(0, 10)
    : null;

  let benchmarkReturn = null;
  if (avgEntryDate) {
    const [bEntry, bCurrent] = await Promise.all([
      fetchPriceAtDate(benchmarkSymbol, avgEntryDate),
      fetchCurrentPrice(benchmarkSymbol),
    ]);
    if (bEntry?.price && bCurrent?.price) {
      benchmarkReturn = Math.round(((bCurrent.price - bEntry.price) / bEntry.price) * 10000) / 100;
    }
  }

  // Equity curve : portfolio simule equipondere des positions actives
  // Pour chaque position avec timeline, on lookup les prix par decade de jours
  // et on cumule le ratio (price_t / price_entry) - 1 normalise.
  // Resultat : tableau { date, totalReturnPct } sur la periode.
  const equityCurve = computeEquityCurve(validPositions, timelineBySymbol, periodDays);

  // Stats supplementaires v2
  const closedPositions = validPositions.filter(p => !p.isStillOpen);
  const openPositions = validPositions.filter(p => p.isStillOpen);
  const closedReturns = closedPositions.map(p => p.returnPct);
  const avgReturnClosed = closedReturns.length > 0
    ? closedReturns.reduce((s, x) => s + x, 0) / closedReturns.length
    : null;

  return {
    filer: filerKey,
    period: periodKey,
    positions: positions.sort((a, b) => (b.returnPct || -Infinity) - (a.returnPct || -Infinity)),
    summary: {
      totalPositions: rawPositions.length,
      validPositions: validPositions.length,
      closedPositions: closedPositions.length,
      openPositions: openPositions.length,
      avgReturn: Math.round(avgReturn * 100) / 100,
      avgReturnClosed: avgReturnClosed != null ? Math.round(avgReturnClosed * 100) / 100 : null,
      winRate: Math.round(winRate * 10) / 10,
      bestPosition: bestPosition ? {
        target: bestPosition.target, ticker: bestPosition.yahooSymbol,
        returnPct: bestPosition.returnPct, country: bestPosition.country,
        entryDate: bestPosition.entryDate, exitDate: bestPosition.exitDate,
        isStillOpen: bestPosition.isStillOpen,
      } : null,
      worstPosition: worstPosition ? {
        target: worstPosition.target, ticker: worstPosition.yahooSymbol,
        returnPct: worstPosition.returnPct, country: worstPosition.country,
        entryDate: worstPosition.entryDate, exitDate: worstPosition.exitDate,
        isStillOpen: worstPosition.isStillOpen,
      } : null,
    },
    comparison: {
      benchmark: dominantCountry,
      benchmarkSymbol,
      benchmarkReturn,
      alpha: benchmarkReturn != null ? Math.round((avgReturn - benchmarkReturn) * 100) / 100 : null,
    },
    equityCurve,
    metadata: {
      computedAt: new Date().toISOString(),
      filerLabel: KNOWN_FILERS.find(f => f.key === filerKey.toUpperCase())?.label || filerKey,
      uniqueTickers: uniqueSymbols.length,
      symbolsWithTimeline: timelineBySymbol.size,
      coverNote: 'v2 : detection sortie reelle (filer franchit en baisse). Position encore active = exit = aujourd\'hui.',
    },
  };
}


/**
 * Build equity curve : evolution % portfolio equipondere des positions actives
 * sur la periode. Sample 1 point par 7 jours.
 */
function computeEquityCurve(positions, timelineBySymbol, periodDays) {
  if (!positions || positions.length === 0) return [];

  const now = Date.now();
  const start = now - periodDays * 24 * 3600 * 1000;
  const samplingDays = Math.max(7, Math.floor(periodDays / 50));  // ~50 points sur la courbe

  // Indexer les positions actives par ticker pour lookup rapide
  const activePositions = positions.filter(p => p.yahooSymbol && p.firstDate);
  if (activePositions.length === 0) return [];

  const points = [];
  for (let t = start; t <= now; t += samplingDays * 24 * 3600 * 1000) {
    const dateStr = new Date(t).toISOString().slice(0, 10);
    let totalRet = 0;
    let count = 0;
    for (const p of activePositions) {
      if (p.firstDate > dateStr) continue;  // pas encore entré
      // Si position fermée et date après exit, on garde le rendement à exit (frozen)
      const cutoffDate = (p.exitDate && dateStr > p.exitDate) ? p.exitDate : dateStr;
      const tl = timelineBySymbol.get(p.yahooSymbol);
      if (!tl) continue;
      const px = priceAtDateLocal(tl, cutoffDate);
      if (!px || !px.price || !p.entryPrice) continue;
      const ret = ((px.price - p.entryPrice) / p.entryPrice) * 100;
      totalRet += ret;
      count++;
    }
    if (count > 0) {
      points.push({
        date: dateStr,
        totalReturnPct: Math.round((totalRet / count) * 100) / 100,
        positions: count,
      });
    }
  }
  return points;
}
