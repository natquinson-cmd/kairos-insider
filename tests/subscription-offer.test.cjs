const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const worker = fs.readFileSync(path.join(__dirname, '../worker/src/index.js'), 'utf8').replace(/\r\n/g, '\n');
const dashboard = fs.readFileSync(path.join(__dirname, '../dashboard.html'), 'utf8').replace(/\r\n/g, '\n');

function between(source, start, end) {
  const begin = source.indexOf(start);
  const finish = source.indexOf(end, begin);
  assert.ok(begin >= 0 && finish > begin, `Missing source boundary: ${start}`);
  return source.slice(begin, finish);
}

function checkoutHarness(overrides = {}) {
  const stripeRequests = [];
  const context = {
    Response, URLSearchParams, console,
    log: { info() {}, warn() {} },
    fetch: async (url, options) => {
      stripeRequests.push({ url, params: new URLSearchParams(options.body) });
      return Response.json({ id: 'cs_test_subscription' });
    },
  };
  vm.createContext(context);
  vm.runInContext(
    between(worker, 'function resolveStripePlan(', 'async function verifyStripeSignature(') +
    between(worker, 'function corsHeaders(', '// ADMIN HANDLERS'), context,
  );
  const env = {
    ALLOWED_ORIGIN: 'https://kairosinsider.fr', STRIPE_SECRET_KEY: 'test-only',
    STRIPE_PRICE_ID_PRO_MONTHLY: 'price_pro_monthly', STRIPE_PRICE_ID_PRO_ANNUAL: 'price_pro_annual',
    STRIPE_PRICE_ID_ELITE_MONTHLY: 'price_elite_monthly', STRIPE_PRICE_ID_ELITE_ANNUAL: 'price_elite_annual',
    STRIPE_PRICE_ID: 'price_legacy', CACHE: { async get() { return null; } }, ...overrides,
  };
  return {
    env, stripeRequests,
    resolve: (price, metadata) => context.resolveStripePlan(price, metadata, env),
    checkout: (body) => context.handleCreateCheckout(
      new Request('https://api.invalid/stripe/create-checkout', { method: 'POST', body: JSON.stringify(body) }),
      env, { uid: 'user-test', email: 'user@example.invalid' }, 'https://kairosinsider.fr',
    ),
  };
}

test('retired Elite checkout is refused in either language before contacting Stripe', async () => {
  for (const [lang, message] of [['fr', /plus disponible/], ['en', /no longer available/]]) {
    for (const billing of ['monthly', 'yearly']) {
      const h = checkoutHarness();
      const response = await h.checkout({ plan: billing === 'yearly' ? ' Elite ' : 'elite', billing, lang });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.code, 'PLAN_UNAVAILABLE');
      assert.match(body.error, message);
      assert.equal(h.stripeRequests.length, 0);
    }
  }
});

test('Pro checkout uses the chosen monthly or annual price with matching subscription metadata', async () => {
  for (const [billing, price] of [['monthly', 'price_pro_monthly'], ['yearly', 'price_pro_annual']]) {
    const h = checkoutHarness();
    const response = await h.checkout({ plan: 'pro', billing });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).sessionId, 'cs_test_subscription');
    assert.equal(h.stripeRequests.length, 1);
    assert.equal(h.stripeRequests[0].url, 'https://api.stripe.com/v1/checkout/sessions');
    const params = h.stripeRequests[0].params;
    assert.equal(params.get('line_items[0][price]'), price);
    assert.equal(params.get('subscription_data[metadata][plan]'), 'pro');
    assert.equal(params.get('subscription_data[metadata][billing]'), billing);
    assert.equal(params.get('client_reference_id'), 'user-test');
  }
});

test('missing Pro price never creates a checkout at the old Premium price', async () => {
  const h = checkoutHarness({ STRIPE_PRICE_ID_PRO_ANNUAL: undefined });
  const response = await h.checkout({ plan: 'pro', billing: 'yearly' });
  assert.equal((await response.json()).code, 'PRICE_NOT_CONFIGURED');
  assert.equal(h.stripeRequests.length, 0);
});

test('existing Elite and legacy subscriptions retain their plan when resolved from Stripe', () => {
  const h = checkoutHarness();
  for (const [price, plan, billing] of [
    ['price_elite_monthly', 'elite', 'monthly'], ['price_elite_annual', 'elite', 'yearly'],
    ['price_legacy', 'legacy', 'monthly'],
  ]) {
    const resolved = h.resolve(price, {});
    assert.equal(resolved.plan, plan);
    assert.equal(resolved.billing, billing);
  }
  assert.equal(h.resolve('archived_other_price', { plan: 'elite', billing: 'yearly' }).plan, 'elite');
});

function storage(values = {}) {
  const data = new Map(Object.entries(values));
  return { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: k => data.delete(k) };
}

test('Telegram linking accepts Pro and existing paid plans, but refuses free or cancelled access', async () => {
  for (const [plan, status, expected] of [
    ['pro', 'active', 200], ['pro', 'past_due', 200], ['elite', 'active', 200],
    ['legacy', 'active', 200], ['free', null, 403], ['pro', 'canceled', 403],
  ]) {
    const writes = [];
    const env = { ALLOWED_ORIGIN: 'https://kairosinsider.fr', CACHE: {
      get: async key => key === 'sub:user-test' && status ? { plan, status, priceId: 'archived_test_price' } : null,
      put: async (key, value) => writes.push({ key, value }),
    } };
    const context = { Response, isAdmin: () => false, generateLinkCode: () => 'KAIROS-TEST',
      log: { info() {} },
    };
    vm.createContext(context);
    vm.runInContext(
      between(worker, 'function resolveStripePlan(', 'async function handleCreateCheckout(') +
      between(worker, 'async function getCompPremium(', 'async function handleTelegramStatus(') +
      between(worker, 'function corsHeaders(', '// ADMIN HANDLERS'), context,
    );
    const response = await context.handleTelegramInitLink(env, { uid: 'user-test' }, 'https://kairosinsider.fr');
    assert.equal(response.status, expected, `${plan}/${status}`);
    assert.equal(writes.length, expected === 200 ? 1 : 0);
    const body = await response.json();
    if (expected === 403) {
      assert.equal(body.code, 'PREMIUM_REQUIRED');
      assert.equal(body.requiredPlan, 'pro');
    } else {
      assert.match(body.deepLink, /^https:\/\/t\.me\//);
    }
  }
});

test('old Elite URLs and saved purchase intents never silently start a Pro payment', () => {
  const initializer = between(dashboard, '(function initPlanBillingFromUrl()', '\n\n    // Retire l\'overlay');
  for (const [search, values] of [
    ['?plan=elite&billing=yearly', {}],
    ['', { kairos_plan: 'elite', kairos_auto_checkout: '1' }],
  ]) {
    const localStorage = storage(values);
    const sessionStorage = storage();
    const notice = { hidden: true };
    const context = {
      URL, localStorage, sessionStorage,
      window: { location: { href: `https://kairosinsider.fr/dashboard.html${search}` }, history: { replaceState() {} } },
      document: { getElementById: () => notice, documentElement: { classList: { add() {} } } },
    };
    vm.runInNewContext(initializer, context);
    assert.equal(localStorage.getItem('kairos_auto_checkout'), null);
    assert.equal(localStorage.getItem('kairos_plan'), 'pro');
    assert.equal(notice.hidden, false);
  }
});
