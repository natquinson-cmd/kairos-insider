import '../../assets/insider-transaction.js';

const classifier = globalThis.KairosInsiderTransaction.classifyInsiderTransaction;
const evidenceFields = ['code', 'ad', 'nature', 'nature_raw', 'transactionNature', 'securityTitle', 'security_title', 'securityType', 'isDerivative', 'transactionFootnotes', 'form10b5One'];

// D1 stores the original transaction evidence separately from its broad type.
// Never accept a persisted positive eligibility flag as proof of a purchase.
export function insiderTransactionEvidence(row = {}) {
  let stored = {};
  try { stored = typeof row.transaction_evidence === 'string' ? JSON.parse(row.transaction_evidence) : row.transaction_evidence || {}; } catch {}
  const evidence = {};
  for (const field of evidenceFields) {
    if (Object.hasOwn(row, field)) evidence[field] = row[field];
    else if (stored && typeof stored === 'object' && Object.hasOwn(stored, field)) evidence[field] = stored[field];
  }
  if (stored?.purchaseSignalEligible === false) {
    evidence.purchaseSignalEligible = false;
    evidence.purchaseSignalReason = stored.purchaseSignalReason;
  }
  return evidence;
}

export function classifyInsiderTransaction(row = {}) {
  if (!row.transaction_evidence) return classifier(row);
  return classifier({ ...row, ...insiderTransactionEvidence(row) });
}

export function withInsiderTransactionEvidence(row = {}) {
  const evidence = insiderTransactionEvidence(row), classification = classifyInsiderTransaction({ ...row, ...evidence });
  return {
    ...row, ...evidence, type: classification.type,
    ...(Object.hasOwn(row, 'transType') ? { transType: classification.type } : {}),
    ...(Object.hasOwn(row, 'trans_type') ? { trans_type: classification.type } : {}),
    purchaseSignalEligible: classification.eligiblePurchase,
    purchaseSignalStatus: classification.status,
    purchaseSignalReason: classification.reason,
    planned: classification.planned,
  };
}

// A corrected source row can change its broad type, which is part of the D1
// primary key. Prefer its retained exclusion evidence over an otherwise exact
// economic copy; unrelated actors, filings and different fills remain separate.
export function preferInsiderTransactionEvidence(rows) {
  const groups = new Map(), result = [];
  const number = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : value;
  for (const row of rows) {
    const reference = row?.accession || row?.adsh || row?.bdif_numero;
    if (!reference) { result.push(row); continue; }
    const actor = row.insider_cik || row.insiderCik || row.insider;
    const key = JSON.stringify([String(row.source || '').toLowerCase(), reference, actor, row.ticker || row.cik, row.trans_date || row.date || row.transDate, number(row.shares), number(row.price), number(row.value)]);
    if (!groups.has(key)) groups.set(key, row);
    else {
      const previous = groups.get(key);
      if (Array.isArray(previous)) previous.push(row);
      else groups.set(key, [previous, row]);
    }
  }
  for (const candidates of groups.values()) {
    if (!Array.isArray(candidates)) { result.push(candidates); continue; }
    const rejected = candidates.filter(row => {
      const classification = classifyInsiderTransaction(row);
      return classification.status === 'excluded' && classification.reason !== 'not-purchase';
    });
    if (rejected.length) {
      const compatible = (a, b) => {
        const ae = insiderTransactionEvidence(a), be = insiderTransactionEvidence(b);
        const optionalPairs = [
          [a.lineId ?? a.transactionId ?? a.lineIndex ?? a.transactionIndex, b.lineId ?? b.transactionId ?? b.lineIndex ?? b.transactionIndex],
          [ae.securityTitle || ae.security_title, be.securityTitle || be.security_title],
          [a.ownership || a.ownershipType, b.ownership || b.ownershipType],
          [number(a.shares_after ?? a.sharesAfter), number(b.shares_after ?? b.sharesAfter)],
        ];
        if (optionalPairs.some(([a, b]) => a != null && a !== '' && b != null && b !== '' && a !== b)) return false;
        // D1 line_num is assigned within broad-type partitions and may change
        // for a corrected buy -> other row, but distinct same-type lines stay.
        return !(a.line_num != null && b.line_num != null && a.line_num !== b.line_num && a.trans_type === b.trans_type);
      };
      rejected.sort((a, b) => JSON.stringify(insiderTransactionEvidence(b)).length - JSON.stringify(insiderTransactionEvidence(a)).length);
      for (const row of candidates) {
        const preferred = rejected.find(exclusion => compatible(row, exclusion));
        if (!preferred || preferred === row) result.push(row);
      }
    }
    else result.push(...candidates);
  }
  return result;
}

// Aggregate only documented directional transactions. Awards and unknown
// acquisitions remain in the archive but cannot supply cluster participants.
export function aggregateInsiderSignalRows(rows, { by = 'ticker' } = {}) {
  rows = preferInsiderTransactionEvidence(rows);
  const accumulator = createInsiderSignalAccumulator({ by, identities: rows });
  accumulator.add(rows);
  return accumulator.results();
}

function createInsiderSignalAccumulator({ by = 'ticker', identities = [] } = {}) {
  const name = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).sort().join(' ');
  const identified = value => value && !['unknown', 'inconnu', 'n a', 'a n', 'na', 'not available', 'anonymous'].includes(value);
  const cik = row => String(row.insider_cik || row.insiderCik || '').replace(/^0+/, '');
  const aliases = new Map();
  for (const row of identities) {
    const label = name(row.insider), id = cik(row);
    if (!identified(label) || !/^\d+$/.test(id)) continue;
    if (!aliases.has(label)) aliases.set(label, new Set());
    aliases.get(label).add(id);
  }
  const groups = new Map();
  const add = rows => {
    const seen = new Set();
    for (const raw of rows) {
    const row = withInsiderTransactionEvidence(raw), buy = row.purchaseSignalEligible, sell = row.type === 'sell';
    if (!buy && !sell) continue;
    const ticker = String(row.ticker || '').trim().toUpperCase();
    if (!ticker) continue;
    const label = name(row.insider), id = cik(row), candidates = aliases.get(label);
    const actor = /^\d+$/.test(id) ? 'cik:' + id : !identified(label) || candidates?.size > 1 ? null : candidates?.size === 1 ? 'cik:' + [...candidates][0] : 'name:' + label;
    if (by === 'insider' && !actor) continue;
    const key = by === 'insider' ? actor : ticker;
    const reference = row.accession || row.bdif_numero || row.sourceUrl || '';
    const transactionKey = JSON.stringify([ticker, actor || row.insider, reference, row.trans_date || row.date, row.filing_date || row.fileDate, row.type, row.shares, row.price, row.value, row.line_num ?? row.transactionIndex ?? '']);
    if (seen.has(transactionKey)) continue;
    seen.add(transactionKey);
    if (!groups.has(key)) groups.set(key, { ticker, company: row.company || '', insider: row.insider, title: row.title || '', buyers: new Set(), sellers: new Set(), people: new Set(), names: new Set(), roles: new Set(), tickers: new Set(), rawTxLines: 0, buyValue: 0, sellValue: 0, lastDate: '' });
    const group = groups.get(key), value = Number(row.value), date = row.trans_date || row.date || '';
    group.rawTxLines++; group.tickers.add(ticker);
    if (actor) { group.people.add(actor); group[buy ? 'buyers' : 'sellers'].add(actor); group.names.add(row.insider || actor); }
    if (row.title) group.roles.add(row.title);
    if (Number.isFinite(value) && value > 0) group[buy ? 'buyValue' : 'sellValue'] += value;
    if (date > group.lastDate) group.lastDate = date;
    }
  };
  const results = () => [...groups.values()].map(group => ({
    ticker: group.ticker, company: group.company, insider: group.insider, title: group.title,
    uniqueInsiders: group.people.size, buyInsiders: group.buyers.size, sellInsiders: group.sellers.size,
    rawTxLines: group.rawTxLines, buyValue: group.buyValue, sellValue: group.sellValue,
    names: [...group.names], roles: [...group.roles], tickers: [...group.tickers], lastDate: group.lastDate,
  }));
  return { add, results };
}

// Load every source type so a corrected grant can suppress an old P row. Only
// a page plus one filing is held at a time; raw footnotes never accumulate for
// the complete market window. Identity aliases are small distinct-name rows.
export async function aggregateD1InsiderSignals(history, { where, args = [], by = 'ticker' }) {
  const identities = (await history.prepare(`SELECT DISTINCT insider, insider_cik FROM insider_transactions_history WHERE ${where}`).bind(...args).all()).results || [];
  const accumulator = createInsiderSignalAccumulator({ by, identities });
  const sql = `SELECT source, accession, cik, ticker, company, insider, insider_cik, title,
    trans_type, trans_code, transaction_evidence, trans_date, filing_date, shares, price, value, shares_after, line_num
    FROM insider_transactions_history WHERE ${where}
    ORDER BY source, accession, cik, insider, trans_date, trans_type, line_num LIMIT ? OFFSET ?`;
  let filing = [], filingKey = null;
  const flush = () => { accumulator.add(preferInsiderTransactionEvidence(filing)); filing = []; };
  for (let offset = 0; ; offset += 1000) {
    const rows = (await history.prepare(sql).bind(...args, 1000, offset).all()).results || [];
    for (const row of rows) {
      if (!row.accession) { accumulator.add([row]); continue; }
      const key = JSON.stringify([row.source, row.accession, row.cik]);
      if (filingKey !== null && filingKey !== key) flush();
      filingKey = key; filing.push(row);
    }
    if (rows.length < 1000) break;
  }
  flush();
  return accumulator.results();
}

// Recheck legacy KV clusters against raw purchases instead of trusting a
// previously computed buyer count while the collector cache is being refreshed.
export function validatedPurchaseClusters(payload, transactions, now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10), cutoff = new Date(now - 30 * 86400000).toISOString().slice(0, 10);
  const purchases = preferInsiderTransactionEvidence(Array.isArray(transactions) ? transactions : []).filter(row => {
    const date = row.date || row.trans_date || row.transDate;
    return classifyInsiderTransaction(row).eligiblePurchase && typeof date === 'string' && date >= cutoff && date <= today;
  });
  const byCik = new Map(), byTicker = new Map();
  for (const row of purchases) {
    for (const [index, key] of [[byCik, String(row.cik || '')], [byTicker, row.ticker]]) {
      if (!key) continue;
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(row);
    }
  }
  const clusters = (payload?.clusters || []).flatMap(cluster => {
    const matching = (cluster.cik ? byCik.get(String(cluster.cik)) : byTicker.get(cluster.ticker)) || [];
    const group = aggregateInsiderSignalRows(matching.map(row => ({ ...row, ticker: cluster.ticker || row.ticker || cluster.cik })))[0];
    if (!group || group.buyInsiders < 3) return [];
    const details = group.names.map(name => {
      const rows = matching.filter(row => row.insider === name), dates = [...new Set(rows.map(row => row.date || row.trans_date || row.transDate))].sort();
      return { name, title: rows[0]?.title || '', dates, lastDate: dates.at(-1), value: rows.reduce((sum, row) => sum + (Number(row.value) || 0), 0), shares: rows.reduce((sum, row) => sum + (Number(row.shares) || 0), 0), txType: 'buy' };
    });
    return [{ ...cluster, insiderCount: group.buyInsiders, totalInsiders: group.buyInsiders, insiders: group.names, insiderDetails: details, totalValue: group.buyValue, totalFilings: group.rawTxLines, lastDate: group.lastDate }];
  });
  return { ...payload, clusters, totalClusters: clusters.length };
}
