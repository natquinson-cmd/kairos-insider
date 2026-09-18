const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../dashboard.html'), 'utf8').replace(/\r\n/g, '\n');

test('alerts and their old URL use the Pro gate; retired backtests return home', () => {
  const start = source.indexOf('function switchSection(');
  const end = source.indexOf('// Navigation autorisee', start);
  const gate = source.slice(start, end) + 'return section; }';
  const buttons = [...source.matchAll(/<button\b[^>]*data-section="([^"]+)"[^>]*>/g)];
  const nodes = new Map(buttons.map(([tag, section]) => [section, {
    dataset: { premium: tag.includes('data-premium="true"') ? 'true' : undefined,
      elite: tag.includes('data-elite="true"') ? 'true' : undefined },
  }]));
  assert.ok(nodes.has('alerts'));
  assert.ok(!nodes.has('eliteBacktests'));
  assert.ok(!source.includes('id="section-eliteBacktests"'));
  assert.ok(!source.includes('data-i18n="dash.sidebar.elite_section"'));
  for (const plan of ['free', 'pro', 'legacy', 'elite']) {
    let paywalls = 0;
    const context = { isPremium: plan !== 'free', window: { _currentPlan: plan }, HUB_PARENT: {},
      _pendingGatedSection: null, Toast: { info() {} }, t: (_key, fallback) => fallback,
      document: {
        getElementById: id => id === 'paywallOverlay' ? { classList: { remove() { paywalls++; } } } : null,
        querySelector: selector => nodes.get(selector.match(/data-section="([^"]+)"/)[1]),
      },
    };
    vm.createContext(context);
    vm.runInContext(gate, context);
    for (const route of ['alerts', 'eliteAlerts']) {
      assert.equal(context.switchSection(route), plan === 'free' ? undefined : 'alerts');
    }
    assert.equal(paywalls, plan === 'free' ? 2 : 0);
    assert.equal(context.switchSection('eliteBacktests'), 'home');
  }
});

test('checkout retries preserve annual billing when its price is unavailable', async () => {
  const start = source.indexOf('async function startCheckout(');
  const end = source.indexOf('// API fetch avec Firebase ID token', start);
  let billing = 'yearly';
  const attempts = [];
  const button = { textContent: 'Souscrire — 190€/an', disabled: false };
  const context = { document: { getElementById: () => button },
    window: {}, getBillingPreference: () => billing, getPlanPreference: () => 'pro',
    localStorage: { setItem: (key, value) => { if (key === 'kairos_billing') billing = value; } },
    apiFetch: async (_url, body) => { attempts.push(body.billing); return { error: 'Missing price', code: 'PRICE_NOT_CONFIGURED' }; },
    Toast: { warning() {}, error() {} }, t: (_key, fallback) => fallback,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  await context.startCheckout();
  await context.startCheckout();
  assert.deepEqual(attempts, ['yearly', 'yearly']);
  assert.equal(button.textContent, 'Souscrire — 190€/an');
  assert.equal(button.disabled, false);
});
