/* Production presentation layer: reuses the authenticated data renderers.
 * No fixture data, extra API privileges, or changes to financial calculations. */
(function () {
  'use strict';
  const text = (fr, en) => window.KairosI18n?.getLang() === 'en' ? en : fr;
  const byId = id => document.getElementById(id);
  function makeTabs(host, prefix, items, selected, onSelect) {
    host.setAttribute('role', 'tablist');
    host.classList.add('core-tabs');
    host.replaceChildren();
    for (const [key, label] of items) {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = label;
      button.id = `${prefix}-tab-${key}`;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-controls', `${prefix}-panel-${key}`);
      button.dataset.coreTab = key;
      button.onclick = () => onSelect(key);
      host.append(button);
    }
    host.onkeydown = event => {
      const buttons = [...host.querySelectorAll('[role=tab]')];
      const i = buttons.indexOf(document.activeElement);
      if (i < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (i + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].click(); buttons[next].focus();
    };
    onSelect(selected);
  }
  function panel(prefix, key, parent) {
    const el = document.createElement('section');
    el.id = `${prefix}-panel-${key}`;
    el.className = 'core-panel';
    el.setAttribute('role', 'tabpanel');
    el.setAttribute('aria-labelledby', `${prefix}-tab-${key}`);
    parent.append(el); return el;
  }
  function selectTab(host, panels, key) {
    host.querySelectorAll('[role=tab]').forEach(button => {
      const active = button.dataset.coreTab === key;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    });
    Object.entries(panels).forEach(([id, el]) => { el.hidden = id !== key; });
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }
  const stockLabels = () => [
    ['overview', text('Vue d’ensemble', 'Overview')], ['insiders', text('Initiés', 'Insiders')],
    ['funds', text('Fonds & activistes', 'Funds & activists')], ['analysis', text('Analyse', 'Analysis')],
    ['news', text('Actualités', 'News')], ['calendar', text('Calendrier', 'Calendar')], ['company', text('Société', 'Company')],
  ];
  let stockSelection = 'overview', stockSymbol = null;
  function mountStock(data) {
    const body = byId('stockAnalysisBody'), nav = byId('stockAnalysisNav');
    if (!body || !nav || nav.dataset.coreMounted) return;
    nav.dataset.coreMounted = 'true';
    if (stockSymbol !== data.ticker) stockSelection = 'overview';
    stockSymbol = data.ticker;
    const panels = Object.fromEntries(stockLabels().map(([id]) => [id, panel('stock', id, body)]));
    const move = (selector, key, parent = false) => {
      const el = body.querySelector(selector);
      if (el) panels[key].append(parent ? el.parentElement : el);
    };
    move('#stockChartCard', 'overview'); move('.kairos-score-card', 'overview');
    panels.overview.classList.add('core-overview');
    move('[data-saInsiderCard]', 'insiders');
    move('#core-funds-card', 'funds'); move('#activistBannerSlot', 'funds'); move('#core-politicians-card', 'funds');
    move('#analysis-detail-fundamentals', 'analysis', true);
    move('#core-analysts-heading', 'analysis', true);
    move('#analysis-detail-health', 'analysis', true);
    move('#core-fair-value-heading', 'analysis', true);
    const trends = body.querySelector('#core-trends-heading');
    if (trends) panels.analysis.append(trends.parentElement.parentElement);
    move('#analysis-detail-earnings', 'calendar', true);
    move('#analysis-detail-news', 'news', true);
    move('#core-company-heading', 'company', true); move('#core-peers-heading', 'company', true);
    move('#core-company-details', 'company');
    // Keep the asynchronous activity slot inside the funds tab, even while empty.
    let activity = byId('recentActivitySlot');
    if (!activity) { activity = document.createElement('div'); activity.id = 'recentActivitySlot'; }
    panels.funds.append(activity);
    byId('analysis-detail-smart-money')?.remove();
    // Empty layout wrappers can go; unclassified real content stays in Analysis.
    let passedNav = false;
    for (const el of [...body.children]) {
      if (el === nav) { passedNav = true; continue; }
      if (!passedNav || el.classList.contains('core-panel')) continue;
      if (!el.textContent.trim() && !el.querySelector('canvas,img,input')) el.remove();
      else panels.analysis.append(el);
    }
    for (const key of ['news', 'calendar', 'company']) {
      if (!panels[key].children.length) {
        const empty = document.createElement('p'); empty.className = 'core-empty';
        empty.textContent = text('Aucune information disponible pour cette société.', 'No information available for this company.');
        panels[key].append(empty);
      }
    }
    const radar = body.querySelector('.kairos-score-card');
    if (radar) {
      const row = radar.querySelector('.kairos-score-row');
      const breakdown = row?.lastElementChild;
      if (breakdown && row.children.length === 2) {
        const details = document.createElement('details'); details.className = 'core-score-details';
        const summary = document.createElement('summary'); summary.textContent = text('Comprendre les 8 axes', 'Understand the 8 dimensions');
        details.append(summary, breakdown); radar.append(details);
        const header = radar.querySelector('h2')?.parentElement.parentElement;
        const narrative = header?.lastElementChild;
        if (narrative && narrative !== header.firstElementChild) details.insertBefore(narrative, breakdown);
      }
      // Vivid gradient and a full-spectrum gauge preserve the signature radar.
      const gradient = radar.querySelector('radialGradient');
      if (gradient) {
        const stops = gradient.querySelectorAll('stop');
        ['#5ce0c3', '#7792ff', '#b16fff'].forEach((color, i) => {
          stops[i]?.setAttribute('stop-color', color);
          stops[i]?.setAttribute('stop-opacity', ['.5', '.32', '.18'][i]);
        });
      }
      const total = data.score?.total;
      if (Number.isFinite(total)) {
        const trigger = document.createElement('button'); trigger.className = 'core-score-trigger'; trigger.type = 'button';
        trigger.setAttribute('aria-label', text(`Situer le score ${total} sur 100`, `Locate the score ${total} out of 100`));
        const gauge = document.createElement('span'); gauge.className = 'core-score-gauge';
        gauge.innerHTML = `<strong>${total}/100</strong><span class="core-gauge-track"><i style="--score:${Math.max(0, Math.min(100, total))}%"></i></span><span class="core-gauge-labels">100<br>75<br>50<br>25<br>0</span>`;
        trigger.append(gauge);
        row?.firstElementChild.append(trigger);
      }
    }
    function choose(key) {
      stockSelection = key; selectTab(nav, panels, key);
    }
    window.KairosCore.openStockTab = choose;
    makeTabs(nav, 'stock', stockLabels(), stockSelection, choose);
    window.KairosCore.configurePriceChart?.();
  }

  function mountAdmin() {
    const admin = byId('section-admin');
    if (!admin || byId('core-admin-tabs')) return;
    const header = admin.firstElementChild;
    const intro = header.nextElementSibling;
    const access = document.createElement('div'); access.className = 'core-admin-access';
    access.innerHTML = `<h2>${text('Administration Kairos', 'Kairos administration')}</h2><p>${text('Connectez-vous avec le compte administrateur vérifié pour accéder à cet espace.', 'Sign in with the verified administrator account to access this space.')}</p><button type="button">${text('Se connecter', 'Sign in')}</button>`;
    access.querySelector('button').onclick = () => { byId('authOverlay').classList.remove('hidden'); showLogin(); };
    admin.append(access);
    const kpis = byId('adKpiUsers')?.parentElement.parentElement;
    const nav = document.createElement('div'); nav.id = 'core-admin-tabs';
    nav.setAttribute('aria-label', text('Rubriques d’administration', 'Administration sections'));
    intro.after(nav);
    const labels = [ ['overview', text('Vue d’ensemble', 'Overview')], ['data', text('Données & collectes', 'Data & collection')],
      ['users', text('Utilisateurs & accès', 'Users & access')], ['communication', 'Communication'], ['settings', text('Réglages Kairos', 'Kairos settings')] ];
    const panels = Object.fromEntries(labels.map(([key]) => [key, panel('admin', key, admin)]));
    if (kpis) panels.overview.append(kpis);
    const mapping = { adUsersBody: 'users', adPartnersBody: 'users', adTrafficBody: 'overview',
      adDbBody: 'data', adJobsTimelineBody: 'data', adChatSessionsBody: 'communication',
      adScoreWeightsBody: 'settings', adErrorsBody: 'data' };
    for (const [id, key] of Object.entries(mapping)) {
      const el = byId(id); if (el) panels[key].append(el.parentElement);
    }
    const communicationActions = document.createElement('div'); communicationActions.className = 'core-admin-actions';
    for (const button of [...header.querySelectorAll('button')]) {
      if (/previewDailyTweets|sendTweetsEmail|sendCommentDigestEmail/.test(button.getAttribute('onclick') || '')) communicationActions.append(button);
    }
    const note = document.createElement('p'); note.className = 'core-empty';
    note.textContent = text('Prévisualisez vos contenus avant leur envoi. Les actions d’envoi restent manuelles.', 'Preview content before sending. Sending actions remain manual.');
    panels.communication.prepend(note, communicationActions);
    const choose = key => selectTab(nav, panels, key);
    makeTabs(nav, 'admin', labels, 'overview', choose);
    const userKpi = byId('adKpiUsers')?.parentElement;
    if (userKpi) { userKpi.onclick = () => choose('users'); userKpi.tabIndex = 0;
      userKpi.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose('users'); } }; }
    for (const [id, key] of [['adKpiJobs', 'data'], ['adKpiBackup', 'data']]) {
      const item = byId(id)?.parentElement; if (item) item.onclick = () => choose(key);
    }
  }

  function openShare(ticker) {
    const lang = window.KairosI18n?.getLang() || 'fr';
    const links = window.KairosSharing.stockLinks(ticker, lang);
    byId('core-share-dialog')?.remove();
    const dialog = document.createElement('dialog'); dialog.id = 'core-share-dialog';
    dialog.setAttribute('aria-labelledby', 'core-share-title');
    dialog.innerHTML = `<form method="dialog"><button class="core-share-close" aria-label="${text('Fermer', 'Close')}">×</button></form>
      <h2 id="core-share-title">${text('Partager la fiche', 'Share this stock')} ${links.symbol}</h2>
      <p>${text('Une fiche publique, accessible sans compte.', 'A public stock page, accessible without an account.')}</p>
      <img class="core-share-preview" alt="${text('Aperçu du partage Kairos', 'Kairos share preview')}" src="${links.image}">
      <p class="core-share-image-error" hidden>${text('L’aperçu est temporairement indisponible. Le lien reste partageable.', 'The preview is temporarily unavailable. You can still share the link.')}</p>
      <label for="core-share-url">${text('Lien public', 'Public link')}</label><input id="core-share-url" readonly value="${links.url}">
      <div class="core-share-actions"><button type="button" id="core-copy-link">${text('Copier le lien', 'Copy link')}</button>
      <a href="${links.x.replace(/&/g, '&amp;')}" target="_blank" rel="noopener noreferrer">${text('Partager sur X', 'Share on X')} ↗</a></div>`;
    document.body.append(dialog);
    dialog.querySelector('img').onerror = event => { event.target.hidden = true; dialog.querySelector('.core-share-image-error').hidden = false; };
    dialog.querySelector('#core-copy-link').onclick = async event => {
      try { await navigator.clipboard.writeText(links.url); event.target.textContent = text('Lien copié !', 'Link copied!'); }
      catch { dialog.querySelector('input').select(); }
    };
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener('close', () => dialog.remove());
    dialog.showModal();
  }
  function start() {
    document.body.classList.add('core-release');
    const sidebar = byId('sidebar');
    const keep = new Set(['stockAnalysis', 'insider', 'activists', '13f', 'admin']);
    sidebar?.querySelectorAll('.sidebar-item').forEach(button => {
      if (!keep.has(button.dataset.section)) button.hidden = true;
    });
    sidebar?.querySelectorAll('.sidebar-section').forEach(section => {
      if (![...section.querySelectorAll('.sidebar-item')].some(button => !button.hidden)) section.hidden = true;
    });
    document.querySelectorAll('img[src="assets/logo.svg"]').forEach(img => { img.src = 'assets/kairos-inflexion.svg'; });
    // Reuse the existing autocomplete and its real quotes from every core screen.
    const search = document.querySelector('.stock-search-bar');
    const main = document.querySelector('#main-content > .container');
    if (search && main) {
      const bar = document.createElement('header'); bar.className = 'core-search-header'; bar.append(search); main.prepend(bar);
      byId('stockSearchInput').addEventListener('focus', () => {
        if (!byId('section-stockAnalysis').classList.contains('active')) switchSection('stockAnalysis');
      });
    }
    document.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); byId('stockSearchInput')?.focus(); }
    });
    mountAdmin();
    window.addEventListener('kairos:admin-access', event => {
      if (event.detail.allowed && location.hash.startsWith('#admin')) loadAdminDashboard(true);
    });
    window.addEventListener('kairos:auth-ready', () => {
      if (typeof currentUser !== 'undefined' && !currentUser) {
        byId('section-admin').dataset.access = 'denied';
        byId('sidebarAdminSection').style.display = 'none';
      }
    });
    window.shareStockAnalysis = openShare;
    if (!location.hash || location.hash === '#home') switchSection('stockAnalysis');
  }
  window.KairosCore = { mountStock, openShare };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
