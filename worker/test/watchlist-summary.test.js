import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readWatchlistSummary} from '../src/watchlist-summary.js';

const NOW = Date.parse('2026-09-23T12:00:00Z');
function cache(records = {}) {
  const reads = [];
  return {reads, env: {CACHE: {
    async get(key, type) { assert.equal(type, 'json'); reads.push(key); return structuredClone(records[key] ?? null); },
    async put() { assert.fail('Summary must never write'); },
    async delete() { assert.fail('Summary must never delete'); },
    async list() { assert.fail('Summary must not enumerate KV'); },
  }}};
}
const key = ticker => `stock-analysis:v23:${ticker}:full:1y`;

test('summary reads only the current user watchlist and projects actual cached values with freshness', async () => {
  const {env, reads} = cache({
    'wl:alice': {tickers: ['AAPL']}, 'wl:bob': {tickers: ['MSFT']},
    [key('AAPL')]: {ticker:'AAPL', company:{name:'Apple Inc.'}, price:{current:250, changePct:0, currency:'USD', regularMarketTime:1758630600}, score:{total:0}, _cachedAt:NOW-1000},
  });
  const result = await readWatchlistSummary(env, 'alice', 'MSFT', NOW);
  assert.equal(result.ok,true); assert.equal(result.cacheOnly,true); assert.equal(result.exists,true);
  assert.equal(result.updatedAt,new Date(NOW).toISOString());
  assert.deepEqual(result.items,[{ticker:'AAPL',name:'Apple Inc.',price:250,currency:'USD',changePercent:0,quoteAt:new Date(1758630600000).toISOString(),cachedAt:new Date(NOW-1000).toISOString(),score:0,scoreAt:new Date(NOW-1000).toISOString(),latestInsider:null}]);
  assert.ok(!reads.includes('wl:bob')); assert.ok(!reads.some(k=>k.includes('MSFT')));
});

test('legacy symbols apply only when KV is absent, preserve empty lists, validate and bound reads', async () => {
  let h=cache({'wl:alice':{tickers:[]}});
  assert.deepEqual((await readWatchlistSummary(h.env,'alice','AAPL',NOW)).items,[]);
  assert.deepEqual(h.reads,['wl:alice']);
  h=cache();
  const query=['aapl','AAPL','MC.PA','../secret','TOO_LONG_SYMBOL',...Array.from({length:110},(_,i)=>'T'+i)].join(',');
  const result=await readWatchlistSummary(h.env,'alice',query,NOW);
  assert.equal(result.exists,false); assert.equal(result.items.length,100);
  assert.deepEqual(result.items.slice(0,2).map(i=>i.ticker),['AAPL','MC.PA']);
  assert.equal(h.reads.length,202); // One own watchlist, one feed, at most two stock reads per ticker.
  assert.ok(!h.reads.some(k=>k.includes('secret')));
});

test('missing/invalid numbers remain null, public cache fallback retains cache age without inventing quote time', async () => {
  const h=cache({'wl:alice':{tickers:['AAPL','MSFT']},
    'stock-analysis:v23:AAPL:pub:1y': {ticker:'AAPL',company:{name:'Apple'},price:{current:'',changePct:false},score:{total:'NaN'},_cachedAt:NOW-60000},
  });
  const {items}=await readWatchlistSummary(h.env,'alice','',NOW);
  assert.equal(items[0].cachedAt,new Date(NOW-60000).toISOString());
  for(const item of items) for(const field of ['price','currency','changePercent','quoteAt','score','scoreAt','latestInsider']) assert.equal(item[field],null,field);
  assert.equal(items[1].name,null); assert.equal(items[1].cachedAt,null);
});

test('latest disclosed purchase/sale respects publication date and region, ignoring future or unsupported movements', async () => {
  const h=cache({'wl:alice':{tickers:['SU','SU.PA','AAPL']},'insider-transactions':{transactions:[
    {ticker:'SU',source:'sec',type:'sell',fileDate:'2026-09-22',date:'2026-09-18',insider:'US Person',company:'Suncor',value:123,currency:'USD',sourceUrl:'https://www.sec.gov/a'},
    {ticker:'SU',source:'amf',type:'buy',fileDate:'2026-09-23',date:'2026-09-20',insider:'French Person',company:'Schneider',value:456,currency:'EUR'},
    {ticker:'SU',source:'sec',type:'buy',fileDate:'2026-09-24',insider:'Future'},
    {ticker:'SU',source:'sec',type:'option',fileDate:'2026-09-23',insider:'Option'},
    {ticker:'OTHER',yahooSymbol:'AAPL',source:'amf',type:'buy',fileDate:'2026-09-23',insider:'Explicit Yahoo'},
  ]}});
  const {items}=await readWatchlistSummary(h.env,'alice','',NOW);
  assert.equal(items[0].latestInsider.insider,'US Person'); assert.equal(items[0].latestInsider.sourceUrl,'https://www.sec.gov/a');
  assert.equal(items[1].latestInsider.insider,'French Person'); assert.equal(items[1].latestInsider.sourceUrl,null);
  assert.equal(items[2].latestInsider.insider,'Explicit Yahoo'); assert.equal(items[2].latestInsider.value,null);
});

test('no identity or malformed cache cannot expose a different listing', async () => {
  const h=cache({'wl:alice':{tickers:['AAPL']},[key('AAPL')]:{ticker:'MSFT',price:{current:100},score:{total:70}}});
  await assert.rejects(readWatchlistSummary(h.env,'','AAPL',NOW),/identity/);
  const {items}=await readWatchlistSummary(h.env,'alice','',NOW);
  assert.equal(items[0].price,null); assert.equal(items[0].score,null);
});

test('HTTP route requires Firebase identity, accepts free users, cannot select another uid, and has no analysis or writes', async t => {
  const {build}=await import('esbuild');
  const {fileURLToPath}=await import('node:url');
  const bundle=await build({entryPoints:[fileURLToPath(new URL('../src/index.js',import.meta.url))],bundle:true,format:'esm',platform:'neutral',target:'es2022',write:false,loader:{'.md':'text','.wasm':'binary','.ttf':'binary'},logLevel:'silent'});
  const {default:worker}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  const h=cache({'wl:alice':{tickers:['AAPL']},'wl:bob':{tickers:['MSFT']}}),network=[];
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    network.push(String(url));
    assert.match(String(url),/^https:\/\/identitytoolkit.googleapis.com\//);
    return new Response(JSON.stringify(JSON.parse(init.body).idToken==='alice-token'?{users:[{localId:'alice',email:'alice@example.com',emailVerified:true}]}:{users:[]}));
  });
  const env={...h.env,FIREBASE_API_KEY:'test',ALLOWED_ORIGIN:'https://kairosinsider.fr'};
  const request=token=>worker.fetch(new Request('https://kairosinsider.fr/api/watchlist/summary?uid=bob&symbols=MSFT',{
    headers:{Origin:env.ALLOWED_ORIGIN,...(token?{Authorization:'Bearer '+token}:{})},
  }),env,{waitUntil(){assert.fail('Summary cannot start background work');}});
  assert.equal((await request()).status,401); assert.equal(h.reads.length,0);
  assert.equal((await request('invalid')).status,401); assert.equal(h.reads.length,0);
  const response=await request('alice-token');
  assert.equal(response.status,200); assert.equal(response.headers.get('Cache-Control'),'private, no-store');
  assert.deepEqual((await response.json()).items.map(i=>i.ticker),['AAPL']);
  assert.ok(h.reads.every(k=>k==='wl:alice'||k==='insider-transactions'||k.startsWith('stock-analysis:v23:AAPL:')));
  assert.equal(network.length,2); // Authentication only, never prices, subscriptions, email or Telegram.
});
