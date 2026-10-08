const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const modulePath = path.join(__dirname, '../assets/insider-transaction.js');
const api = fs.existsSync(modulePath) ? require(modulePath) : null;
function classify(row) {
  assert.equal(typeof api?.classifyInsiderTransaction, 'function', 'shared classifier is available');
  return api.classifyInsiderTransaction(row);
}
function expected(type, status, reason, planned = false) {
  return { type, eligiblePurchase: status === 'eligible', status, reason, planned };
}

// Real AMF records: worker/transactions_amf.json, declarations 2026DD1115805
// and 2026DD1110541. Only the first is a delivery of free shares.
const ipsosFreeShares = {
  fileDate: '2026-05-21', date: '2026-05-16', company: 'IPSOS',
  insider: 'Olivier Champourlier, Membre du Comité Exécutif', source: 'amf',
  type: 'P', code: "Acquisition définitive d'actions gratuites (livraison)",
  shares: 1200, price: 36.48, value: 43776, currency: 'EUR',
  bdif_numero: '2026DD1115805',
};
const ipsosPurchase = {
  ...ipsosFreeShares, fileDate: '2026-04-28', date: '2026-04-20',
  code: 'Acquisition', shares: 1100, price: 33.2, value: 36520,
  bdif_numero: '2026DD1110541',
};

// SEC source: EPAM / Edward Rockwell, 2026-04-30, shares footnote F1.
// https://www.sec.gov/Archives/edgar/data/1352010/000176189726000004/xslF345X03/wk-form4_1777925750.xml
// The shortened note retains the transaction-specific plan identification.
const epamEmployeePurchase = {
  source: 'sec', ticker: 'EPAM', insider: 'Edward Rockwell', date: '2026-04-30',
  type: 'buy', code: 'P', ad: 'A', securityTitle: 'EPAM Common Stock',
  shares: 77.551, price: 96.71,
  transactionFootnotes: [{ id: 'F1', text: 'Acquisition pursuant to the 2021 Employee Stock Purchase Plan (the ESPP).' }],
};

test('IPSOS free-share delivery is not an eligible purchase despite legacy type P', () => {
  assert.deepEqual(classify(ipsosFreeShares), expected('other', 'excluded', 'grant'));
});
test('IPSOS separately reported cash acquisition remains an eligible purchase', () => {
  assert.deepEqual(classify(ipsosPurchase), expected('buy', 'eligible', 'reported-purchase'));
});
test('SEC P employee-plan acquisition is visible as a buy but excluded from purchase signals', () => {
  assert.deepEqual(classify(epamEmployeePurchase), expected('buy', 'excluded', 'employee-plan'));
});
test('mixed filing notes do not contaminate an unrelated purchase row', () => {
  const row = { source: 'sec', code: 'P', type: 'buy', ad: 'A',
    transactionFootnotes: [{ id: 'F2', text: 'Shares purchased in several open-market transactions.' }],
    footnotes: [{ id: 'F1', text: 'Shares received through Employee Stock Purchase Plan.' }],
    filingFootnotes: 'Stock options exercised. Shares withheld for tax.',
    remarks: 'Another transaction was a grant of restricted stock units.',
  };
  assert.deepEqual(classify(row), expected('buy', 'eligible', 'reported-purchase'));
  assert.equal(classify({ ...row, transactionFootnotes: epamEmployeePurchase.transactionFootnotes }).reason, 'employee-plan');
});

for (const field of ['code', 'transactionCode', 'transCode', 'trans_code']) {
  test(`raw ${field} overrides generic purchase types`, () => {
    assert.deepEqual(classify({ [field]: 'F', type: 'buy', transType: 'P', trans_type: 'buy' }), expected('other', 'excluded', 'tax-withholding'));
  });
}
test('conflicting explicit purchase and sale codes cannot silently choose one direction', () => {
  assert.deepEqual(classify({ code: 'S', transactionCode: 'P', type: 'buy' }), expected('other', 'unknown', 'conflicting-direction'));
});
test('a disqualifying explicit raw alias cannot be hidden by primary code P', () => {
  assert.deepEqual(classify({ code: 'P', transCode: 'M' }), expected('other', 'excluded', 'exercise'));
  assert.deepEqual(classify({ code: 'P', transCode: "Acquisition d'actions gratuites" }), expected('other', 'excluded', 'grant'));
  assert.deepEqual(classify({ code: 'P', trans_code: 'Unknown acquisition' }), expected('other', 'unknown', 'unknown'));
});
test('a tax-withholding note linked to a reported sale keeps that row out of sale signals', () => {
  assert.deepEqual(classify({ code: 'S', transactionFootnotes: [{ text: 'Shares withheld to satisfy tax withholding obligations.' }] }), expected('other', 'excluded', 'tax-withholding'));
});
test('legacy buy is still displayed but is not evidence of an eligible purchase', () => {
  for (const row of [{ type: 'buy' }, { transType: 'P' }, { trans_type: 'buy' }, { type: 'buy', purchaseSignalEligible: true }]) {
    assert.deepEqual(classify(row), expected('buy', 'unknown', 'unknown'));
  }
});
test('generic sale direction remains visible without claiming purchase eligibility', () => {
  assert.deepEqual(classify({ type: 'sell' }), expected('sell', 'excluded', 'not-purchase'));
});
test('acquired direction alone is not a purchase', () => {
  assert.deepEqual(classify({ ad: 'A', price: 99, shares: 100 }), expected('other', 'unknown', 'unknown'));
});
test('SEC purchase eligibility requires raw P, not a text purchase label', () => {
  assert.deepEqual(classify({ source: 'sec', code: 'Acquisition', type: 'buy' }), expected('buy', 'unknown', 'unknown'));
  assert.deepEqual(classify({ source: 'sec', code: 'P', ad: 'A' }), expected('buy', 'eligible', 'reported-purchase'));
});
test('SEC P with a disposed direction is unresolved rather than a strong buy', () => {
  assert.deepEqual(classify({ code: 'P', ad: 'D', type: 'buy' }), expected('other', 'unknown', 'conflicting-direction'));
});

for (const [code, reason] of [['A', 'grant'], ['G', 'gift'], ['M', 'exercise'], ['X', 'exercise'], ['O', 'exercise'], ['C', 'conversion'], ['F', 'tax-withholding'], ['J', 'not-purchase']]) {
  test(`SEC code ${code} is excluded even with an acquired indicator and positive price`, () => {
    assert.deepEqual(classify({ code, ad: 'A', price: 10, type: 'buy' }), expected('other', 'excluded', reason));
  });
}
for (const code of ['Acquisition', 'Achat', 'Kauf', 'Erwerb', 'Souscription']) {
  test(`raw European nature ${code} supports eligibility`, () => {
    assert.deepEqual(classify({ source: 'amf', code, type: 'P' }), expected('buy', 'eligible', 'reported-purchase'));
  });
}
for (const [field, text, type, reason] of [
  ['nature', 'Acquisition gratuite', 'other', 'grant'],
  ['nature_raw', 'Exercice de stock options', 'other', 'exercise'],
  ['transactionNature', 'Donation', 'other', 'gift'],
  ['nature', 'Acquisition obligatoire', 'buy', 'mandatory-acquisition'],
  ['nature', 'Souscription via FCPE', 'buy', 'employee-plan'],
]) {
  test(`transaction nature excludes ${reason}`, () => {
    assert.deepEqual(classify({ code: 'Acquisition', type: 'buy', [field]: text }), expected(type, 'excluded', reason));
  });
}
for (const [text, type, reason] of [
  ['Shares withheld to satisfy tax withholding obligations.', 'other', 'tax-withholding'],
  ['Shares acquired upon exercise of stock options.', 'other', 'exercise'],
  ['Shares delivered upon conversion of convertible securities.', 'other', 'conversion'],
  ['Shares received as a gift.', 'other', 'gift'],
  ['Award of free shares.', 'other', 'grant'],
  ['Mandatory acquisition of shares under an employment obligation.', 'buy', 'mandatory-acquisition'],
  ["Achat dans le plan d’épargne entreprise.", 'buy', 'employee-plan'],
]) {
  test(`transaction-linked notes exclude ${reason}`, () => {
    assert.deepEqual(classify({ code: 'P', transactionFootnotes: [{ id: 'F1', text }] }), expected(type, 'excluded', reason));
  });
}
test('generic plan, bonus and option words are not grounds for excluding a purchase', () => {
  assert.deepEqual(classify({ code: 'P', title: 'Head of Stock Options',
    transactionFootnotes: [{ id: 'F1', text: 'The buyer had the option to trade and used a cash bonus. The company has a strategic plan.' }],
  }), expected('buy', 'eligible', 'reported-purchase'));
});
test('10b5-1 identifies a planned purchase without treating it as mandatory', () => {
  for (const extra of [
    { form10b5One: true },
    { form10b5One: false, transactionFootnotes: [{ id: 'F1', text: 'Purchased under a Rule 10b5-1 trading plan.' }] },
  ]) assert.deepEqual(classify({ code: 'P', ...extra }), expected('buy', 'eligible', 'reported-purchase', true));
  assert.deepEqual(classify({ code: 'P', form10b5One: 'false' }), expected('buy', 'eligible', 'reported-purchase'));
});
test('planned sales and excluded employee-plan purchases keep the planned indicator', () => {
  assert.deepEqual(classify({ code: 'S', form10b5One: true }), expected('sell', 'excluded', 'not-purchase', true));
  assert.deepEqual(classify({ ...epamEmployeePurchase, form10b5One: true }), expected('buy', 'excluded', 'employee-plan', true));
});
for (const title of ['Stock option (right to buy)', 'Restricted Stock Units', 'RSU', 'Call option', 'Warrants', 'Convertible Notes']) {
  test(`derivative instrument ${title} is not a strong share purchase`, () => {
    assert.deepEqual(classify({ code: 'P', securityTitle: title }), expected('other', 'excluded', 'derivative-security'));
  });
}
test('ordinary shares in a non-derivative table remain eligible', () => {
  assert.deepEqual(classify({ code: 'P', securityTitle: 'Non-derivative Common Stock' }), expected('buy', 'eligible', 'reported-purchase'));
});
test('instrument alias also excludes employee equity units', () => {
  assert.deepEqual(classify({ code: 'Acquisition', instrument: 'Restricted Stock Units' }), expected('other', 'excluded', 'derivative-security'));
});
test('explicit derivative security class is respected even without a title', () => {
  assert.deepEqual(classify({ code: 'P', securityType: 'Derivative' }), expected('other', 'excluded', 'derivative-security'));
  assert.deepEqual(classify({ code: 'P', securityTitle: 'Derivative Securities' }), expected('other', 'excluded', 'derivative-security'));
});
test('explicit stock incentive plan is distinct from an ordinary trading plan', () => {
  assert.deepEqual(classify({ code: 'P', transactionFootnotes: [{ text: 'Acquired under the Stock Incentive Plan.' }] }), expected('buy', 'excluded', 'employee-plan'));
});
test('an explicit derivative acquisition nature cannot pass as an equity purchase', () => {
  assert.deepEqual(classify({ code: 'Acquisition de stock-options' }), expected('other', 'excluded', 'derivative-security'));
  assert.deepEqual(classify({ code: 'P', transCode: 'Acquisition de stock-options' }), expected('other', 'excluded', 'derivative-security'));
});
test('contradictory raw transaction nature prevents purchase eligibility', () => {
  assert.deepEqual(classify({ code: 'P', nature: 'Vente' }), expected('other', 'unknown', 'conflicting-direction'));
});
test('German employee-share mechanisms do not become voluntary purchase signals', () => {
  for (const code of ['Kauf im Mitarbeiteraktienprogramm', 'Kauf im Rahmen eines Mitarbeiteraktienprogramms', 'Erwerb von Belegschaftsaktien']) {
    assert.deepEqual(classify({ source: 'bafin', code }), expected('buy', 'excluded', 'employee-plan'));
  }
});
test('a standalone exercise nature remains an identified exclusion', () => {
  assert.deepEqual(classify({ source: 'amf', code: 'Exercice', type: 'buy' }), expected('other', 'excluded', 'exercise'));
  assert.deepEqual(classify({ type: 'exercise' }), expected('other', 'excluded', 'exercise'));
});
test('a purchase word embedded in unrecognized raw nature is not positive evidence', () => {
  assert.deepEqual(classify({ code: 'Other transaction, not a purchase', type: 'buy' }), expected('buy', 'unknown', 'unknown'));
});
test('negative persisted evidence is a guard; positive cached eligibility is not proof', () => {
  assert.deepEqual(classify({ code: 'P', purchaseSignalEligible: false, purchaseSignalReason: 'employee-plan' }), expected('buy', 'excluded', 'employee-plan'));
  assert.deepEqual(classify({ code: 'P', purchaseSignalEligible: false }), expected('buy', 'unknown', 'unknown'));
  assert.deepEqual(classify({ code: 'A', purchaseSignalEligible: true }), expected('other', 'excluded', 'grant'));
});
test('malformed and oversized evidence cannot become a strong purchase', () => {
  for (const row of [null, undefined, [], 42, 'buy', {}]) assert.deepEqual(classify(row), expected('other', 'unknown', 'unknown'));
  assert.deepEqual(classify({ code: 'P', transactionFootnotes: [{ text: 'x'.repeat(100000) }] }), expected('buy', 'unknown', 'unknown'));
});
test('classification does not change the source transaction', () => {
  const row = Object.freeze({ ...epamEmployeePurchase, transactionFootnotes: Object.freeze(epamEmployeePurchase.transactionFootnotes.map(Object.freeze)) });
  assert.equal(classify(row).eligiblePurchase, false);
});
test('the same classifier is available without Node globals for Worker and browser loading', () => {
  assert.ok(fs.existsSync(modulePath), 'shared module exists');
  const context = {};
  vm.runInNewContext(fs.readFileSync(modulePath, 'utf8'), context);
  const result = context.KairosInsiderTransaction.classifyInsiderTransaction(ipsosFreeShares);
  assert.equal(result.eligiblePurchase, false);
  assert.equal(result.reason, 'grant');
});
