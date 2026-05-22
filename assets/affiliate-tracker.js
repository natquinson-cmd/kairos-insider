/**
 * Kairos Insider — Affiliate Tracker (mai 2026)
 * ============================================================
 * Script global a inclure sur TOUTES les pages publiques (index, backtest,
 * partenaires, dashboard, etc.). Capture deux choses :
 *
 *   1. Genere un visitorId unique persiste en localStorage (1 par device)
 *   2. Si ?ref=CODE dans l'URL :
 *      - Sauvegarde le ref en localStorage (kairos-ref, 90j moral)
 *      - POST /api/affiliate/track-click pour incrementer le compteur
 *
 * Le visitorId est expose via window.KairosVisitor.id. Le dashboard.html
 * l'envoie ensuite via le header X-Kairos-Visitor sur les API calls,
 * permettant au worker de faire l'attribution affiliate au 1er signup.
 *
 * Lazy : ne fait JAMAIS de XHR pour les pages sans ?ref=. Cout total
 * = 1 lecture localStorage par page load.
 */
(function() {
  'use strict';

  const STORAGE_KEY = 'kairos-visitor-id';
  const REF_KEY = 'kairos-ref';
  const API_BASE = 'https://kairos-insider-api.natquinson.workers.dev';

  // 1. Genere ou recupere le visitorId
  let vid = null;
  try {
    vid = localStorage.getItem(STORAGE_KEY);
    if (!vid) {
      vid = 'v_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      localStorage.setItem(STORAGE_KEY, vid);
    }
  } catch (e) { /* localStorage disabled : pas de tracking */ }

  // Expose globalement
  window.KairosVisitor = {
    id: vid,
    getRef: function() {
      try { return localStorage.getItem(REF_KEY) || null; } catch { return null; }
    },
  };

  // 2. Si ?ref=CODE present, tracke le clic
  try {
    const params = new URLSearchParams(window.location.search);
    let ref = params.get('ref');
    if (ref) {
      ref = String(ref).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 64);
      if (ref) {
        // Sauvegarde local (utile si l'user signe plus tard, on retrouve le ref)
        try { localStorage.setItem(REF_KEY, ref); } catch {}
        // Track-click cote worker (non-bloquant)
        if (vid) {
          fetch(API_BASE + '/api/affiliate/track-click', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ref: ref, visitorId: vid }),
          }).catch(() => { /* silent */ });
        }
      }
    }
  } catch (e) { /* silent */ }
})();
