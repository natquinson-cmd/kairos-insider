import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

test('bundled Worker loads shared browser helpers and serves a preflight without external access', async () => {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
    bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', write: false,
    // OG initialization is lazy; this smoke test does not exercise image rendering.
    loader: { '.md': 'text', '.wasm': 'binary', '.ttf': 'binary' },
    logLevel: 'silent',
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Unexpected external request'); };
  try {
    const module = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
    const response = await module.default.fetch(
      new Request('https://local.invalid/api/stock-analysis', { method: 'OPTIONS' }), {}, {},
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Access-Control-Allow-Methods'), /GET/);
    for (const endpoint of ['whoami', 'users', 'score-weights']) {
      const denied = await module.default.fetch(
        new Request('https://local.invalid/api/admin/' + endpoint), {}, {},
      );
      assert.ok([401, 403].includes(denied.status), `Anonymous ${endpoint} must be denied`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
