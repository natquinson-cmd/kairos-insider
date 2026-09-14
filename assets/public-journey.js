(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KairosPublicJourney = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function dashboardAnalysisUrl(ticker, lang, baseUrl) {
    const safeTicker = String(ticker || '').trim().toUpperCase().replace(/[^A-Z0-9.-]/g, '').slice(0, 12);
    const safeLang = lang === 'en' ? 'en' : 'fr';
    const base = baseUrl ? new URL('dashboard.html', baseUrl).href : 'dashboard.html';
    return `${base}?lang=${safeLang}#stockAnalysis?t=${encodeURIComponent(safeTicker)}`;
  }

  function withLang(href, lang) {
    const safeLang = lang === 'en' ? 'en' : 'fr';
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(href);
    const url = new URL(href, 'https://kairos.local/');
    url.searchParams.set('lang', safeLang);
    return absolute ? url.href : url.pathname.replace(/^\//, '') + url.search + url.hash;
  }

  function pricingUrl(plan, billing, lang) {
    const safePlan = plan === 'elite' ? 'elite' : 'pro';
    const safeBilling = billing === 'yearly' ? 'yearly' : 'monthly';
    return withLang(`dashboard.html?plan=${safePlan}&billing=${safeBilling}`, lang);
  }

  function syncDashboardLinks(doc, lang) {
    doc.querySelectorAll('a[href^="dashboard.html"]').forEach(function (link) {
      link.setAttribute('href', withLang(link.getAttribute('href'), lang));
    });
  }

  function initMobileMenu(doc) {
    const button = doc.getElementById('navMenuToggle');
    const menu = doc.getElementById('navLinks');
    if (!button || !menu) return;

    function setOpen(open) {
      menu.classList.toggle('is-open', open);
      button.setAttribute('aria-expanded', String(open));
    }

    button.addEventListener('click', function () {
      setOpen(button.getAttribute ? button.getAttribute('aria-expanded') !== 'true' : button.attrs?.['aria-expanded'] !== 'true');
    });
    menu.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () { setOpen(false); });
    });
    doc.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && button.getAttribute('aria-expanded') === 'true') {
        setOpen(false);
        button.focus();
      }
    });
  }

  return { dashboardAnalysisUrl, withLang, pricingUrl, syncDashboardLinks, initMobileMenu };
});
