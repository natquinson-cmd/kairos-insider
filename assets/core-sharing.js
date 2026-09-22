(function (root) {
  'use strict';
  function stockLinks(ticker, lang = 'fr', date = new Date()) {
    const symbol = String(ticker || '').trim().toUpperCase();
    if (!/^[A-Z0-9.\-]{1,12}$/.test(symbol)) throw new Error('Invalid ticker');
    const locale = lang === 'en' ? 'en' : 'fr';
    const params = new URLSearchParams({ lang: locale, d: date.toISOString().slice(0, 13).replace(/[-T:]/g, '') });
    const url = `https://kairosinsider.fr/a/${encodeURIComponent(symbol)}?${params}`;
    const title = locale === 'en' ? `${symbol} — explore the signals on Kairos Insider` : `${symbol} — décryptez les signaux sur Kairos Insider`;
    return { symbol, url, title, image: `https://kairosinsider.fr/og/${encodeURIComponent(symbol)}.png?lang=${locale}`,
      x: `https://twitter.com/intent/tweet?${new URLSearchParams({ text: title, url })}` };
  }
  if (typeof module === 'object' && module.exports) module.exports = { stockLinks };
  else root.KairosSharing = { stockLinks };
})(typeof globalThis !== 'undefined' ? globalThis : this);
