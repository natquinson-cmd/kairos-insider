/* ============================================================
 * Kairos Insider — Bandeau de consentement cookies (RGPD/CNIL)
 * ============================================================
 * - Google Consent Mode v2 : par défaut tout DENIED
 * - Si user accepte : update gtag('consent', 'update', {...granted})
 * - Choix stocké dans localStorage avec version (re-prompt si politique change)
 * - Lien "Gérer mes cookies" dans le footer pour revenir sur son choix
 * ============================================================ */
(function () {
  'use strict';

  const STORAGE_KEY = 'kairos_cookie_consent_v1';
  const POLICY_VERSION = 1;

  // 1) Default consent = denied (avant que GA4 ne charge ses cookies)
  // gtag est déjà défini par le snippet GA4 dans le <head>
  function setDefaultConsentDenied() {
    if (typeof window.gtag !== 'function') return;
    window.gtag('consent', 'default', {
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'denied',
      functionality_storage: 'granted', // strictement nécessaire (langue, thème)
      security_storage: 'granted',      // sécurité (anti-CSRF)
      wait_for_update: 500,
    });
  }
  setDefaultConsentDenied();

  // 2) Charger / sauvegarder le choix
  function loadConsent() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (obj.version !== POLICY_VERSION) return null;
      return obj;
    } catch (e) { return null; }
  }
  function saveConsent(prefs) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: POLICY_VERSION,
        analytics: !!prefs.analytics,
        marketing: !!prefs.marketing,
        timestamp: new Date().toISOString(),
      }));
    } catch (e) {}
  }
  function applyConsent(prefs) {
    if (typeof window.gtag !== 'function') return;
    window.gtag('consent', 'update', {
      analytics_storage: prefs.analytics ? 'granted' : 'denied',
      ad_storage: prefs.marketing ? 'granted' : 'denied',
      ad_user_data: prefs.marketing ? 'granted' : 'denied',
      ad_personalization: prefs.marketing ? 'granted' : 'denied',
    });
  }

  // 3) Détection de la langue
  function getLang() {
    try {
      if (window.KairosI18n && typeof window.KairosI18n.getLang === 'function') {
        return window.KairosI18n.getLang();
      }
    } catch (e) {}
    return (document.documentElement.getAttribute('lang') || 'fr').slice(0, 2);
  }

  const TXT = {
    fr: {
      title: '🍪 Vos préférences cookies',
      body: 'Nous utilisons des cookies pour mesurer l\'audience du site (Google Analytics) et améliorer votre expérience. Les cookies strictement nécessaires (préférences d\'affichage, sécurité) sont toujours activés.',
      moreLink: 'En savoir plus',
      acceptAll: 'Tout accepter',
      refuseAll: 'Tout refuser',
      customize: 'Personnaliser',
      back: '← Retour',
      save: 'Enregistrer mes choix',
      cat_necessary: 'Strictement nécessaires',
      cat_necessary_desc: 'Préférences d\'affichage, langue, thème, authentification. Toujours actifs.',
      cat_analytics: 'Mesure d\'audience',
      cat_analytics_desc: 'Google Analytics 4 — pages visitées, durée de session, sources de trafic. IP anonymisée.',
      cat_marketing: 'Marketing',
      cat_marketing_desc: 'Personnalisation des contenus, retargeting publicitaire (aucun cookie marketing actuellement).',
      always_on: 'Toujours activé',
    },
    en: {
      title: '🍪 Your cookie preferences',
      body: 'We use cookies to measure site audience (Google Analytics) and improve your experience. Strictly necessary cookies (display preferences, security) are always enabled.',
      moreLink: 'Learn more',
      acceptAll: 'Accept all',
      refuseAll: 'Refuse all',
      customize: 'Customize',
      back: '← Back',
      save: 'Save my choices',
      cat_necessary: 'Strictly necessary',
      cat_necessary_desc: 'Display preferences, language, theme, authentication. Always active.',
      cat_analytics: 'Audience measurement',
      cat_analytics_desc: 'Google Analytics 4 — visited pages, session duration, traffic sources. IP anonymized.',
      cat_marketing: 'Marketing',
      cat_marketing_desc: 'Content personalization, retargeting (no marketing cookie currently).',
      always_on: 'Always on',
    },
  };

  function tr(key) {
    const lang = getLang() in TXT ? getLang() : 'fr';
    return TXT[lang][key] || TXT.fr[key] || key;
  }

  // 4) UI du bandeau
  let _bannerEl = null;
  function buildBanner() {
    const el = document.createElement('div');
    el.id = 'kairos-cookie-banner';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'false');
    el.setAttribute('aria-labelledby', 'kairos-cc-title');
    el.innerHTML = `
      <style>
        #kairos-cookie-banner {
          position: fixed; bottom: 16px; left: 16px; right: 16px;
          max-width: 640px; margin: 0 auto;
          background: #111827; color: #F1F5F9;
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 14px;
          padding: 18px 20px;
          box-shadow: 0 20px 60px rgba(0,0,0,0.55);
          z-index: 99999;
          font-family: -apple-system, 'Inter', Segoe UI, Roboto, sans-serif;
          font-size: 14px; line-height: 1.5;
        }
        #kairos-cookie-banner * { box-sizing: border-box; }
        #kairos-cc-title { font-size: 15px; font-weight: 700; margin: 0 0 6px; }
        #kairos-cc-body { font-size: 13px; color: #CBD5E1; margin: 0 0 14px; }
        #kairos-cc-body a { color: #60A5FA; text-decoration: underline; }
        .kairos-cc-actions { display: flex; gap: 8px; flex-wrap: wrap; }
        .kairos-cc-btn {
          flex: 1; min-width: 110px;
          padding: 9px 14px; border-radius: 8px;
          border: 1px solid rgba(255,255,255,0.18);
          background: transparent; color: #F1F5F9;
          font: inherit; font-weight: 600; cursor: pointer;
          transition: all 0.15s;
        }
        .kairos-cc-btn:hover { border-color: #60A5FA; }
        .kairos-cc-btn.primary {
          background: linear-gradient(135deg,#3B82F6,#8B5CF6);
          border-color: transparent;
          box-shadow: 0 2px 12px rgba(59,130,246,0.3);
        }
        .kairos-cc-btn.primary:hover { transform: translateY(-1px); box-shadow: 0 4px 18px rgba(59,130,246,0.45); }
        .kairos-cc-cat {
          padding: 10px 0;
          border-bottom: 1px solid rgba(255,255,255,0.08);
        }
        .kairos-cc-cat:last-child { border-bottom: none; }
        .kairos-cc-cat-head {
          display: flex; justify-content: space-between; align-items: center; gap: 10px;
        }
        .kairos-cc-cat-name { font-weight: 600; font-size: 13px; }
        .kairos-cc-cat-desc { font-size: 12px; color: #94A3B8; margin-top: 4px; }
        .kairos-cc-toggle {
          appearance: none; -webkit-appearance: none;
          width: 36px; height: 20px; border-radius: 20px;
          background: #475569; position: relative; cursor: pointer;
          transition: background 0.2s; flex-shrink: 0;
        }
        .kairos-cc-toggle::after {
          content: ''; position: absolute; top: 2px; left: 2px;
          width: 16px; height: 16px; border-radius: 50%;
          background: #fff; transition: left 0.2s;
        }
        .kairos-cc-toggle:checked { background: #3B82F6; }
        .kairos-cc-toggle:checked::after { left: 18px; }
        .kairos-cc-toggle:disabled { opacity: 0.6; cursor: not-allowed; }
        .kairos-cc-always {
          font-size: 11px; color: #94A3B8;
          padding: 3px 8px; border-radius: 12px;
          background: rgba(148,163,184,0.15);
        }
        @media (prefers-color-scheme: light) {
          :root[data-theme="light"] #kairos-cookie-banner {
            background: #FFFFFF; color: #1F2937;
            border-color: rgba(0,0,0,0.1);
          }
          :root[data-theme="light"] #kairos-cc-body { color: #6B7280; }
          :root[data-theme="light"] .kairos-cc-btn { color: #1F2937; border-color: rgba(0,0,0,0.15); }
        }
        :root[data-theme="light"] #kairos-cookie-banner {
          background: #FFFFFF; color: #1F2937;
          border-color: rgba(0,0,0,0.1);
        }
        :root[data-theme="light"] #kairos-cc-body { color: #6B7280; }
        :root[data-theme="light"] .kairos-cc-btn { color: #1F2937; border-color: rgba(0,0,0,0.15); }
        :root[data-theme="light"] .kairos-cc-cat { border-color: rgba(0,0,0,0.08); }
        :root[data-theme="light"] .kairos-cc-cat-desc { color: #6B7280; }
      </style>
      <div id="kairos-cc-main">
        <h3 id="kairos-cc-title">${tr('title')}</h3>
        <p id="kairos-cc-body">${tr('body')} <a href="legal.html#cookies" rel="noopener">${tr('moreLink')}</a></p>
        <div class="kairos-cc-actions">
          <button type="button" class="kairos-cc-btn" data-action="customize">${tr('customize')}</button>
          <button type="button" class="kairos-cc-btn" data-action="refuse">${tr('refuseAll')}</button>
          <button type="button" class="kairos-cc-btn primary" data-action="accept">${tr('acceptAll')}</button>
        </div>
      </div>
      <div id="kairos-cc-custom" style="display:none">
        <h3 id="kairos-cc-title">${tr('title')}</h3>
        <div class="kairos-cc-cat">
          <div class="kairos-cc-cat-head">
            <div>
              <div class="kairos-cc-cat-name">${tr('cat_necessary')}</div>
              <div class="kairos-cc-cat-desc">${tr('cat_necessary_desc')}</div>
            </div>
            <span class="kairos-cc-always">${tr('always_on')}</span>
          </div>
        </div>
        <div class="kairos-cc-cat">
          <div class="kairos-cc-cat-head">
            <div>
              <div class="kairos-cc-cat-name">${tr('cat_analytics')}</div>
              <div class="kairos-cc-cat-desc">${tr('cat_analytics_desc')}</div>
            </div>
            <input type="checkbox" class="kairos-cc-toggle" id="kairos-cc-analytics" />
          </div>
        </div>
        <div class="kairos-cc-cat">
          <div class="kairos-cc-cat-head">
            <div>
              <div class="kairos-cc-cat-name">${tr('cat_marketing')}</div>
              <div class="kairos-cc-cat-desc">${tr('cat_marketing_desc')}</div>
            </div>
            <input type="checkbox" class="kairos-cc-toggle" id="kairos-cc-marketing" />
          </div>
        </div>
        <div class="kairos-cc-actions" style="margin-top:14px">
          <button type="button" class="kairos-cc-btn" data-action="back">${tr('back')}</button>
          <button type="button" class="kairos-cc-btn primary" data-action="save-custom">${tr('save')}</button>
        </div>
      </div>
    `;

    // Handlers
    el.addEventListener('click', function (ev) {
      const action = ev.target?.dataset?.action;
      if (!action) return;
      if (action === 'accept') {
        const prefs = { analytics: true, marketing: true };
        saveConsent(prefs); applyConsent(prefs); hide();
      } else if (action === 'refuse') {
        const prefs = { analytics: false, marketing: false };
        saveConsent(prefs); applyConsent(prefs); hide();
      } else if (action === 'customize') {
        const cur = loadConsent() || {};
        el.querySelector('#kairos-cc-analytics').checked = !!cur.analytics;
        el.querySelector('#kairos-cc-marketing').checked = !!cur.marketing;
        el.querySelector('#kairos-cc-main').style.display = 'none';
        el.querySelector('#kairos-cc-custom').style.display = 'block';
      } else if (action === 'back') {
        el.querySelector('#kairos-cc-custom').style.display = 'none';
        el.querySelector('#kairos-cc-main').style.display = 'block';
      } else if (action === 'save-custom') {
        const prefs = {
          analytics: el.querySelector('#kairos-cc-analytics').checked,
          marketing: el.querySelector('#kairos-cc-marketing').checked,
        };
        saveConsent(prefs); applyConsent(prefs); hide();
      }
    });

    return el;
  }

  function show() {
    if (_bannerEl) return;
    _bannerEl = buildBanner();
    document.body.appendChild(_bannerEl);
  }
  function hide() {
    if (_bannerEl) {
      _bannerEl.remove();
      _bannerEl = null;
    }
  }

  // 5) Init : si pas de choix → afficher le bandeau, sinon appliquer le choix existant
  function init() {
    const existing = loadConsent();
    if (existing) {
      applyConsent(existing);
    } else {
      show();
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 6) API publique pour rouvrir le bandeau (lien footer "Gérer mes cookies")
  window.KairosCookieConsent = {
    open: show,
    reset: function () {
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
      show();
    },
  };
})();
