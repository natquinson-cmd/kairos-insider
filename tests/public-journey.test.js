const test = require('node:test');
const assert = require('node:assert/strict');

const journey = require('../assets/public-journey.js');

test('analysis URL opens the selected ticker in the dashboard and keeps English', () => {
  assert.equal(
    journey.dashboardAnalysisUrl('air.pa', 'en'),
    'dashboard.html?lang=en#stockAnalysis?t=AIR.PA'
  );
});

test('analysis URL sanitizes ticker input and defaults to French', () => {
  assert.equal(
    journey.dashboardAnalysisUrl(' aapl<script> ', 'de'),
    'dashboard.html?lang=fr#stockAnalysis?t=AAPLSCRIPT'
  );
});

test('analysis URL supports an absolute public base for server-rendered pages', () => {
  assert.equal(
    journey.dashboardAnalysisUrl('AAPL', 'fr', 'https://kairosinsider.fr/'),
    'https://kairosinsider.fr/dashboard.html?lang=fr#stockAnalysis?t=AAPL'
  );
});

test('mobile menu button exposes its open state and closes after navigation', () => {
  const listeners = {};
  const classes = new Set();
  const links = [{ addEventListener(type, callback) { listeners.link = callback; } }];
  const menu = {
    querySelectorAll() { return links; },
    classList: {
      toggle(name, force) { force ? classes.add(name) : classes.delete(name); },
      remove(name) { classes.delete(name); },
    },
  };
  const button = {
    attrs: {},
    addEventListener(type, callback) { listeners.button = callback; },
    setAttribute(name, value) { this.attrs[name] = value; },
  };
  const doc = {
    getElementById(id) { return id === 'navMenuToggle' ? button : menu; },
    addEventListener(type, callback) { listeners.document = callback; },
  };

  journey.initMobileMenu(doc);
  listeners.button();
  assert.equal(button.attrs['aria-expanded'], 'true');
  assert.equal(classes.has('is-open'), true);

  listeners.link();
  assert.equal(button.attrs['aria-expanded'], 'false');
  assert.equal(classes.has('is-open'), false);
});

test('Escape closes the mobile menu and restores focus to its button', () => {
  const listeners = {};
  const classes = new Set(['is-open']);
  const menu = {
    querySelectorAll() { return []; },
    classList: { toggle(name, force) { force ? classes.add(name) : classes.delete(name); } },
  };
  const button = {
    attrs: { 'aria-expanded': 'true' }, focused: false,
    addEventListener(type, callback) { listeners.button = callback; },
    setAttribute(name, value) { this.attrs[name] = value; },
    getAttribute(name) { return this.attrs[name]; },
    focus() { this.focused = true; },
  };
  const doc = {
    getElementById(id) { return id === 'navMenuToggle' ? button : menu; },
    addEventListener(type, callback) { listeners.document = callback; },
  };

  journey.initMobileMenu(doc);
  listeners.document({ key: 'Escape' });
  assert.equal(button.attrs['aria-expanded'], 'false');
  assert.equal(classes.has('is-open'), false);
  assert.equal(button.focused, true);
});

test('dashboard links retain language without changing query or hash state', () => {
  assert.equal(
    journey.withLang('dashboard.html?plan=pro&billing=yearly#pricing', 'en'),
    'dashboard.html?plan=pro&billing=yearly&lang=en#pricing'
  );
});

test('pricing links retain the Pro billing cycle and selected language', () => {
  assert.equal(
    journey.pricingUrl('pro', 'yearly', 'en'),
    'dashboard.html?plan=pro&billing=yearly&lang=en'
  );
});

test('an old Elite pricing link returns to current offers without starting a Pro checkout', () => {
  assert.equal(journey.pricingUrl('elite', 'yearly', 'en'), 'index.html?lang=en#pricing');
});
