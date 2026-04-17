/**
 * Kairos Insider - Module i18n
 * ============================================================
 * Module d'internationalisation centralise utilise par toutes les
 * pages (index.html, dashboard.html, action.html...).
 *
 * Usage HTML :
 *   <h1 data-i18n="hero.title">Voyez ce que les pros voient</h1>
 *   <p data-i18n="hero.subtitle">...</p>
 *
 * Usage JS :
 *   const label = window.KairosI18n.t('signal.buy');
 *
 * Toggle :
 *   window.KairosI18n.setLang('en');  // bascule + reload des textes
 *
 * Detection initiale :
 *   1. localStorage 'kairos-lang' si defini
 *   2. sinon URL ?lang=fr/en
 *   3. sinon navigator.language ('fr' si commence par 'fr', 'en' sinon)
 *   4. defaut 'fr'
 *
 * Persistance : localStorage + ajoute ?lang=X a l'URL pour partage.
 */
(function(global) {
  'use strict';

  const STORAGE_KEY = 'kairos-lang';
  const DEFAULT_LANG = 'fr';
  const SUPPORTED = ['fr', 'en'];

  // ============================================================
  // DICTIONNAIRE DE TRADUCTIONS
  // ============================================================
  // Convention de cles : namespace.subkey (ex: nav.dashboard, hero.title)
  // Les cles non traduites tombent en fallback sur la cle elle-meme.
  // ============================================================
  const DICT = {
    fr: {
      // ==== NAV (toutes pages) ====
      'nav.features': 'Fonctionnalités',
      'nav.pricing': 'Tarifs',
      'nav.data': 'Données',
      'nav.dashboard': 'Dashboard',
      'nav.home': 'Accueil',
      'nav.login': 'Connexion',
      'nav.logout': 'Déconnexion',
      'nav.try_free': 'Essayer gratuitement',
      'nav.lang_switch': 'EN',
      'nav.lang_switch_title': 'Switch to English',

      // ==== HERO (landing) ====
      'hero.badge': 'Plateforme en ligne · Données live SEC / AMF / BaFin',
      'hero.title_part1': 'Voyez ce que',
      'hero.title_part2': 'les pros voient.',
      'hero.subtitle_html': 'Suivez chaque jour les mouvements des <strong>200+ plus grands hedge funds</strong>, des <strong>dirigeants d\'entreprise</strong>, des <strong>politiciens US</strong> et des <strong>ETF thématiques</strong>. Un Kairos Score composite 0-100 synthétise 8 dimensions du smart money pour chaque action.',
      'hero.cta_try': 'Essayer gratuitement →',
      'hero.cta_example': 'Voir un exemple d\'analyse',
      'hero.meta_legal': '100% légal',
      'hero.meta_update': 'MàJ chaque matin à 7h',
      'hero.meta_french': '100% en français',
      'hero.meta_english': '100% in French',

      // ==== STATS ====
      'stats.funds_tracked': 'Hedge funds suivis',
      'stats.stocks_analyzed': 'Actions analysées',
      'stats.kairos_score': 'Kairos Score composite',
      'stats.daily_update': 'MàJ quotidienne (Paris)',

      // ==== POUR QUI ====
      'profiles.badge': 'Pour qui ?',
      'profiles.title_part1': 'Fait pour tous les investisseurs',
      'profiles.title_part2': 'qui veulent',
      'profiles.title_part3': 'un vrai avantage',
      'profiles.subtitle': 'Que tu investisses sur le long terme ou trade au jour le jour, Kairos Insider te donne l\'information que les institutionnels utilisent depuis toujours.',
      'profiles.long_term.title': 'Investisseur long terme',
      'profiles.long_term.desc': 'Construis un portefeuille aligné avec les convictions des plus grands gérants. Vois qui achète, qui vend, sur quel horizon.',
      'profiles.swing.title': 'Swing trader',
      'profiles.swing.desc': 'Détecte les rotations sectorielles, les mouvements d\'insiders en cluster et les spikes d\'intérêt retail sur les small caps.',
      'profiles.active.title': 'Trader actif',
      'profiles.active.desc': 'Analyse un ticker en 30 secondes : Kairos Score, insiders, 13F, Google Trends, fondamentaux, santé financière. Tout en un.',
      'profiles.diy.title': 'Épargnant DIY',
      'profiles.diy.desc': 'Importe ton portefeuille (tous brokers), suis tes performances, et ne rate plus jamais un signal majeur sur tes positions.',

      // ==== FEATURES ====
      'features.badge': 'Fonctionnalités',
      'features.title_part1': 'Tout le smart money',
      'features.title_part2': 'en une seule interface.',
      'features.subtitle': 'Une suite complète de modules connectés, mise à jour en continu avant l\'ouverture des marchés.',

      'feat.score.title': 'Kairos Score 0-100',
      'feat.score.desc': 'Une note unique qui synthétise <strong>tout le signal smart money</strong> : initiés, hedge funds, politiciens, momentum, valorisation, santé financière, consensus analystes, earnings. Un seul chiffre pour trancher — pas besoin d\'être analyste pour comprendre.',
      'feat.score.chip': '● Couverture US + Europe',

      'feat.consensus.title': 'Consensus Hedge Funds',
      'feat.consensus.desc_html': 'Explorez les portefeuilles de <strong>toutes les grandes stars</strong> : Buffett, Burry, Ackman, Tiger Global, Coatue, Bridgewater… Voyez les actions partagées en <strong>★ conviction</strong> et les paris contrariens. Qui suit qui, qui parie seul.',
      'feat.consensus.chip': '● Activité du trimestre',

      'feat.insiders.title': 'Transactions Insiders',
      'feat.insiders.desc': 'Chaque achat ou vente des <strong>dirigeants d\'entreprise</strong>, publié par les régulateurs officiels US, France et Allemagne. Traduit et contextualisé en français. Détection automatique des <strong>clusters d\'initiés</strong> — le signal le plus fiable quand plusieurs insiders achètent ensemble.',
      'feat.insiders.chip': '● MàJ quotidienne',

      'feat.trends.title': 'Hot Stocks — Google Trends',
      'feat.trends.desc': 'Repérez les actions dont <strong>l\'intérêt retail explose</strong> avant le reste du marché. Les spikes de recherche précèdent souvent les mouvements de prix — parfait pour chasser les small caps qui commencent à buzzer.',
      'feat.trends.chip': 'NEW · Signal retail',

      'feat.etf.title': 'ETF Live',
      'feat.etf.desc_html': 'Les portefeuilles <strong>live</strong> de tous les ETF smart money qui comptent. <strong>Politique US</strong> (Pelosi vs Républicains), <strong>hedge funds consensus</strong>, <strong>innovation disruptive</strong>, <strong>sentiment retail</strong>, <strong>thématiques sectorielles</strong>. Heatmap visuelle + détection des rotations.',
      'feat.etf.chip': 'NEW · Rotations live',

      'feat.history.title': 'Profondeur historique',
      'feat.history.desc_html': 'Remontez dans le temps. Voyez comment <strong>les positions évoluent</strong> trimestre après trimestre : quels fonds entrent ou sortent, quelles convictions se renforcent, quels Kairos Scores montent ou descendent. Une <strong>base profonde</strong> pour backtester vos intuitions.',
      'feat.history.chip': 'NEW · Historique long terme',

      'feat.deep.title': 'Analyse action complète',
      'feat.deep.desc': 'Une fiche exhaustive par action : <strong>Kairos Score</strong> visuel, ratios de valorisation, santé financière, historique earnings, concurrents sectoriels, objectifs analystes, chart avec les trades des initiés superposés. Tout ce qu\'il faut <strong>sans changer d\'onglet</strong>.',
      'feat.deep.chip': '● Des milliers de tickers',

      'feat.activists.title': 'Fonds Offensifs <span style="font-size:13px;color:var(--text-muted);font-weight:400">(Activistes)</span>',
      'feat.activists.desc_html': 'Quand un <strong>fonds offensif</strong> comme Elliott, Ackman ou Icahn achète plus de <strong>5 % d\'une entreprise</strong>, c\'est pour <strong>forcer un changement</strong> (vente d\'une division, CEO remplacé, rachats d\'actions). Carl Icahn chez Apple 2013 → +30 %. Kairos détecte ces déclarations en <strong>10 jours</strong> — 35 jours plus rapide que les 13F.',
      'feat.activists.chip': 'NEW · Signal 10 jours',

      'feat.watchlist.title': 'Watchlist &amp; Alertes Email',
      'feat.watchlist.desc_html': 'Créez votre <strong>watchlist personnalisée</strong> et recevez chaque matin un <strong>digest email</strong> avec tous les événements smart money détectés sur VOS actions : nouveaux clusters d\'initiés, entrées/sorties d\'ETF, variations du Kairos Score, consensus hedge funds qui change. Plus jamais rater un signal.',
      'feat.watchlist.chip': 'NEW · Alerte matinale 8h',

      'feat.portfolio.title': 'Mon Portefeuille',
      'feat.portfolio.desc_html': 'Importez votre historique depuis <strong>n\'importe quel broker</strong>. Suivez vos performances, win rate, drawdown — et comparez vos trades aux signaux smart money que vous auriez pu capter. <em>Synchronisation automatique à venir.</em>',
      'feat.portfolio.chip': 'BETA · Tous brokers',

      // ==== COMPARAISON ====
      'comp.badge': 'Comparaison',
      'comp.title_part1': 'Pourquoi',
      'comp.title_part2': '?',
      'comp.subtitle': 'La seule plateforme qui combine smart money + fondamentaux + retail + analyse francophone dans une interface unifiée.',
      'comp.col_feature': 'Fonctionnalité',
      'comp.row_french': 'Interface 100% française',
      'comp.row_score': 'Score composite 0-100 (8 dimensions)',
      'comp.row_eu_insiders': 'Insiders Europe (AMF + BaFin)',
      'comp.row_hedge_funds': 'Hedge Funds 13F (200+ fonds)',
      'comp.row_conviction': 'Consensus de conviction (★)',
      'comp.row_etf': 'ETF thématiques (politique, retail, ARK…)',
      'comp.row_trends': 'Google Trends intégré',
      'comp.row_history': 'Historique évolution (2 ans)',
      'comp.row_portfolio': 'Import portefeuille multi-broker',
      'comp.row_price': 'Prix',
      'comp.partial': 'Partiel',
      'comp.basic': 'Basique',
      'comp.limited': 'Limité',
      'comp.manual': 'Manuel',
      'comp.charts_only': 'Charts seul',

      // ==== HOW IT WORKS ====
      'how.badge': 'Comment ça marche',
      'how.title': 'Trois étapes. Un avantage.',
      'how.subtitle': 'Accédez en quelques minutes aux informations que les institutionnels utilisent depuis toujours.',
      'how.step1.title': 'Créez votre compte gratuit',
      'how.step1.desc': '30 secondes, sans carte bancaire. Explorez la Fear & Greed, Short Interest, et les analyses publiques de 1000+ tickers.',
      'how.step2.title': 'Passez Premium (29€/mois)',
      'how.step2.desc': 'Débloquez le Kairos Score complet, tous les hedge funds, le consensus, les signaux insiders et l\'import de portefeuille.',
      'how.step3.title': 'Surveillez le smart money',
      'how.step3.desc': 'Chaque matin à 7h, retrouvez les mouvements majeurs, les Hot Stocks et les nouveaux signaux sur vos actions suivies.',

      // ==== DATA SOURCES ====
      'data.badge': 'Sources de données',
      'data.title_part1': 'Des données publiques.',
      'data.title_part2': 'Un traitement d\'expert.',
      'data.subtitle': 'Kairos Insider agrège, traduit et analyse les déclarations officielles des régulateurs financiers — 100% légal, 100% transparent.',
      'data.sec_4': 'Transactions d\'insiders US',
      'data.sec_13f': 'Portefeuilles hedge funds',
      'data.amf': 'Déclarations dirigeants',
      'data.bafin': 'Directors\' dealings (Europe)',
      'data.trends': 'Intérêt retail (proxy)',
      'data.subversive': 'NANC / GOP politique US',
      'data.zacks': 'Holdings ETF temps réel',
      'data.yahoo': 'Prix, fondamentaux, consensus',

      // ==== PRICING ====
      'pricing.badge': 'Tarifs',
      'pricing.title': 'Simple et transparent.',
      'pricing.subtitle': 'Essayez gratuitement. Passez Premium quand vous êtes prêt. Annulez quand vous voulez.',
      'pricing.toggle_monthly': 'Mensuel',
      'pricing.toggle_annual': 'Annuel',
      'pricing.discount': '−17%',
      'pricing.free.name': 'Gratuit',
      'pricing.free.desc': 'Pour découvrir le smart money',
      'pricing.free.subline': 'Aucune carte bancaire requise',
      'pricing.free.cta': 'Commencer gratuitement',
      'pricing.free.f1': 'Analyse publique de 1000+ tickers (vue tronquée)',
      'pricing.free.f2': 'Indicateur Fear & Greed',
      'pricing.free.f3': 'Short Interest top tickers',
      'pricing.free.f4': 'Hot Stocks Google Trends',
      'pricing.free.f5': 'Kairos Score complet',
      'pricing.free.f6': 'Hedge Funds & Consensus',
      'pricing.free.f7': 'Import portefeuille',
      'pricing.premium.badge': '★ Premium',
      'pricing.premium.name': 'Premium',
      'pricing.premium.desc': 'L\'accès complet au smart money',
      'pricing.premium.amount_monthly': '29€',
      'pricing.premium.amount_annual': '290€',
      'pricing.premium.period_monthly': '/mois',
      'pricing.premium.period_annual': '/an',
      'pricing.premium.subline_monthly': 'Sans engagement, annulable à tout moment',
      'pricing.premium.subline_annual': 'Soit 24,17€/mois · Économisez 58€/an (17%)',
      'pricing.premium.cta_monthly': 'S\'abonner — 29€/mois',
      'pricing.premium.cta_annual': 'S\'abonner — 290€/an',
      'pricing.premium.all_free': 'Tout le plan Gratuit',
      'pricing.premium.f_score': 'Kairos Score composite 0-100 (radar 8 axes + synthèse)',
      'pricing.premium.f_insiders': 'Transactions insiders SEC + AMF + BaFin en détail',
      'pricing.premium.f_clusters': 'Signaux Insiders (clusters 90j)',
      'pricing.premium.f_activists': '<strong>Fonds Offensifs</strong> (Elliott, Ackman, Icahn…)',
      'pricing.premium.f_funds': '200+ hedge funds 13F consolidés',
      'pricing.premium.f_consensus': 'Consensus Hedge Funds avec ★ conviction',
      'pricing.premium.f_etf': '11 ETF Live (politique, ARK, sentiment, income, thématiques)',
      'pricing.premium.f_history': 'Historique 2 ans (AUM, rotations, scores)',
      'pricing.premium.f_watchlist': '<strong>Watchlist &amp; alertes email</strong> quotidiennes',
      'pricing.premium.f_portfolio': 'Import portefeuille multi-broker (CSV)',

      // ==== POPULAR STOCKS ====
      'popular.badge': 'Analyses populaires',
      'popular.title_part1': 'Les actions les plus suivies',
      'popular.title_part2': 'sur Kairos Insider',
      'popular.subtitle': 'Consulte l\'analyse smart money de n\'importe quelle action : Kairos Score, insiders, hedge funds, Google Trends, fondamentaux.',
      'popular.score_live': 'Score live',
      'popular.cta': 'Rechercher une autre action dans le dashboard →',

      // ==== FAQ ====
      'faq.badge': 'Questions fréquentes',
      'faq.title': 'Tout ce qu\'il faut savoir.',
      'faq.q_legal': 'Est-ce que c\'est légal ?',
      'faq.a_legal': 'Oui, 100% légal. Kairos Insider agrège uniquement des données <strong>publiques officielles</strong> publiées par les régulateurs financiers (SEC Form 4 & 13F aux États-Unis, AMF en France, BaFin en Allemagne). Ces déclarations sont une obligation légale : quand un dirigeant achète ou vend des actions de sa propre entreprise, ou qu\'un hedge fund dépasse un certain montant géré, il <strong>doit</strong> le déclarer publiquement. Nous ne faisons que les agréger, traduire et analyser.',
      'faq.q_score': 'Qu\'est-ce que le Kairos Score ?',
      'faq.a_score': 'C\'est notre score composite propriétaire qui note chaque action de 0 à 100 en agrégeant 8 dimensions du smart money : activité des initiés, détentions des hedge funds (13F), positions des politiciens & gourous (ETF NANC/GOP/GURU), momentum du cours, valorisation, consensus analystes, santé financière (Altman Z, Piotroski F), momentum des résultats. Au-delà de 75 : signal ACHAT FORT. En dessous de 25 : VENTE FORTE.',
      'faq.q_try': 'Puis-je essayer avant de payer ?',
      'faq.a_try': 'Oui. Créez un compte gratuit en 30 secondes — sans carte bancaire. Vous aurez accès à : l\'analyse publique de 1000+ tickers (vue tronquée), l\'indicateur Fear & Greed, le Short Interest, et les Hot Stocks Google Trends. Si vous aimez, vous pouvez passer Premium à 29€/mois pour débloquer le Kairos Score complet, les hedge funds et le consensus.',
      'faq.q_freq': 'À quelle fréquence les données sont-elles mises à jour ?',
      'faq.a_freq': 'Les données sont <strong>rafraîchies en continu</strong> : nos pipelines surveillent en permanence les sources officielles (SEC, AMF, BaFin) et remontent les nouvelles déclarations <em>avant l\'ouverture des marchés</em>. Prix, hedge funds, trends retail, indicateurs sectoriels — tout est à jour quand vous vous connectez le matin.',
      'faq.q_cancel': 'Puis-je annuler à tout moment ?',
      'faq.a_cancel': 'Oui, aucun engagement. Votre abonnement Premium est résiliable en 1 clic dans votre espace personnel. Vous gardez l\'accès jusqu\'à la fin du cycle de facturation payé. Le paiement est géré par Stripe (sécurisé, conforme PCI-DSS).',
      'faq.q_markets': 'Sur quels marchés Kairos Insider fonctionne-t-il ?',
      'faq.a_markets': 'Nous couvrons actuellement : 🇺🇸 États-Unis (NYSE, NASDAQ — via SEC), 🇫🇷 France (Euronext Paris — via AMF), 🇩🇪 Allemagne & zone euro (Xetra, Euronext — via BaFin). Cela représente 1000+ actions analysables. D\'autres marchés seront ajoutés progressivement (UK FCA, Suisse SIX).',
      'faq.q_funds': 'Comment sont sélectionnés les 200+ hedge funds suivis ?',
      'faq.a_funds': 'Nous suivons les <strong>200 plus grands hedge funds et asset managers par AUM</strong>, découverts <strong>automatiquement chaque semaine</strong> via SEC EDGAR (script qui scanne tous les filings 13F-HR récents et trie par taille). Inclut les légendes (Buffett, Burry, Klarman, Ackman, Einhorn…), multi-strategy mega (Citadel, Point72, Millennium), quants (Renaissance, Two Sigma, D.E. Shaw, AQR), Tiger Cubs (Tiger Global, Coatue, Viking, Lone Pine), activistes (Elliott, Trian, Icahn, Starboard), macro (Bridgewater, Tudor, Druckenmiller) et mega managers (Vanguard $5.9T, BlackRock $4.4T, State Street, Fidelity, Morgan Stanley…).',
      'faq.q_etf': 'Quels ETF thématiques sont suivis ?',
      'faq.a_etf': '11 ETF répartis en 6 catégories :<br>• <strong>Politique US</strong> : NANC (démocrates) · GOP (républicains)<br>• <strong>Hedge funds consensus</strong> : GURU<br>• <strong>Innovation ARK</strong> : ARKK · ARKW · ARKG · ARKF · ARKQ<br>• <strong>Sentiment retail</strong> : BUZZ (social) · MEME (Reddit/Twitter)<br>• <strong>Income covered call</strong> : JEPI · JEPQ<br>• <strong>Thématiques</strong> : ITA (defense) · URA (uranium) · UFO (espace) · MJ (cannabis)<br>Chaque ETF est rafraîchi quotidiennement.',
      'faq.q_advice': 'Est-ce qu\'il y a un conseil en investissement ?',
      'faq.a_advice': '<strong>Non.</strong> Kairos Insider est un <strong>outil d\'information</strong>, pas un conseiller en investissement. Nous ne sommes ni PSI, ni CIF. Les analyses présentées sont à visée informative et éducative uniquement. Toute décision d\'investissement reste votre responsabilité. Consultez un professionnel agréé pour tout conseil personnalisé.',

      // ==== CTA FINAL ====
      'cta.title_part1': 'Prêt à voir',
      'cta.title_part2': 'ce que les pros voient',
      'cta.subtitle': 'Créez votre compte gratuit en 30 secondes. Aucune carte bancaire requise. Passez Premium quand vous êtes prêt.',
      'cta.see_pricing': 'Voir les tarifs',
      'cta.newsletter_label': 'Ou recevez notre newsletter hebdomadaire sur le smart money :',
      'cta.newsletter_placeholder': 'votre@email.fr',
      'cta.newsletter_submit': 'S\'abonner',
      'cta.newsletter_ok': '✓ Parfait ! Vous êtes inscrit à la newsletter.',
      'cta.newsletter_invalid': '⚠️ Adresse email invalide.',
      'cta.newsletter_error': '⚠️ Une erreur est survenue. Réessayez.',

      // ==== FOOTER ====
      'footer.copyright': '© 2026 — Voyez ce que les pros voient.',
      'footer.legal': 'Mentions légales',
      'footer.cgv': 'CGV',
      'footer.privacy': 'Confidentialité',
      'footer.contact': 'Contact',
      'footer.faq': 'FAQ',

      // ==== SIGNALS / SCORES (utilises dans dashboard + SSR) ====
      'signal.strong_buy': 'ACHAT FORT',
      'signal.buy': 'ACHAT',
      'signal.neutral': 'NEUTRE',
      'signal.sell': 'VENTE',
      'signal.strong_sell': 'VENTE FORTE',

      // ==== DASHBOARD SIDEBAR ====
      'dash.sidebar.dashboard': 'Tableau de bord',
      'dash.sidebar.home': 'Accueil',
      'dash.sidebar.analyse': 'Analyse',
      'dash.sidebar.stock_analysis': 'Analyse action',
      'dash.sidebar.hot_stocks': 'Hot Stocks',
      'dash.sidebar.smart_money': 'Smart Money',
      'dash.sidebar.insiders': 'Transactions Insiders',
      'dash.sidebar.signals': 'Signaux Insiders',
      'dash.sidebar.hedge_funds': 'Hedge Funds',
      'dash.sidebar.consensus': 'Consensus Hedge Funds',
      'dash.sidebar.etf_live': 'ETF Live',
      'dash.sidebar.my_trading': 'Mon Trading',
      'dash.sidebar.portfolio': 'Mon Portefeuille',
      'dash.sidebar.indicators': 'Indicateurs',
      'dash.sidebar.fear_greed': 'Fear & Greed',
      'dash.sidebar.shorts': 'Short Interest',
      'dash.sidebar.watchlist': 'Ma Watchlist',
      'dash.sidebar.screener': 'Screener Avance',
      'dash.sidebar.top_insiders': 'Top Insiders',
      'dash.sidebar.activists': 'Fonds Offensifs',
      'dash.sidebar.admin': 'Tableau de bord',

      // ==== Home cards ====
      'dash.home.consensus_title': 'Consensus Hedge Funds',
      'dash.home.consensus_desc': 'Les actions ou <strong>le plus de hedge funds convergent</strong> (position >= 0,3% du portefeuille). Les etoiles conviction = pari actif, pas de l\'indexation passive BlackRock/Vanguard.',
      'dash.home.consensus_cta': 'Voir le consensus →',
      'dash.home.screener_title': 'Screener Avance',
      'dash.home.screener_desc': 'Filtres combinables sur l\'historique complet des transactions insider : ticker, période (jusqu\'a 5 ans), role (CEO/CFO), montant min, source. <strong>Export CSV</strong> des resultats.',
      'dash.home.screener_cta': 'Lancer une recherche →',
      'dash.home.top_insiders_title': 'Top Insiders',
      'dash.home.top_insiders_desc': 'Classement des insiders les plus actifs sur la période. <strong>Medailles 🥇🥈🥉</strong> sur le top 3 par volume d\'achats ou ventes. Click pour voir leurs transactions detaillees.',
      'dash.home.top_insiders_cta': 'Voir le classement →',

      // ==== Home hero + stats ====
      'dash.home.hello': 'Bonjour',
      'dash.home.welcome': 'Bienvenue sur <strong>Kairos Insider</strong>, votre cockpit Smart Money. Suivez en temps réel ce que font les <strong>initiés</strong>, les <strong>hedge funds</strong> et les <strong>politiciens</strong> — les investisseurs qui ont une longueur d\'avance sur le marché.',
      'dash.home.cta_analyze': '🔎 Analyser une action',
      'dash.home.cta_signals': '🎯 Voir les signaux chauds',
      'dash.home.cta_watchlist': '⭐ Ma Watchlist',
      'dash.home.recent_activity': 'Activité récente',
      'dash.home.stat_tx_title': 'Transactions (90j)',
      'dash.home.stat_tx_detail': 'Initiés SEC + AMF + BaFin',
      'dash.home.stat_clusters_title': 'Clusters détectés',
      'dash.home.stat_clusters_detail': 'Signaux insiders coordonnés',
      'dash.home.stat_funds_title': 'Hedge funds suivis',
      'dash.home.stat_funds_detail': 'Portefeuilles hedge funds agrégés',
      'dash.home.stat_update_title': 'Dernière mise à jour',
      'dash.home.stat_update_detail': 'Données rafraîchies quotidiennement',
      'dash.home.explore_features': 'Explorez les fonctionnalités',

      // ==== Home cards (10 restantes) ====
      'dash.home.stockAnalysis_title': 'Analyse action',
      'dash.home.stockAnalysis_desc': 'Deep-dive complet sur n\'importe quel ticker : <strong>Kairos Score</strong> composite de 0 à 100, initiés, hedge funds, fondamentaux, santé financière, peers, earnings.',
      'dash.home.stockAnalysis_cta': 'Rechercher une action →',
      'dash.home.watchlist_title': 'Ma Watchlist',
      'dash.home.watchlist_desc': 'Suivez vos actions préférées et recevez un <strong>digest email quotidien</strong> à 8h avec les événements smart-money détectés : clusters insiders, rotations ETF, variation Kairos Score.',
      'dash.home.watchlist_cta': 'Configurer mes alertes →',
      'dash.home.hotStocks_title': 'Hot Stocks',
      'dash.home.hotStocks_desc': 'Les actions <strong>les plus cherchées sur Google</strong> avec score de momentum. Détectez les small caps qui commencent à attirer l\'attention retail avant le reste du marché.',
      'dash.home.hotStocks_cta': 'Explorer les tendances →',
      'dash.home.insider_title': 'Transactions Insiders',
      'dash.home.insider_desc': 'Tous les achats et ventes des dirigeants — déclarations officielles <strong>SEC</strong> (US), <strong>AMF</strong> (France), <strong>BaFin</strong> (Allemagne), mises à jour quotidiennement.',
      'dash.home.insider_cta': 'Parcourir les transactions →',
      'dash.home.clustering_title': 'Signaux Insiders (Clusters)',
      'dash.home.clustering_desc': 'Quand <strong>3+ dirigeants</strong> achètent sur la même entreprise dans un court laps de temps. Historiquement le signal le plus fiable — les insiders savent quelque chose.',
      'dash.home.clustering_cta': 'Voir les clusters actifs →',
      'dash.home.13f_title': 'Portefeuilles Hedge Funds',
      'dash.home.13f_desc': 'Les positions des plus grands hedge funds : <strong>Berkshire</strong> (Buffett), <strong>Pershing Square</strong> (Ackman), <strong>Tiger Global</strong>, <strong>Bridgewater</strong> et 100+ autres.',
      'dash.home.13f_cta': 'Explorer les fonds →',
      'dash.home.etf_title': 'ETF Politiciens & Gourous',
      'dash.home.etf_desc': '<strong>NANC</strong> (démocrates US), <strong>GOP</strong> (républicains US), <strong>GURU</strong> (top hedge funds) — des ETF qui répliquent les portefeuilles de ceux qui savent.',
      'dash.home.etf_cta': 'Voir les holdings →',
      'dash.home.portfolio_title': 'Mon Portefeuille',
      'dash.home.portfolio_desc': 'Importez vos trades depuis <strong>n\'importe quelle plateforme</strong> (IG, Trade Republic, Degiro, eToro…) via CSV. Suivez votre performance avec des KPIs pros.',
      'dash.home.portfolio_cta': 'Importer mes trades →',
      'dash.home.feargreed_title': 'Fear & Greed',
      'dash.home.feargreed_desc': 'L\'indice de sentiment du marché de <strong>CNN</strong> — mesurez si le marché est dans la panique ou l\'euphorie. Warren Buffett : « soyez avide quand les autres ont peur ».',
      'dash.home.feargreed_cta': 'Voir l\'indice →',
      'dash.home.shorts_title': 'Short Interest',
      'dash.home.shorts_desc': 'Les actions les plus <strong>shortées</strong> du marché — potentiels short squeezes, signaux baissiers des pros… ou pièges à éviter.',
      'dash.home.shorts_cta': 'Voir le classement →',

      // ==== Section headers (h2 + desc) ====
      'dash.section.stockAnalysis.title': 'Analyse action',
      'dash.section.stockAnalysis.desc': 'Cherche un ticker et obtiens une analyse complete : insiders, hedge funds, ETF politiciens/gurus, prix, fondamentaux, news — le tout synthetise en un <strong>Kairos Score</strong> de 0 a 100.',
      'dash.section.hotStocks.title': '🔥 Hot Stocks — Tendances recherche Google',
      'dash.section.hotStocks.desc': 'Les actions dont l\'intérêt retail explose en ce moment. Base sur les données Google Trends — l\'attention retail precede souvent les mouvements de prix, surtout sur les small caps. Mis a jour quotidiennement.',
      'dash.section.insider.title': 'Transactions Insiders',
      'dash.section.insider.desc': 'Achats et ventes des dirigeants — declarations officielles SEC (US), AMF (France) et BaFin (Europe), mises a jour quotidiennement.',
      'dash.section.screener.title': 'Screener Avance',
      'dash.section.screener.desc': 'Filtres combinables sur l\'historique complet des transactions insiders (jusqu\'a 5 ans). Filtre par role, montant, période, ticker, source — exporte les resultats en CSV.',
      'dash.section.topInsiders.title': '🏆 Top Insiders',
      'dash.section.topInsiders.desc': 'Classement des insiders les plus actifs sur la période. Repere les executives dont les trades sont les plus massifs et les plus frequents — une premiere approximation du "qui vaut la peine d\'etre suivi".',
      'dash.section.clustering.title': 'Signaux Insiders',
      'dash.section.clustering.desc': 'Actions sur lesquelles plusieurs dirigeants ont effectue des transactions simultanement — un signal fort quand les insiders agissent ensemble.',
      'dash.section.13f.desc': 'Classement des plus grands fonds d\'investissement par taille de portefeuille (AUM). Cliquez sur une ligne pour voir les principales positions.',
      'dash.section.consensus13f.title': '🤝 Smart Money Consensus',
      'dash.section.consensus13f.desc': 'Quelles actions sont detenues par <strong>plusieurs hedge funds simultanement</strong> ? Plus une position est partagee, plus elle est consensus du smart money. A l\'inverse, les actions tenues par un seul fonds sont des "lonely picks" — paris originaux ou contrarian.',
      'dash.section.etf.desc': 'Positions en temps réel des ETF qui repliquent les strategies des grands investisseurs, politiciens, sentiment retail et thématiques.',
      'dash.section.feargreed.title': 'Fear & Greed Index',
      'dash.section.feargreed.desc': 'Indicateur de sentiment du marche — les investisseurs sont-ils euphoriques ou paniques ?',
      'dash.section.shorts.title': 'Short Interest',
      'dash.section.shorts.desc': 'Actions les plus shortees du marche US — détectez les potentiels short squeezes.',
      'dash.section.portfolio.title': 'Mon Portefeuille',
      'dash.section.portfolio.desc': 'Importez vos trades depuis votre plateforme de trading pour suivre votre performance. <strong style="color:#FDE047">Module en beta</strong> — la synchronisation automatique avec votre broker arrive bientot.',
      'dash.section.watchlist.title': 'Ma Watchlist',
      'dash.section.watchlist.desc': 'Suivez vos actions preferees et recevez chaque matin a 8h un digest email des événements smart-money détectes : nouveaux clusters insiders, entrees/sorties d\'ETF, variations du Kairos Score.',

      // ==== TX TYPES (legacy compat avec dashboard.html) ====
      'tx.buy': 'Achat',
      'tx.sell': 'Vente',
      'tx.other': 'Autre',
      'tx.A': 'Attribution',
      'tx.D': 'Cession',
      'tx.P': 'Achat',
      'tx.S': 'Vente',
      'tx.M': 'Exercice',
      'tx.F': 'Retenue fiscale',
      'tx.X': 'Exercice',
      'tx.G': 'Don',
      'tx.C': 'Conversion',

      // ==== HF STATUS (legacy compat avec dashboard.html) ====
      'hf.new': 'Nouvelle position',
      'hf.sold': 'Sortie complète',
      'hf.closed': 'Position fermée',
      'hf.increased': 'Renforcée',
      'hf.decreased': 'Réduite',
      'hf.unchanged': 'Inchangée',

      'unknown': '—',
    },

    // ==========================================================
    // ENGLISH
    // ==========================================================
    en: {
      'nav.features': 'Features',
      'nav.pricing': 'Pricing',
      'nav.data': 'Data',
      'nav.dashboard': 'Dashboard',
      'nav.home': 'Home',
      'nav.login': 'Sign in',
      'nav.logout': 'Sign out',
      'nav.try_free': 'Try for free',
      'nav.lang_switch': 'FR',
      'nav.lang_switch_title': 'Passer en français',

      'hero.badge': 'Live platform · Data from SEC / AMF / BaFin',
      'hero.title_part1': 'See what',
      'hero.title_part2': 'the pros see.',
      'hero.subtitle_html': 'Track every day the moves of the <strong>200+ largest hedge funds</strong>, <strong>company executives</strong>, <strong>US politicians</strong> and <strong>thematic ETFs</strong>. A composite Kairos Score 0-100 synthesizes 8 smart-money dimensions for every stock.',
      'hero.cta_try': 'Try for free →',
      'hero.cta_example': 'See an analysis example',
      'hero.meta_legal': '100% legal',
      'hero.meta_update': 'Daily refresh at 7am Paris',
      'hero.meta_french': 'French & English',
      'hero.meta_english': '🇫🇷 / 🇬🇧',

      'stats.funds_tracked': 'Hedge funds tracked',
      'stats.stocks_analyzed': 'Stocks analyzed',
      'stats.kairos_score': 'Kairos Score',
      'stats.daily_update': 'Daily refresh (Paris)',

      'profiles.badge': 'For who?',
      'profiles.title_part1': 'Built for every investor',
      'profiles.title_part2': 'who wants',
      'profiles.title_part3': 'a real edge',
      'profiles.subtitle': 'Whether you invest long-term or trade daily, Kairos Insider gives you the information institutions have been using forever.',
      'profiles.long_term.title': 'Long-term investor',
      'profiles.long_term.desc': 'Build a portfolio aligned with the convictions of the largest fund managers. See who buys, who sells, on what time horizon.',
      'profiles.swing.title': 'Swing trader',
      'profiles.swing.desc': 'Spot sector rotations, insider clusters and retail interest spikes on small caps.',
      'profiles.active.title': 'Active trader',
      'profiles.active.desc': 'Analyze any ticker in 30 seconds: Kairos Score, insiders, 13F, Google Trends, fundamentals, financial health. All in one.',
      'profiles.diy.title': 'DIY investor',
      'profiles.diy.desc': 'Import your portfolio (any broker), track your performance, and never miss a major signal on your positions again.',

      'features.badge': 'Features',
      'features.title_part1': 'All the smart money',
      'features.title_part2': 'in a single interface.',
      'features.subtitle': 'A full suite of connected modules, continuously refreshed before markets open.',

      'feat.score.title': 'Kairos Score 0-100',
      'feat.score.desc': 'A single score that synthesizes <strong>the entire smart money signal</strong>: insiders, hedge funds, politicians, momentum, valuation, financial health, analyst consensus, earnings. One number to decide — no need to be an analyst to understand.',
      'feat.score.chip': '● Coverage US + Europe',

      'feat.consensus.title': 'Hedge Funds Consensus',
      'feat.consensus.desc_html': 'Explore the portfolios of <strong>all the big stars</strong>: Buffett, Burry, Ackman, Tiger Global, Coatue, Bridgewater… See which stocks are shared as <strong>★ conviction</strong> and which are contrarian lone bets. Who follows who, who bets alone.',
      'feat.consensus.chip': '● Quarterly activity',

      'feat.insiders.title': 'Insider Transactions',
      'feat.insiders.desc': 'Every buy or sell by <strong>company executives</strong>, published by official US, French and German regulators. Translated and contextualized. Automatic detection of <strong>insider clusters</strong> — the most reliable signal when several insiders buy together.',
      'feat.insiders.chip': '● Daily refresh',

      'feat.trends.title': 'Hot Stocks — Google Trends',
      'feat.trends.desc': 'Spot the stocks whose <strong>retail interest explodes</strong> before the rest of the market. Search spikes often precede price moves — perfect for hunting small caps that are starting to buzz.',
      'feat.trends.chip': 'NEW · Retail signal',

      'feat.etf.title': 'ETF Live',
      'feat.etf.desc_html': 'The <strong>live</strong> portfolios of every smart money ETF that matters. <strong>US Politics</strong> (Pelosi vs Republicans), <strong>hedge funds consensus</strong>, <strong>disruptive innovation</strong>, <strong>retail sentiment</strong>, <strong>thematic sectors</strong>. Visual heatmap + rotation detection.',
      'feat.etf.chip': 'NEW · Live rotations',

      'feat.history.title': 'Deep history',
      'feat.history.desc_html': 'Travel back in time. See how <strong>positions evolve</strong> quarter after quarter: which funds enter or exit, which convictions strengthen, which Kairos Scores rise or fall. A <strong>deep database</strong> to backtest your intuitions.',
      'feat.history.chip': 'NEW · Long-term history',

      'feat.deep.title': 'Full stock analysis',
      'feat.deep.desc': 'A comprehensive profile for every stock: visual <strong>Kairos Score</strong>, valuation ratios, financial health, earnings history, sector peers, analyst targets, chart with insider trades overlaid. Everything you need <strong>without switching tabs</strong>.',
      'feat.deep.chip': '● Thousands of tickers',

      'feat.activists.title': 'Activist Investors',
      'feat.activists.desc_html': 'When an <strong>activist fund</strong> like Elliott, Ackman, or Icahn buys more than <strong>5% of a company</strong>, it\'s to <strong>force change</strong> (divestiture, CEO replacement, stock buybacks). Carl Icahn at Apple 2013 → +30%. Kairos detects these filings within <strong>10 days</strong> — 35 days faster than 13F.',
      'feat.activists.chip': 'NEW · 10-day signal',

      'feat.watchlist.title': 'Watchlist &amp; Email Alerts',
      'feat.watchlist.desc_html': 'Build your <strong>custom watchlist</strong> and receive a <strong>daily morning digest</strong> with all smart money events détected on YOUR stocks: new insider clusters, ETF entries/exits, Kairos Score changes, hedge fund consensus shifts. Never miss a signal.',
      'feat.watchlist.chip': 'NEW · Morning alert 8am',

      'feat.portfolio.title': 'My Portfolio',
      'feat.portfolio.desc_html': 'Import your trade history from <strong>any broker</strong>. Track performance, win rate, drawdown — and compare your trades to the smart money signals you could have caught. <em>Auto-sync coming soon.</em>',
      'feat.portfolio.chip': 'BETA · Multi-broker CSV',

      'comp.badge': 'Comparison',
      'comp.title_part1': 'Why',
      'comp.title_part2': '?',
      'comp.subtitle': 'The only platform that combines smart money + fundamentals + retail + multilingual analysis in a unified interface.',
      'comp.col_feature': 'Feature',
      'comp.row_french': 'French interface',
      'comp.row_score': 'Composite score 0-100 (8 dimensions)',
      'comp.row_eu_insiders': 'European insiders (AMF + BaFin)',
      'comp.row_hedge_funds': 'Hedge Funds 13F (200+ funds)',
      'comp.row_conviction': 'Conviction consensus (★)',
      'comp.row_etf': 'Thematic ETFs (politics, retail, ARK…)',
      'comp.row_trends': 'Built-in Google Trends',
      'comp.row_history': 'Evolution history (2 years)',
      'comp.row_portfolio': 'Multi-broker portfolio import',
      'comp.row_price': 'Price',
      'comp.partial': 'Partial',
      'comp.basic': 'Basic',
      'comp.limited': 'Limited',
      'comp.manual': 'Manual',
      'comp.charts_only': 'Charts only',

      'how.badge': 'How it works',
      'how.title': 'Three steps. One edge.',
      'how.subtitle': 'Get in minutes the information institutions have been using forever.',
      'how.step1.title': 'Create your free account',
      'how.step1.desc': '30 seconds, no credit card. Explore Fear & Greed, Short Interest, and public analyses of 1000+ tickers.',
      'how.step2.title': 'Go Premium (€29/month)',
      'how.step2.desc': 'Unlock the full Kairos Score, all hedge funds, the consensus, insider signals and portfolio import.',
      'how.step3.title': 'Watch the smart money',
      'how.step3.desc': 'Every morning at 7am Paris time, get the major moves, Hot Stocks and new signals on your watched stocks.',

      'data.badge': 'Data sources',
      'data.title_part1': 'Public data.',
      'data.title_part2': 'Expert processing.',
      'data.subtitle': 'Kairos Insider aggregates, translates and analyzes the official filings of financial regulators — 100% legal, 100% transparent.',
      'data.sec_4': 'US insider transactions',
      'data.sec_13f': 'Hedge fund portfolios',
      'data.amf': 'Director declarations',
      'data.bafin': 'Directors\' dealings (Europe)',
      'data.trends': 'Retail interest (proxy)',
      'data.subversive': 'NANC / GOP US politics',
      'data.zacks': 'Real-time ETF holdings',
      'data.yahoo': 'Prices, fundamentals, consensus',

      'pricing.badge': 'Pricing',
      'pricing.title': 'Simple and transparent.',
      'pricing.subtitle': 'Try for free. Go Premium when you\'re ready. Cancel anytime.',
      'pricing.toggle_monthly': 'Monthly',
      'pricing.toggle_annual': 'Annual',
      'pricing.discount': '−17%',
      'pricing.free.name': 'Free',
      'pricing.free.desc': 'To discover smart money',
      'pricing.free.subline': 'No credit card required',
      'pricing.free.cta': 'Start for free',
      'pricing.free.f1': 'Public analysis of 1000+ tickers (truncated view)',
      'pricing.free.f2': 'Fear & Greed indicator',
      'pricing.free.f3': 'Short Interest top tickers',
      'pricing.free.f4': 'Hot Stocks Google Trends',
      'pricing.free.f5': 'Full Kairos Score',
      'pricing.free.f6': 'Hedge Funds & Consensus',
      'pricing.free.f7': 'Portfolio import',
      'pricing.premium.badge': '★ Premium',
      'pricing.premium.name': 'Premium',
      'pricing.premium.desc': 'Full smart money access',
      'pricing.premium.amount_monthly': '€29',
      'pricing.premium.amount_annual': '€290',
      'pricing.premium.period_monthly': '/month',
      'pricing.premium.period_annual': '/year',
      'pricing.premium.subline_monthly': 'No commitment, cancel anytime',
      'pricing.premium.subline_annual': 'Equivalent to €24.17/month · Save €58/year (17%)',
      'pricing.premium.cta_monthly': 'Subscribe — €29/month',
      'pricing.premium.cta_annual': 'Subscribe — €290/year',
      'pricing.premium.all_free': 'Everything in Free plan',
      'pricing.premium.f_score': 'Composite Kairos Score 0-100 (8-axis radar + synthesis)',
      'pricing.premium.f_insiders': 'SEC + AMF + BaFin insider transactions in detail',
      'pricing.premium.f_clusters': 'Insider Signals (90-day clusters)',
      'pricing.premium.f_activists': '<strong>Activist Investors</strong> (Elliott, Ackman, Icahn…)',
      'pricing.premium.f_funds': '200+ hedge funds 13F consolidated',
      'pricing.premium.f_consensus': 'Hedge Funds Consensus with ★ conviction',
      'pricing.premium.f_etf': '11 ETF Live (politics, ARK, sentiment, income, themes)',
      'pricing.premium.f_history': '2-year history (AUM, rotations, scores)',
      'pricing.premium.f_watchlist': '<strong>Watchlist &amp; daily email alerts</strong>',
      'pricing.premium.f_portfolio': 'Multi-broker portfolio import (CSV)',

      'popular.badge': 'Popular analyses',
      'popular.title_part1': 'The most followed stocks',
      'popular.title_part2': 'on Kairos Insider',
      'popular.subtitle': 'Browse the smart money analysis of any stock: Kairos Score, insiders, hedge funds, Google Trends, fundamentals.',
      'popular.score_live': 'Live score',
      'popular.cta': 'Search another stock in the dashboard →',

      'faq.badge': 'Frequently asked questions',
      'faq.title': 'Everything you need to know.',
      'faq.q_legal': 'Is this legal?',
      'faq.a_legal': 'Yes, 100% legal. Kairos Insider only aggregates <strong>official public data</strong> published by financial regulators (SEC Form 4 & 13F in the USA, AMF in France, BaFin in Germany). These filings are a legal obligation: when an executive buys or sells shares of their own company, or when a hedge fund exceeds a certain AUM threshold, they <strong>must</strong> declare it publicly. We just aggregate, translate and analyze.',
      'faq.q_score': 'What is the Kairos Score?',
      'faq.a_score': 'It\'s our proprietary composite score that rates each stock from 0 to 100 by aggregating 8 smart money dimensions: insider activity, hedge funds holdings (13F), politicians & gurus positions (NANC/GOP/GURU ETFs), price momentum, valuation, analyst consensus, financial health (Altman Z, Piotroski F), earnings momentum. Above 75: STRONG BUY signal. Below 25: STRONG SELL.',
      'faq.q_try': 'Can I try before paying?',
      'faq.a_try': 'Yes. Create a free account in 30 seconds — no credit card required. You\'ll get: public analysis of 1000+ tickers (truncated view), Fear & Greed indicator, Short Interest, and Hot Stocks Google Trends. If you like it, you can go Premium at €29/month to unlock the full Kairos Score, hedge funds and consensus.',
      'faq.q_freq': 'How often is data refreshed?',
      'faq.a_freq': 'Data is <strong>continuously refreshed</strong>: our pipelines constantly monitor official sources (SEC, AMF, BaFin) and pull new filings <em>before markets open</em>. Prices, hedge funds, retail trends, sector indicators — everything is up to date when you log in in the morning.',
      'faq.q_cancel': 'Can I cancel anytime?',
      'faq.a_cancel': 'Yes, no commitment. Your Premium subscription is cancellable in 1 click from your personal area. You keep access until the end of the paid billing cycle. Payment is handled by Stripe (secure, PCI-DSS compliant).',
      'faq.q_markets': 'Which markets does Kairos Insider cover?',
      'faq.a_markets': 'We currently cover: 🇺🇸 USA (NYSE, NASDAQ — via SEC), 🇫🇷 France (Euronext Paris — via AMF), 🇩🇪 Germany & euro zone (Xetra, Euronext — via BaFin). That\'s 1000+ analyzable stocks. More markets to come progressively (UK FCA, Switzerland SIX).',
      'faq.q_funds': 'How are the 200+ tracked hedge funds selected?',
      'faq.a_funds': 'We follow the <strong>200 largest hedge funds and asset managers by AUM</strong>, automatically discovered <strong>weekly</strong> via SEC EDGAR (script that scans recent 13F-HR filings and sorts by size). Includes legends (Buffett, Burry, Klarman, Ackman, Einhorn…), multi-strategy mega (Citadel, Point72, Millennium), quants (Renaissance, Two Sigma, D.E. Shaw, AQR), Tiger Cubs (Tiger Global, Coatue, Viking, Lone Pine), activists (Elliott, Trian, Icahn, Starboard), macro (Bridgewater, Tudor, Druckenmiller) and mega managers (Vanguard $5.9T, BlackRock $4.4T, State Street, Fidelity, Morgan Stanley…).',
      'faq.q_etf': 'Which thematic ETFs are tracked?',
      'faq.a_etf': '11 ETFs in 6 catégories:<br>• <strong>US Politics</strong>: NANC (Democrats) · GOP (Republicans)<br>• <strong>Hedge funds consensus</strong>: GURU<br>• <strong>ARK Innovation</strong>: ARKK · ARKW · ARKG · ARKF · ARKQ<br>• <strong>Retail sentiment</strong>: BUZZ (social) · MEME (Reddit/Twitter)<br>• <strong>Income covered call</strong>: JEPI · JEPQ<br>• <strong>Themes</strong>: ITA (defense) · URA (uranium) · UFO (space) · MJ (cannabis)<br>Each ETF refreshed daily.',
      'faq.q_advice': 'Is this investment advice?',
      'faq.a_advice': '<strong>No.</strong> Kairos Insider is an <strong>information tool</strong>, not an investment advisor. We are not a regulated investment service. The analyses presented are for informational and educational purposes only. Any investment decision remains your responsibility. Consult a licensed professional for personalized advice.',

      'cta.title_part1': 'Ready to see',
      'cta.title_part2': 'what the pros see',
      'cta.subtitle': 'Create your free account in 30 seconds. No credit card required. Go Premium when you\'re ready.',
      'cta.see_pricing': 'See pricing',
      'cta.newsletter_label': 'Or get our weekly smart money newsletter:',
      'cta.newsletter_placeholder': 'your@email.com',
      'cta.newsletter_submit': 'Subscribe',
      'cta.newsletter_ok': '✓ Perfect! You\'re subscribed.',
      'cta.newsletter_invalid': '⚠️ Invalid email address.',
      'cta.newsletter_error': '⚠️ An error occurred. Please retry.',

      'footer.copyright': '© 2026 — See what the pros see.',
      'footer.legal': 'Legal notice',
      'footer.cgv': 'Terms',
      'footer.privacy': 'Privacy',
      'footer.contact': 'Contact',
      'footer.faq': 'FAQ',

      'signal.strong_buy': 'STRONG BUY',
      'signal.buy': 'BUY',
      'signal.neutral': 'NEUTRAL',
      'signal.sell': 'SELL',
      'signal.strong_sell': 'STRONG SELL',

      // ==== DASHBOARD SIDEBAR ====
      'dash.sidebar.dashboard': 'Dashboard',
      'dash.sidebar.home': 'Home',
      'dash.sidebar.analyse': 'Analysis',
      'dash.sidebar.stock_analysis': 'Stock analysis',
      'dash.sidebar.hot_stocks': 'Hot Stocks',
      'dash.sidebar.smart_money': 'Smart Money',
      'dash.sidebar.insiders': 'Insider Transactions',
      'dash.sidebar.signals': 'Insider Signals',
      'dash.sidebar.hedge_funds': 'Hedge Funds',
      'dash.sidebar.consensus': 'Hedge Funds Consensus',
      'dash.sidebar.etf_live': 'ETF Live',
      'dash.sidebar.my_trading': 'My Trading',
      'dash.sidebar.portfolio': 'My Portfolio',
      'dash.sidebar.indicators': 'Indicators',
      'dash.sidebar.fear_greed': 'Fear & Greed',
      'dash.sidebar.shorts': 'Short Interest',
      'dash.sidebar.watchlist': 'My Watchlist',
      'dash.sidebar.screener': 'Advanced Screener',
      'dash.sidebar.top_insiders': 'Top Insiders',
      'dash.sidebar.activists': 'Activist Investors',
      'dash.sidebar.admin': 'Dashboard',

      // ==== Home cards ====
      'dash.home.consensus_title': 'Hedge Funds Consensus',
      'dash.home.consensus_desc': 'Stocks where <strong>the most hedge funds converge</strong> (position >= 0.3% of portfolio). Conviction stars = active bets, not passive BlackRock/Vanguard indexing.',
      'dash.home.consensus_cta': 'See the consensus →',
      'dash.home.screener_title': 'Advanced Screener',
      'dash.home.screener_desc': 'Combinable filters on the full insider transactions history: ticker, period (up to 5 years), role (CEO/CFO), min amount, source. <strong>CSV export</strong> of results.',
      'dash.home.screener_cta': 'Run a search →',
      'dash.home.top_insiders_title': 'Top Insiders',
      'dash.home.top_insiders_desc': 'Ranking of most active insiders over the period. <strong>Medals 🥇🥈🥉</strong> on the top 3 by buy or sell volume. Click to see their detailed transactions.',
      'dash.home.top_insiders_cta': 'See the ranking →',

      // ==== Home hero + stats ====
      'dash.home.hello': 'Hello',
      'dash.home.welcome': 'Welcome to <strong>Kairos Insider</strong>, your Smart Money cockpit. Track in real-time what <strong>insiders</strong>, <strong>hedge funds</strong> and <strong>politicians</strong> are doing — investors with an edge over the market.',
      'dash.home.cta_analyze': '🔎 Analyze a stock',
      'dash.home.cta_signals': '🎯 See hot signals',
      'dash.home.cta_watchlist': '⭐ My Watchlist',
      'dash.home.recent_activity': 'Recent activity',
      'dash.home.stat_tx_title': 'Transactions (90d)',
      'dash.home.stat_tx_detail': 'Insiders SEC + AMF + BaFin',
      'dash.home.stat_clusters_title': 'Clusters détected',
      'dash.home.stat_clusters_detail': 'Coordinated insider signals',
      'dash.home.stat_funds_title': 'Hedge funds tracked',
      'dash.home.stat_funds_detail': 'Aggregated hedge fund portfolios',
      'dash.home.stat_update_title': 'Last update',
      'dash.home.stat_update_detail': 'Data refreshed daily',
      'dash.home.explore_features': 'Explore features',

      // ==== Home cards (10 others) ====
      'dash.home.stockAnalysis_title': 'Stock analysis',
      'dash.home.stockAnalysis_desc': 'Complete deep-dive on any ticker: <strong>Kairos Score</strong> composite from 0 to 100, insiders, hedge funds, fundamentals, financial health, peers, earnings.',
      'dash.home.stockAnalysis_cta': 'Search a stock →',
      'dash.home.watchlist_title': 'My Watchlist',
      'dash.home.watchlist_desc': 'Track your favorite stocks and receive a <strong>daily email digest</strong> at 8am with détected smart-money events: insider clusters, ETF rotations, Kairos Score changes.',
      'dash.home.watchlist_cta': 'Configure my alerts →',
      'dash.home.hotStocks_title': 'Hot Stocks',
      'dash.home.hotStocks_desc': 'Stocks <strong>most searched on Google</strong> with momentum score. Spot small caps starting to attract retail attention before the rest of the market.',
      'dash.home.hotStocks_cta': 'Explore trends →',
      'dash.home.insider_title': 'Insider Transactions',
      'dash.home.insider_desc': 'All buys and sells by executives — official <strong>SEC</strong> (US), <strong>AMF</strong> (France), <strong>BaFin</strong> (Germany) filings, updated daily.',
      'dash.home.insider_cta': 'Browse transactions →',
      'dash.home.clustering_title': 'Insider Signals (Clusters)',
      'dash.home.clustering_desc': 'When <strong>3+ executives</strong> buy the same company in a short time. Historically the most reliable signal — insiders know something.',
      'dash.home.clustering_cta': 'See active clusters →',
      'dash.home.13f_title': 'Hedge Fund Portfolios',
      'dash.home.13f_desc': 'Positions of the largest hedge funds: <strong>Berkshire</strong> (Buffett), <strong>Pershing Square</strong> (Ackman), <strong>Tiger Global</strong>, <strong>Bridgewater</strong> and 100+ others.',
      'dash.home.13f_cta': 'Explore funds →',
      'dash.home.etf_title': 'Politician & Guru ETFs',
      'dash.home.etf_desc': '<strong>NANC</strong> (US Democrats), <strong>GOP</strong> (US Republicans), <strong>GURU</strong> (top hedge funds) — ETFs that replicate the portfolios of those who know.',
      'dash.home.etf_cta': 'See holdings →',
      'dash.home.portfolio_title': 'My Portfolio',
      'dash.home.portfolio_desc': 'Import your trades from <strong>any platform</strong> (IG, Trade Republic, Degiro, eToro…) via CSV. Track your performance with pro KPIs.',
      'dash.home.portfolio_cta': 'Import my trades →',
      'dash.home.feargreed_title': 'Fear & Greed',
      'dash.home.feargreed_desc': 'The <strong>CNN</strong> market sentiment index — measure if the market is in panic or euphoria. Warren Buffett: "be greedy when others are fearful".',
      'dash.home.feargreed_cta': 'See the index →',
      'dash.home.shorts_title': 'Short Interest',
      'dash.home.shorts_desc': 'The most <strong>shorted</strong> stocks in the market — potential short squeezes, pro bearish signals… or traps to avoid.',
      'dash.home.shorts_cta': 'See the ranking →',

      // ==== Section headers (h2 + desc) ====
      'dash.section.stockAnalysis.title': 'Stock analysis',
      'dash.section.stockAnalysis.desc': 'Search for a ticker and get a full analysis: insiders, hedge funds, ETFs, politicians/gurus, price, fundamentals, news — all synthesized into a <strong>Kairos Score</strong> from 0 to 100.',
      'dash.section.hotStocks.title': '🔥 Hot Stocks — Google Search Trends',
      'dash.section.hotStocks.desc': 'Stocks whose retail interest is exploding right now. Based on Google Trends data — retail attention often precedes price movements, especially on small caps. Updated daily.',
      'dash.section.insider.title': 'Insider Transactions',
      'dash.section.insider.desc': 'Buys and sells by executives — official SEC (US), AMF (France) and BaFin (Europe) filings, updated daily.',
      'dash.section.screener.title': 'Advanced Screener',
      'dash.section.screener.desc': 'Combinable filters on the full history of insider transactions (up to 5 years). Filter by role, amount, period, ticker, source — export results as CSV.',
      'dash.section.topInsiders.title': '🏆 Top Insiders',
      'dash.section.topInsiders.desc': 'Ranking of the most active insiders over the period. Spot executives whose trades are the largest and most frequent — a first approximation of "who is worth following".',
      'dash.section.clustering.title': 'Insider Signals',
      'dash.section.clustering.desc': 'Stocks where multiple executives made transactions simultaneously — a strong signal when insiders act together.',
      'dash.section.13f.desc': 'Ranking of the largest investment funds by portfolio size (AUM). Click a row to see the main positions.',
      'dash.section.consensus13f.title': '🤝 Smart Money Consensus',
      'dash.section.consensus13f.desc': 'Which stocks are held by <strong>multiple hedge funds simultaneously</strong>? The more a position is shared, the more it is a smart money consensus. Conversely, stocks held by only one fund are "lonely picks" — original or contrarian bets.',
      'dash.section.etf.desc': 'Real-time positions of ETFs that replicate the strategies of big investors, politicians, retail sentiment and themes.',
      'dash.section.feargreed.title': 'Fear & Greed Index',
      'dash.section.feargreed.desc': 'Market sentiment indicator — are investors euphoric or panicked?',
      'dash.section.shorts.title': 'Short Interest',
      'dash.section.shorts.desc': 'Most shorted stocks in the US market — spot potential short squeezes.',
      'dash.section.portfolio.title': 'My Portfolio',
      'dash.section.portfolio.desc': 'Import your trades from your trading platform to track your performance. <strong style="color:#FDE047">Beta module</strong> — automatic broker sync coming soon.',
      'dash.section.watchlist.title': 'My Watchlist',
      'dash.section.watchlist.desc': 'Track your favorite stocks and receive a daily email digest at 8am with détected smart-money events: new insider clusters, ETF entries/exits, Kairos Score changes.',

      'tx.buy': 'Buy',
      'tx.sell': 'Sell',
      'tx.other': 'Other',
      'tx.A': 'Award',
      'tx.D': 'Disposal',
      'tx.P': 'Purchase',
      'tx.S': 'Sale',
      'tx.M': 'Exercise',
      'tx.F': 'Tax withheld',
      'tx.X': 'Exercise',
      'tx.G': 'Gift',
      'tx.C': 'Conversion',

      'hf.new': 'New position',
      'hf.sold': 'Fully sold',
      'hf.closed': 'Closed position',
      'hf.increased': 'Increased',
      'hf.decreased': 'Decreased',
      'hf.unchanged': 'Unchanged',

      'unknown': '—',
    },
  };

  // ============================================================
  // INITIALISATION DE LA LANGUE
  // ============================================================
  function detectLang() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored && SUPPORTED.indexOf(stored) >= 0) return stored;
    } catch (e) {}
    try {
      const params = new URLSearchParams(window.location.search);
      const fromUrl = params.get('lang');
      if (fromUrl && SUPPORTED.indexOf(fromUrl) >= 0) return fromUrl;
    } catch (e) {}
    try {
      const nav = (navigator.language || '').toLowerCase();
      if (nav.indexOf('fr') === 0) return 'fr';
      // Si pas FR, on prend EN par defaut (ouverture internationale)
      return 'en';
    } catch (e) {}
    return DEFAULT_LANG;
  }

  let CURRENT_LANG = detectLang();

  // ============================================================
  // API PUBLIQUE
  // ============================================================
  function getLang() { return CURRENT_LANG; }

  function t(key, fallback) {
    const dict = DICT[CURRENT_LANG] || DICT[DEFAULT_LANG];
    if (dict && dict[key] !== undefined) return dict[key];
    if (DICT[DEFAULT_LANG] && DICT[DEFAULT_LANG][key] !== undefined) return DICT[DEFAULT_LANG][key];
    return fallback !== undefined ? fallback : key;
  }

  function setLang(lang) {
    if (SUPPORTED.indexOf(lang) < 0) return;
    CURRENT_LANG = lang;
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) {}
    // Met a jour l'attribut <html lang="...">
    if (document.documentElement) document.documentElement.setAttribute('lang', lang);
    // Met a jour l'URL ?lang=X (sans recharger la page)
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('lang', lang);
      window.history.replaceState({}, '', url.toString());
    } catch (e) {}
    // Re-applique les traductions
    applyTranslations();
    // Notifie les ecouteurs (pour re-render des composants dynamiques)
    try {
      window.dispatchEvent(new CustomEvent('kairos:langchange', { detail: { lang: lang } }));
    } catch (e) {}
  }

  function applyTranslations(root) {
    const scope = root || document;
    // Texte simple
    const els = scope.querySelectorAll('[data-i18n]');
    els.forEach(function(el) {
      const key = el.getAttribute('data-i18n');
      if (!key) return;
      const value = t(key);
      // Si la cle se termine par _html, on injecte du HTML, sinon textContent
      if (key.indexOf('_html') > 0 || /[<>&]/.test(value)) {
        el.innerHTML = value;
      } else {
        el.textContent = value;
      }
    });
    // Attributs (placeholder, title, aria-label, content...)
    const ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'content'];
    ATTRS.forEach(function(attr) {
      const sel = '[data-i18n-' + attr + ']';
      scope.querySelectorAll(sel).forEach(function(el) {
        const key = el.getAttribute('data-i18n-' + attr);
        if (key) el.setAttribute(attr, t(key));
      });
    });
  }

  function init() {
    if (document.documentElement) document.documentElement.setAttribute('lang', CURRENT_LANG);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', applyTranslations);
    } else {
      applyTranslations();
    }
  }

  // ============================================================
  // SVG drapeaux cross-platform (Windows n'a pas de glyphes flag emoji)
  // ============================================================
  // 'gb' = Union Jack (a afficher quand l'utilisateur va passer en EN)
  // 'fr' = Drapeau France (a afficher quand l'utilisateur va passer en FR)
  function flagSvg(code) {
    const c = String(code || '').toLowerCase();
    if (c === 'fr') {
      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3 2" width="20" height="14" ' +
             'style="display:block;border-radius:2px;box-shadow:0 0 0 1px rgba(0,0,0,.18)">' +
             '<rect width="1" height="2" fill="#002654"/>' +
             '<rect x="1" width="1" height="2" fill="#FFFFFF"/>' +
             '<rect x="2" width="1" height="2" fill="#CE1126"/>' +
             '</svg>';
    }
    // Default = UK / Union Jack
    const id = 'kfg' + Math.random().toString(36).slice(2, 8);
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 30" width="20" height="14" ' +
           'style="display:block;border-radius:2px;box-shadow:0 0 0 1px rgba(0,0,0,.18)">' +
           '<clipPath id="' + id + '"><path d="M30,15 h30 v15 z v-15 h-30 z h-30 v-15 z v15 h30 z"/></clipPath>' +
           '<rect width="60" height="30" fill="#012169"/>' +
           '<path d="M0,0 L60,30 M60,0 L0,30" stroke="#FFFFFF" stroke-width="6"/>' +
           '<path d="M0,0 L60,30 M60,0 L0,30" clip-path="url(#' + id + ')" stroke="#C8102E" stroke-width="4"/>' +
           '<path d="M30,0 v30 M0,15 h60" stroke="#FFFFFF" stroke-width="10"/>' +
           '<path d="M30,0 v30 M0,15 h60" stroke="#C8102E" stroke-width="6"/>' +
           '</svg>';
  }

  // Retourne le drapeau a afficher dans le bouton (= drapeau de la langue cible)
  function targetFlagSvg() {
    return flagSvg(CURRENT_LANG === 'fr' ? 'gb' : 'fr');
  }

  // Bouton toggle FR/EN reutilisable (a placer dans la nav)
  function renderLangButton() {
    return '<button onclick="window.KairosI18n.setLang(window.KairosI18n.getLang() === \'fr\' ? \'en\' : \'fr\')" ' +
           'title="' + t('nav.lang_switch_title') + '" ' +
           'style="background:transparent;border:1px solid var(--border-strong, rgba(255,255,255,0.15));' +
           'color:var(--text-primary, #fff);padding:6px 12px;border-radius:8px;cursor:pointer;' +
           'font-family:inherit;font-size:13px;font-weight:600;letter-spacing:0.04em;' +
           'display:inline-flex;align-items:center;gap:6px">' +
           targetFlagSvg() +
           '<span data-i18n="nav.lang_switch">' + t('nav.lang_switch') + '</span>' +
           '</button>';
  }

  // Export
  global.KairosI18n = {
    t: t,
    getLang: getLang,
    setLang: setLang,
    applyTranslations: applyTranslations,
    renderLangButton: renderLangButton,
    flagSvg: flagSvg,
    targetFlagSvg: targetFlagSvg,
    DICT: DICT,
  };

  init();
})(typeof window !== 'undefined' ? window : this);
