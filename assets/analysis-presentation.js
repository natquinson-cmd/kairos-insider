/* Shared display conventions for the dashboard, public pages and server rendering. */
(function (root) {
  'use strict';

  function finiteNumber(value) {
    if (value == null || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function dividendBand(value) {
    const fraction = finiteNumber(value);
    if (fraction == null || fraction < 0) return 'missing';
    if (fraction === 0) return 'none';
    if (fraction <= 0.02) return 'low';
    if (fraction <= 0.05) return 'moderate';
    return 'high';
  }

  function formatDividendYield(value, lang = 'fr') {
    if (dividendBand(value) === 'missing') return '—';
    const text = (Number(value) * 100).toLocaleString(lang === 'en' ? 'en-US' : 'fr-FR', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
    return text + (lang === 'en' ? '%' : ' %');
  }

  function formatUnitPrice(value, currency = 'USD', lang = 'fr') {
    const number = finiteNumber(value);
    if (number == null) return '—';
    const abs = Math.abs(number);
    const decimals = abs > 0 && abs < 1 ? Math.min(8, Math.max(4, -Math.floor(Math.log10(abs)) + 2)) : 2;
    return new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'fr-FR', {
      style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: decimals,
    }).format(number);
  }

  function insiderKind(transaction = {}) {
    const code = String(transaction.transactionCode || transaction.transCode || transaction.transType || transaction.type || '').trim().toUpperCase();
    if (['P', 'BUY', 'ACHAT', 'PURCHASE'].includes(code)) return 'buy';
    if (['S', 'SELL', 'SALE', 'VENTE'].includes(code)) return 'sell';
    if (code) return 'other';
    if (transaction.adType === 'A') return 'buy';
    if (transaction.adType === 'D') return 'sell';
    return 'other';
  }

  const api = { formatDividendYield, dividendBand, formatUnitPrice, insiderKind };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KairosAnalysisPresentation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
