import { finiteNumber } from './financial-normalization.js';
import { classifyInsiderTransaction, insiderTransactionEvidence, preferInsiderTransactionEvidence } from './insider-transaction.js';

const DAY = 86400000;
export const INSIDER_SCORING_CONFIG_KEY = 'config:insider-scoring';
export const INSIDER_SCORING_DEFAULTS = Object.freeze({ saleWeight: 0.33, halfLifeDays: 30, convergenceWindowDays: 30 });
export const INSIDER_SCORING_BOUNDS = Object.freeze({
  saleWeight: Object.freeze({ min: 0, max: 1 }),
  halfLifeDays: Object.freeze({ min: 7, max: 180, integer: true }),
  convergenceWindowDays: Object.freeze({ min: 7, max: 90, integer: true }),
});

// Strict on writes; callers reading old/malformed KV configuration can catch and
// use defaults. A partial object is an intentional override of these defaults.
export function validateInsiderScoringConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid insider scoring configuration');
  const result = { ...INSIDER_SCORING_DEFAULTS };
  for (const [key, value] of Object.entries(input)) {
    const bounds = INSIDER_SCORING_BOUNDS[key];
    if (!Object.hasOwn(INSIDER_SCORING_BOUNDS, key) || typeof value !== 'number' || !Number.isFinite(value)
      || value < bounds.min || value > bounds.max || bounds.integer && !Number.isInteger(value)) {
      throw new Error('Invalid insider scoring parameter: ' + key);
    }
    result[key] = value;
  }
  return result;
}

export function insiderTransactionType(row) {
  return classifyInsiderTransaction(row).type;
}

function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return null;
  const iso = value.slice(0, 10), timestamp = Date.parse(iso + 'T00:00:00Z');
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === iso ? timestamp : null;
}

function identity(row) {
  const cik = String(row.insiderCik || row.insider_cik || '').trim().replace(/^0+/, '');
  if (/^\d+$/.test(cik)) return 'cik:' + cik;
  const name = String(row.insider || row.insiderName || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return !name || ['n a', 'na', 'unknown', 'inconnu', 'non renseigne', 'not available', 'anonymous'].includes(name) ? null : 'name:' + name.split(/\s+/).sort().join(' ');
}

function identityResolver(rows) {
  const aliases = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = identity(row), name = identity({ ...row, insiderCik: null, insider_cik: null });
    if (!id?.startsWith('cik:') || !name) continue;
    if (!aliases.has(name)) aliases.set(name, new Set());
    aliases.get(name).add(id);
  }
  return row => {
    const id = identity(row), candidates = aliases.get(id);
    // Never merge a homonym shared by two different reporting-person CIKs.
    return candidates?.size === 1 ? [...candidates][0] : candidates?.size > 1 ? null : id;
  };
}

const tradeDay = row => day(row.date || row.transDate || row.tradeDate || row.trans_date);
const filingDay = row => day(row.fileDate || row.filingDate || row.filing_date);
const currencyOf = row => /^[A-Z]{3}$/.test(String(row.currency || '').toUpperCase()) ? String(row.currency).toUpperCase() : null;
const validChronology = (row, today) => {
  const traded = tradeDay(row), filed = filingDay(row);
  return (filed == null || filed <= today) && (traded == null || filed == null || traded <= filed);
};

// Filing/accession IDs do not identify distinct economic purchases. Conversely,
// two identified people may genuinely buy identical quantities on the same day.
export function deduplicateInsiderTransactions(rows, { now = Date.now() } = {}) {
  rows = preferInsiderTransactionEvidence(rows);
  const today = Math.floor(now / DAY) * DAY;
  const groups = new Map(), person = identityResolver(rows);
  rows.forEach((row, index) => {
    if (!row || typeof row !== 'object') return;
    const actor = person(row), value = finiteNumber(row.value), price = finiteNumber(row.price);
    // Without an identified actor, equal economic values do not establish a
    // duplicate. Only copies of the same observed filing/line can be merged.
    const unknownRef = actor ? null : [row.accession || row.adsh || row.bdif_numero || row.sourceUrl || row.url || `unidentified:${index}`,
      row.lineId ?? row.transactionId ?? row.lineIndex ?? row.transactionIndex ?? ''];
    const key = JSON.stringify([String(row.ticker || '').toUpperCase(), actor, unknownRef, tradeDay(row) ?? filingDay(row), insiderTransactionType(row),
      finiteNumber(row.shares), value, value == null ? price : null, currencyOf(row)]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  const quality = row => Number(validChronology(row, today)) * 256
    + Number(classifyInsiderTransaction(row).status === 'excluded') * 64
    + Number(Object.values(insiderTransactionEvidence(row)).some(value => Array.isArray(value) ? value.length : value != null && value !== '')) * 32
    + Number(dollarValue(row) != null) * 16
    + Number(finiteNumber(row.valueUsd) != null && finiteNumber(row.valueUsd) >= 0) * 8
    + Number(identity(row)?.startsWith('cik:')) * 4 + Number(finiteNumber(row.price) != null);
  const stable = row => JSON.stringify(row, Object.keys(row).sort());
  const representative = candidates => [...candidates].sort((a, b) => quality(b) - quality(a) || stable(a).localeCompare(stable(b)))[0];
  const result = [];
  for (const candidates of groups.values()) {
    const prices = new Set(candidates.map(row => finiteNumber(row.price)).filter(value => value != null));
    if (prices.size <= 1) {
      // An absent optional price cannot turn a richer copy into another trade.
      result.push(representative(candidates));
    } else {
      // Distinct explicit fill prices remain distinct even when native totals
      // happen to match. A missing price cannot identify which fill it belongs to.
      const fills = new Map();
      for (const row of candidates) {
        const price = finiteNumber(row.price);
        if (!fills.has(price)) fills.set(price, []);
        fills.get(price).push(row);
      }
      for (const fill of fills.values()) result.push(representative(fill));
    }
  }
  return result;
}

function dollarValue(row) {
  const native = finiteNumber(row.value), explicit = finiteNumber(row.valueUsd);
  if (explicit != null && explicit >= 0) return explicit;
  if (native == null || native < 0) return null;
  if (currencyOf(row) === 'USD') return native;
  const rate = finiteNumber(row.fxRateToUsd);
  return rate > 0 && Number.isFinite(native * rate) ? native * rate : null;
}

const valueBonus = value => value > 0 ? Math.max(0, Math.min(6, (Math.log10(value) - 4) * 2)) : 0;

export function computeInsiderScore(insiders = {}, { config, now = Date.now(), marketCap, marketCapCurrency } = {}) {
  let parameters;
  try { parameters = validateInsiderScoringConfig(config ?? {}); } catch { parameters = { ...INSIDER_SCORING_DEFAULTS }; }
  const today = Math.floor(now / DAY) * DAY;
  const sourceAvailable = Array.isArray(insiders?.transactions) && insiders?.dataAvailable !== false;
  const rows = deduplicateInsiderTransactions(sourceAvailable ? insiders.transactions : [], { now });
  const resolvePerson = identityResolver(sourceAvailable ? insiders.transactions : []);
  const s = {
    method: 'purchase-evidence-v2', parameters, buyCount: 0, sellCount: 0, uniqueBuyers: 0, recentBuyers: 0, repeatedBuyers: 0,
    effectiveBuyCount: 0, effectiveSellCount: 0, buyValueUsd: 0, sellValueUsd: 0, recentBuyValueUsd: 0,
    buyTotalsByCurrency: {}, sellTotalsByCurrency: {}, buyAmountBonus: 0, saleAmountBonus: 0,
    convergence: false, convergenceBonus: 0, repeatBonus: 0, dateFallbackCount: 0, excludedDateCount: 0,
    monetaryIncomplete: false, buyStrength: 0, saleStrength: 0, salePenalty: 0,
  };
  const buyers = new Map(), sellers = new Map(), recentBuyers = new Map(), purchaseDates = new Map(), monetaryGroups = new Map();
  let relevantCount = 0, recentBuyValue = 0;
  const cap = finiteNumber(marketCap), useMarketCap = marketCapCurrency === 'USD' && cap > 0;
  for (const row of rows) {
    const classification = classifyInsiderTransaction(row), type = classification.type;
    if (type === 'other' || type === 'buy' && !classification.eligiblePurchase) continue;
    relevantCount++;
    const traded = tradeDay(row), filed = filingDay(row), eventDay = traded ?? filed;
    if (eventDay == null || eventDay > today || !validChronology(row, today)) { s.excludedDateCount++; continue; }
    const fallback = traded == null;
    // A recent publication does not prove a recent trade. Missing trade dates
    // get at most one quarter weight and cannot establish convergence/repeats.
    const age = Math.max((today - eventDay) / DAY, fallback ? 2 * parameters.halfLifeDays : 0);
    const freshness = 2 ** (-age / parameters.halfLifeDays);
    if (fallback) s.dateFallbackCount++;
    const buy = type === 'buy', prefix = buy ? 'buy' : 'sell';
    const person = resolvePerson(row);
    s[buy ? 'buyCount' : 'sellCount']++;
    if (person) {
      const people = buy ? buyers : sellers;
      people.set(person, Math.max(freshness, people.get(person) || 0));
    }
    const currency = currencyOf(row), value = finiteNumber(row.value), usd = dollarValue(row);
    if (currency && value != null && value >= 0) s[prefix + 'TotalsByCurrency'][currency] = (s[prefix + 'TotalsByCurrency'][currency] || 0) + value;
    if (usd == null) s.monetaryIncomplete = true;
    else {
      s[prefix + 'ValueUsd'] += usd;
      const key = JSON.stringify([type, person, eventDay, fallback]);
      const group = monetaryGroups.get(key) || { type, value: 0, freshness };
      group.value += usd;
      monetaryGroups.set(key, group);
    }
    if (!buy) continue;
    if (!person || fallback || age > parameters.convergenceWindowDays) continue;
    recentBuyers.set(person, Math.max(freshness, recentBuyers.get(person) || 0));
    if (!purchaseDates.has(person)) purchaseDates.set(person, new Map());
    purchaseDates.get(person).set(traded, freshness);
    recentBuyValue += (usd || 0) * freshness;
    s.recentBuyValueUsd += usd || 0;
  }
  s.uniqueBuyers = buyers.size;
  s.effectiveBuyCount = [...buyers.values()].reduce((a, b) => a + b, 0);
  s.effectiveSellCount = [...sellers.values()].reduce((a, b) => a + b, 0);
  // Providers split a single person's daily purchase across price/filing rows.
  // Apply the logarithm after grouping, so that formatting cannot amplify it.
  for (const group of monetaryGroups.values()) {
    const materiality = useMarketCap ? Math.min(1, group.value / (cap * 0.00001)) : 1;
    s[group.type === 'buy' ? 'buyAmountBonus' : 'saleAmountBonus'] += valueBonus(group.value) * group.freshness * materiality;
  }
  s.recentBuyers = recentBuyers.size;
  s.convergence = recentBuyers.size >= 3;
  // Breadth can be observed without FX. A monetary bonus needs verified dollar
  // amounts, so unknown currencies never receive a fabricated magnitude bonus.
  if (s.convergence) s.convergenceBonus = 2 * Math.min(1, recentBuyValue / 100000)
    * [...recentBuyers.values()].reduce((a, b) => a + b, 0) / recentBuyers.size;
  for (const dates of purchaseDates.values()) {
    if (dates.size < 2) continue;
    s.repeatedBuyers++;
    s.repeatBonus += 0.5 * Math.min(...dates.values());
  }
  s.repeatBonus = Math.min(1, s.repeatBonus);
  s.buyAmountBonus = Math.min(6, s.buyAmountBonus);
  s.saleAmountBonus = Math.min(6, s.saleAmountBonus);
  s.buyStrength = Math.min(10, s.buyAmountBonus + Math.min(2, s.effectiveBuyCount * 0.4) + s.convergenceBonus + s.repeatBonus);
  s.saleStrength = Math.min(10, s.saleAmountBonus + Math.min(2, s.effectiveSellCount * 0.4));
  s.salePenalty = parameters.saleWeight * s.saleStrength;
  const dataOk = sourceAvailable && (relevantCount === 0 || s.buyCount + s.sellCount > 0);
  const rawScore = Math.max(0, Math.min(20, 10 + s.buyStrength - s.salePenalty));
  const details = dataOk ? {
    fr: `${s.buyCount} achats / ${s.sellCount} ventes · ${s.uniqueBuyers} acheteurs identifiés · achats +${s.buyStrength.toFixed(1)}, ventes −${s.salePenalty.toFixed(1)} / 20${s.convergence ? ` · convergence : ${s.recentBuyers} acheteurs sur ${parameters.convergenceWindowDays} j` : ''}${s.dateFallbackCount ? ' · dates de transaction manquantes : poids réduit' : ''}${s.monetaryIncomplete ? ' · montants sans conversion USD exclus du bonus monétaire' : ''}`,
    en: `${s.buyCount} purchases / ${s.sellCount} sales · ${s.uniqueBuyers} identified buyers · purchases +${s.buyStrength.toFixed(1)}, sales −${s.salePenalty.toFixed(1)} / 20${s.convergence ? ` · convergence: ${s.recentBuyers} buyers over ${parameters.convergenceWindowDays} days` : ''}${s.dateFallbackCount ? ' · missing trade dates: reduced weight' : ''}${s.monetaryIncomplete ? ' · amounts without USD conversion excluded from monetary bonus' : ''}`,
  } : { fr: 'Données d’initiés datées indisponibles', en: 'Dated insider data unavailable' };
  return { rawScore, dataOk, detail: details.fr, details, signals: s };
}
