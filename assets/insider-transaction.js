/* Shared transaction evidence rules. No filing-wide text belongs in this classifier. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  // Also expose the API for Worker side-effect imports of this shared browser file.
  root.KairosInsiderTransaction = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const rawCodeFields = ['code', 'transactionCode', 'transCode', 'trans_code'];
  const natureFields = ['nature', 'nature_raw', 'transactionNature'];
  const securityFields = ['securityTitle', 'security_title', 'instrument', 'security', 'securityType', 'security_type'];
  const excludedCodes = {
    A: 'grant', G: 'gift', M: 'exercise', X: 'exercise', O: 'exercise',
    C: 'conversion', F: 'tax-withholding', D: 'not-purchase', I: 'not-purchase',
    J: 'not-purchase', W: 'not-purchase', Z: 'not-purchase',
    L: 'not-purchase', U: 'not-purchase', E: 'not-purchase', H: 'not-purchase',
  };
  const otherReasons = new Set(['grant', 'gift', 'exercise', 'conversion', 'tax-withholding', 'derivative-security']);
  const exclusionReasons = new Set([...otherReasons, 'employee-plan', 'mandatory-acquisition', 'not-purchase']);
  const buyText = /\b(?:buy|purchase|purchases|achat|achats|acquisition|acquisitions|kauf|ankauf|erwerb|souscription|subscription)\b/;
  const euPurchaseNature = /^(?:acquisition|acquisitions|achat|achats|kauf|ankauf|erwerb|souscription|subscription)\b/;
  const saleText = /\b(?:sell|sale|sales|vente|ventes|cession|cessions|verkauf|verausserung)\b/;
  const mechanisms = [
    ['tax-withholding', /\b(?:tax[ -]+withholding|withheld\b.{0,65}\btax|retenue\b.{0,40}\b(?:fiscale|impot)|steuerabzug)\b/],
    ['exercise', /^(?:exercise|exercice|ausubung)$|\b(?:exercis(?:e|ed|ing)|exercice|exercees?|ausubung|levee)\b.{0,90}\b(?:options?|warrants?|bons? de souscription)\b|\b(?:options?|warrants?)\b.{0,60}\b(?:exercis(?:e|ed|ing)|exercice|exercees?|ausubung)\b/m],
    ['conversion', /\bconversion\b.{0,65}\b(?:securit|shares?|stock|convertible|titres?|actions?)|\bconverted\b.{0,65}\b(?:shares?|stock|securities)\b/],
    ['gift', /\b(?:gift|gifts|gifted|donation|donations|schenkung|don manuel)\b/],
    ['grant', /\b(?:actions? gratuites?|acquisition gratuite|free shares?|restricted stock awards?|stock grants?)\b|\b(?:attribution|attributions)\b.{0,65}\bgratuit|\b(?:grant|award|awarded)\b.{0,55}\b(?:shares?|stock|equity|rsus?)\b/],
    ['employee-plan', /\b(?:espp|fcpe|mitarbeiteraktienprogramm\w*|belegschaftsaktien\w*|employee (?:stock|share) (?:purchase|ownership) (?:plans?|schemes?)|employee (?:stock|share|equity|savings) plans?|(?:stock|share|equity) (?:incentive|compensation) plans?|stock purchase plan for employees|salary sacrifice|plan d[' ]epargne (?:d[' ]?entreprise|entreprise|groupe))\b/],
    ['mandatory-acquisition', /\b(?:mandatory|compulsory|required)\b.{0,45}\b(?:purchase|acquisition|subscription)|\b(?:achat|acquisition|souscription)\b.{0,45}\bobligatoire|\b(?:pflichtkauf|zwangserwerb)\b/],
  ];
  const derivativeSecurity = /\b(?:options?|warrants?|rsus?|restricted stock units?|performance (?:share|stock) units?|convertible (?:notes?|bonds?|securities)|derivatives?|produits? derives?)\b/;

  function normalize(value) {
    return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[’‘]/g, "'").replace(/[‐‑‒–—]/g, '-').toLowerCase().trim();
  }
  function firstText(row, fields) {
    for (const field of fields) if (typeof row[field] === 'string' && row[field].trim()) return row[field];
    return '';
  }
  function direction(value) {
    const text = normalize(value.slice(0, 16384));
    if (text === 'p' || buyText.test(text)) return 'buy';
    if (text === 's' || saleText.test(text)) return 'sell';
    return 'other';
  }
  function evidence(row) {
    const parts = [];
    let oversized = false;
    let remaining = 65536;
    function add(value) {
      if (typeof value !== 'string') return;
      const limit = Math.min(16384, remaining);
      if (value.length > limit) oversized = true;
      const text = value.slice(0, limit);
      remaining -= text.length;
      parts.push(normalize(text));
    }
    for (const field of rawCodeFields) add(row[field]);
    for (const field of natureFields) add(row[field]);
    // These notes must already be resolved from IDs attached to THIS transaction.
    // Do not read footnotes, filingFootnotes, remarks, descriptions or issuer text.
    if (Array.isArray(row.transactionFootnotes)) {
      if (row.transactionFootnotes.length > 32) oversized = true;
      for (const note of row.transactionFootnotes.slice(0, 32)) add(typeof note === 'string' ? note : note?.text);
    }
    const security = [];
    for (const field of securityFields) {
      if (typeof row[field] !== 'string') continue;
      if (row[field].length > 16384) oversized = true;
      security.push(normalize(row[field].slice(0, 16384)));
    }
    return { text: parts.join('\n'), security: security.join('\n'), oversized };
  }
  function result(type, status, reason, planned) {
    return { type, eligiblePurchase: status === 'eligible', status, reason, planned };
  }

  function classifyInsiderTransaction(input) {
    const row = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const rawCode = firstText(row, rawCodeFields);
    const raw = normalize(rawCode.slice(0, 16384));
    const code = raw.toUpperCase();
    const details = evidence(row);
    const rawCodes = rawCodeFields.filter(field => typeof row[field] === 'string' && row[field].trim())
      .map(field => normalize(row[field].slice(0, 16384)));
    const nature = normalize(firstText(row, natureFields).slice(0, 16384));
    const generic = firstText(row, ['type', 'transType', 'trans_type']);
    const type = direction(rawCode || nature || generic);
    const planned = row.form10b5One === true || row.form10b5One === 1 || row.form10b5One === 'true'
      || /\b10b5[ -]?1\b/.test(details.text);

    // Explicit exclusions in ANY raw code win over a conflicting purchase alias.
    for (const value of rawCodes) {
      if (Object.prototype.hasOwnProperty.call(excludedCodes, value.toUpperCase())) return result('other', 'excluded', excludedCodes[value.toUpperCase()], planned);
    }
    for (const [reason, pattern] of mechanisms) {
      if (pattern.test(details.text)) return result(otherReasons.has(reason) ? 'other' : type, 'excluded', reason, planned);
    }
    const security = [details.security, ...rawCodes, ...natureFields.map(field => typeof row[field] === 'string' ? normalize(row[field].slice(0, 16384)) : '')]
      .join('\n').replace(/\bnon[ -]derivative\b/g, '');
    if (row.isDerivative === true || derivativeSecurity.test(security)) return result('other', 'excluded', 'derivative-security', planned);

    const rawDirections = new Set(rawCodes.map(value => value === 'p' || euPurchaseNature.test(value) ? 'buy' : value === 's' || /^(?:sell|sale|vente|cession|verkauf|verausserung)\b/.test(value) ? 'sell' : 'other'));
    if (rawDirections.has('buy') && rawDirections.has('sell')) return result('other', 'unknown', 'conflicting-direction', planned);
    if (rawCodes.length > 1 && rawDirections.size > 1) return result('other', 'unknown', 'unknown', planned);
    if (!rawCode && !nature && /^(?:exercise|exercice|ausubung)$/i.test(generic.trim())) return result('other', 'excluded', 'exercise', planned);

    const acquiredDisposed = normalize(firstText(row, ['ad', 'adType', 'transactionAcquiredDisposedCode']));
    if (type === 'buy' && (acquiredDisposed === 'd' || saleText.test(nature))) return result('other', 'unknown', 'conflicting-direction', planned);
    // A persisted rejection remains a conservative guard if a transport loses notes.
    // A persisted true flag cannot supply missing source evidence.
    if (row.purchaseSignalEligible === false) {
      const reason = row.purchaseSignalReason;
      if (exclusionReasons.has(reason)) return result(otherReasons.has(reason) ? 'other' : type, 'excluded', reason, planned);
      return result(type, 'unknown', 'unknown', planned);
    }
    if (details.oversized) return result(type, 'unknown', 'unknown', planned);
    if (type === 'sell') return result('sell', 'excluded', 'not-purchase', planned);
    if (code === 'P') return result('buy', 'eligible', 'reported-purchase', planned);
    const source = normalize(firstText(row, ['source']));
    if (!/\b(?:sec|edgar)\b/.test(source) && euPurchaseNature.test(raw || nature)) return result('buy', 'eligible', 'reported-purchase', planned);
    return result(type, 'unknown', 'unknown', planned);
  }

  return { classifyInsiderTransaction };
});
