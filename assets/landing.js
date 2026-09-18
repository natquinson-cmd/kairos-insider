(function () {
  'use strict';

  const i18n = window.KairosI18n;
  const journey = window.KairosPublicJourney;
  let billing = 'monthly';

  function renderPricing() {
    const yearly = billing === 'yearly';
    document.getElementById('tabMonthly').setAttribute('aria-pressed', String(!yearly));
    document.getElementById('tabAnnual').setAttribute('aria-pressed', String(yearly));
    document.getElementById('proAmount').textContent = i18n.getLang() === 'en'
      ? (yearly ? '€190' : '€19') : (yearly ? '190 €' : '19 €');
    document.getElementById('proPeriod').textContent = i18n.t(yearly ? 'lp.per_year' : 'lp.per_month');
    document.getElementById('proSubline').textContent = i18n.t(yearly ? 'lp.pro_yearly_note' : 'lp.pro_monthly_note');
    const cta = document.getElementById('proCta');
    cta.textContent = i18n.t(yearly ? 'lp.pro_yearly_cta' : 'lp.pro_monthly_cta');
    cta.href = journey.pricingUrl('pro', billing, i18n.getLang());
  }

  function renderLanguage() {
    const lang = i18n.getLang();
    document.getElementById('navLangToggle').textContent = lang === 'fr' ? 'EN' : 'FR';
    document.title = i18n.t('lp.page_title');
    document.querySelectorAll('meta[name="description"], meta[property="og:description"], meta[name="twitter:description"]').forEach(function (meta) {
      meta.content = i18n.t('lp.page_description');
    });
    document.querySelectorAll('meta[property="og:title"], meta[name="twitter:title"]').forEach(function (meta) {
      meta.content = i18n.t('lp.page_title');
    });
    journey.syncDashboardLinks(document, lang);
    document.getElementById('heroExampleCta').href = journey.dashboardAnalysisUrl('AAPL', lang);
    document.querySelectorAll('[data-analysis]').forEach(function (link) {
      link.href = journey.dashboardAnalysisUrl(link.dataset.analysis, lang);
    });
    renderPricing();
  }

  document.querySelectorAll('[data-billing]').forEach(function (button) {
    button.addEventListener('click', function () {
      billing = button.dataset.billing;
      renderPricing();
    });
  });
  document.getElementById('navLangToggle').addEventListener('click', function () {
    i18n.setLang(i18n.getLang() === 'fr' ? 'en' : 'fr');
  });
  window.addEventListener('kairos:langchange', renderLanguage);
  journey.initMobileMenu(document);

  const tabs = Array.from(document.querySelectorAll('[data-demo]'));
  function selectDemo(selected, moveFocus) {
    tabs.forEach(function (tab) {
      const active = tab === selected;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !active;
    });
    if (moveFocus) selected.focus();
  }
  tabs.forEach(function (tab, index) {
    tab.addEventListener('click', function () { selectDemo(tab, false); });
    tab.addEventListener('keydown', function (event) {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next !== undefined) {
        event.preventDefault();
        selectDemo(tabs[next], true);
      }
    });
  });

  const dialog = document.getElementById('screenshotDialog');
  document.querySelectorAll('[data-screenshot]').forEach(function (button) {
    button.addEventListener('click', function () {
      const original = button.querySelector('img');
      const large = document.getElementById('dialogImage');
      large.src = original.src;
      large.alt = original.alt;
      dialog.showModal();
      document.body.classList.add('dialog-open');
    });
  });
  document.getElementById('closeScreenshot').addEventListener('click', function () { dialog.close(); });
  dialog.addEventListener('close', function () { document.body.classList.remove('dialog-open'); });
  dialog.addEventListener('click', function (event) {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
  });
  document.getElementById('manageCookies').addEventListener('click', function () {
    if (window.KairosCookieConsent) window.KairosCookieConsent.open();
  });
  // A shared link's explicit language takes precedence over a saved preference.
  const requestedLang = new URLSearchParams(window.location.search).get('lang');
  if ((requestedLang === 'fr' || requestedLang === 'en') && requestedLang !== i18n.getLang()) {
    i18n.setLang(requestedLang);
  } else {
    renderLanguage();
  }
})();
