const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../assets/i18n.js'), 'utf8');
const detect = source.slice(source.indexOf('  function detectLang()'), source.indexOf('  let CURRENT_LANG'));
function resolve(search, stored) {
  const context = { SUPPORTED:['fr','en'], STORAGE_KEY:'lang', DEFAULT_LANG:'fr', URLSearchParams,
    localStorage:{getItem:()=>stored}, window:{location:{search}}, navigator:{language:'fr-FR'} };
  vm.createContext(context); vm.runInContext(detect, context); return context.detectLang();
}
test('shared language takes precedence over an old browser preference', () => {
  assert.equal(resolve('?lang=fr', 'en'), 'fr');
  assert.equal(resolve('?lang=en', 'fr'), 'en');
});
test('without a supported explicit language the saved preference still applies', () => {
  assert.equal(resolve('', 'en'), 'en'); assert.equal(resolve('?lang=unknown', 'en'), 'en');
});
