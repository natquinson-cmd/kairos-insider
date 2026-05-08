// Quick SVG -> PNG via @resvg/resvg-wasm (already installed in worker/node_modules).
import { readFileSync, writeFileSync } from 'node:fs';
import { initWasm, Resvg } from '../worker/node_modules/@resvg/resvg-wasm/index.mjs';

const wasmPath = new URL(
  '../worker/node_modules/@resvg/resvg-wasm/index_bg.wasm',
  import.meta.url,
);
await initWasm(readFileSync(wasmPath));

const inputName = process.argv[2] || 'article-header';
const svg = readFileSync(new URL(`./${inputName}.svg`, import.meta.url), 'utf8');
const fontReg = readFileSync(new URL('../worker/fonts/Inter-Regular.ttf', import.meta.url));
const fontBold = readFileSync(new URL('../worker/fonts/Inter-Bold.ttf', import.meta.url));
const renderer = new Resvg(svg, {
  fitTo: { mode: 'original' },
  font: {
    fontBuffers: [fontReg, fontBold],
    defaultFontFamily: 'Inter',
    loadSystemFonts: false,
  },
});
const pngBuffer = renderer.render().asPng();
writeFileSync(new URL(`./${inputName}.png`, import.meta.url), pngBuffer);
console.log('OK', pngBuffer.length, 'bytes');
