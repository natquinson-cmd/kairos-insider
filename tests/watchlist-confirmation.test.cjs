const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dashboard = fs.readFileSync(path.join(__dirname, '..', 'admin-workspace.html'), 'utf8').replace(/\r\n/g, '\n');
const match = dashboard.match(/async function resendWatchlistConfirmation\(\) \{[\s\S]*?\n    \}\n\n    function renderWatchlist/);
assert.ok(match, 'resendWatchlistConfirmation must remain extractable from dashboard.html');
const functionSource = match[0].replace(/\n\n    function renderWatchlist$/, '');

function harness({ response, user = { id: 'user-1' }, state = {}, apiImpl } = {}) {
  const button = { disabled: false };
  const message = { textContent: '' };
  const calls = [];
  const context = {
    currentUser: user,
    watchlistState: {
      tickers: ['AAPL', 'MC.PA'],
      emailAlerts: true,
      optIn: false,
      types: { cluster: true, activist: false },
      ...state,
    },
    document: {
      getElementById(id) {
        return id === 'wlResendConfirmation' ? button : id === 'wlConfirmationMsg' ? message : null;
      },
    },
    window: { KairosI18n: { getLang: () => 'fr' } },
    renderWatchlist() {},
    async apiFetch(...args) {
      calls.push(args);
      return apiImpl ? apiImpl(...args) : response;
    },
  };
  vm.createContext(context);
  vm.runInContext(`${functionSource}; this.resendWatchlistConfirmation = resendWatchlistConfirmation;`, context);
  return { ...context, button, message, calls };
}

test('sent response preserves tickers and event types and reports delivery', async () => {
  const h = harness({ response: { ok: true, confirmationSent: true } });
  await h.resendWatchlistConfirmation();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], '/api/watchlist/sync');
  assert.equal(h.calls[0][2], 'POST');
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0][1])), {
    tickers: ['AAPL', 'MC.PA'], emailAlerts: true, types: { cluster: true, activist: false },
  });
  assert.match(h.message.textContent, /Lien envoyé/);
  assert.equal(h.button.disabled, false);
});

test('cooldown response never reports success and makes no second request', async () => {
  const h = harness({ response: { ok: true, confirmationSent: false } });
  await h.resendWatchlistConfirmation();
  assert.equal(h.calls.length, 1);
  assert.doesNotMatch(h.message.textContent, /Lien envoyé/);
  assert.match(h.message.textContent, /Aucun nouvel email envoyé/);
});

test('failed response reports failure and restores the button', async () => {
  const h = harness({ response: { ok: false } });
  await h.resendWatchlistConfirmation();
  assert.equal(h.calls.length, 1);
  assert.match(h.message.textContent, /Impossible d’envoyer/);
  assert.equal(h.button.disabled, false);
});

test('guards skip the network for missing user, disabled alerts, confirmed state, and disabled button', async () => {
  const cases = [
    { user: null },
    { state: { emailAlerts: false } },
    { state: { optIn: true } },
    { setup: h => { h.button.disabled = true; } },
  ];
  for (const item of cases) {
    const h = harness(item);
    item.setup?.(h);
    await h.resendWatchlistConfirmation();
    assert.equal(h.calls.length, 0);
  }
});

test('empty watchlist explains the prerequisite without a network request', async () => {
  const h = harness({ state: { tickers: [] } });
  await h.resendWatchlistConfirmation();
  assert.equal(h.calls.length, 0);
  assert.match(h.message.textContent, /Ajoutez d’abord un ticker/);
});

test('a second click while the first request is pending is ignored', async () => {
  let resolveRequest;
  const pending = new Promise(resolve => { resolveRequest = resolve; });
  const h = harness({ apiImpl: () => pending });
  const first = h.resendWatchlistConfirmation();
  const second = h.resendWatchlistConfirmation();
  assert.equal(h.button.disabled, true);
  assert.equal(h.calls.length, 1);
  resolveRequest({ ok: true, confirmationSent: true });
  await Promise.all([first, second]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.button.disabled, false);
});
