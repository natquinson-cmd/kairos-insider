import {test, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readWatchlistSummary} from '../src/watchlist-summary.js';
import {STOCK_ANALYSIS_VERSION as VERSION} from '../src/watchlist-market-data.js';

const NOW = Date.parse('2026-09-23T12:00:00Z');
beforeEach(t => t.mock.method(globalThis, 'fetch', async () => new Response('{}', {status: 503})));
function cache(records = {}) {
  const reads = [], writes=[];
  return {reads, writes, env: {CACHE: {
    async get(key, type) { assert.equal(type, 'json'); reads.push(key); return structuredClone(records[key] ?? null); },
    async put(key,value) { assert.match(key,/^watchlist-quote:v1:/,'Only public quote cache writes are permitted'); writes.push(key); records[key]=JSON.parse(value); },
    async delete() { assert.fail('Summary must never delete'); },
    async list() { assert.fail('Summary must not enumerate KV'); },
  }}};
}
const key = ticker => `stock-analysis:${VERSION}:${ticker}:full:1y`;

async function withScoreHistory(t, env, rows = []) {
  const {DatabaseSync} = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE score_history (ticker TEXT, date TEXT, total INTEGER)');
  for (const row of rows) db.prepare('INSERT INTO score_history VALUES (?, ?, ?)').run(row.ticker, row.date, row.total);
  const queries = [];
  env.HISTORY = {prepare(sql) {
    assert.match(sql, /^\s*SELECT\b/i, 'Watchlist history is read-only');
    return {bind(...args) { return {async all() {
      queries.push({sql, args});
      assert.ok(args.length <= 100, 'Stay below D1 bound-parameter limit');
      return {results: db.prepare(sql).all(...args)};
    }}; }};
  }};
  return queries;
}

test('missing analysis scores automatically use dated recent history without replacing current-method scores', async t => {
  const h=cache({'wl:alice':{tickers:['NVDA','AVGO','MSFT','ASML.AS']},
    [key('NVDA')]:{ticker:'NVDA',score:{total:78},_cachedAt:NOW-1000},
  });
  const queries=await withScoreHistory(t,h.env,[
    {ticker:'NVDA',total:50,date:'2026-09-23'},
    {ticker:'AVGO',total:70,date:'2026-09-20'}, {ticker:'AVGO',total:74,date:'2026-09-22'},
    {ticker:'MSFT',total:69,date:'2026-09-23'}, {ticker:'ASML.AS',total:75,date:'2026-09-21'},
  ]);
  const {items}=await readWatchlistSummary(h.env,'alice','',NOW);
  assert.deepEqual(items.map(row=>row.score),[78,74,69,75]);
  assert.equal(items[0].scoreStatus,'available');
  assert.equal(items[1].scoreSource,'history');
  assert.equal(items[1].scoreStatus,'historical');
  assert.equal(items[1].scoreAt,'2026-09-22T00:00:00.000Z');
  assert.equal(items[1].cachedAt,null);
  assert.equal(queries.length,1);
});

test('archived scores need a real recent date and valid value, and never leak another watchlist or listing', async t => {
  const tickers=['AVGO','MSFT','ASML.AS','OLD','FUTURE','BAD','ZERO','TOOHIGH'];
  const h=cache({'wl:alice':{tickers},'wl:bob':{tickers:['PRIVATE']}});
  await withScoreHistory(t,h.env,[
    {ticker:'AVGO',total:74,date:null},{ticker:'MSFT',total:69,date:''},
    {ticker:'ASML',total:75,date:'2026-09-23'}, {ticker:'PRIVATE',total:99,date:'2026-09-23'},
    {ticker:'OLD',total:72,date:'2026-09-16'},{ticker:'FUTURE',total:72,date:'2026-09-24'},
    {ticker:'BAD',total:72,date:'2026-09-22-invalid'}, {ticker:'ZERO',total:0,date:'2026-09-23'},
    {ticker:'TOOHIGH',total:101,date:'2026-09-23'},
  ]);
  const {items}=await readWatchlistSummary(h.env,'alice','PRIVATE',NOW);
  assert.deepEqual(items.map(row=>row.ticker),tickers);
  for(const row of items.filter(row=>row.ticker!=='ZERO')){
    assert.equal(row.score,null,row.ticker); assert.equal(row.scoreAt,null,row.ticker);
    assert.equal(row.scoreStatus,'unavailable',row.ticker);
  }
  assert.equal(items.find(row=>row.ticker==='ZERO').score,0);
  assert.equal(items.find(row=>row.ticker==='ZERO').scoreStatus,'historical');
});

test('historical score reads are bounded for a large watchlist and a D1 outage preserves other data', async t => {
  const tickers=Array.from({length:100},(_,i)=>'T'+i),h=cache({'wl:alice':{tickers}});
  const queries=await withScoreHistory(t,h.env,tickers.map(ticker=>({ticker,total:70,date:'2026-09-23'})));
  const {items}=await readWatchlistSummary(h.env,'alice','',NOW);
  assert.equal(items.at(-1).score,70); assert.equal(queries.length,2);
  h.env.HISTORY={prepare(){throw Error('D1 unavailable');}};
  const failed=await readWatchlistSummary(h.env,'alice','',NOW);
  assert.equal(failed.items.length,100); assert.equal(failed.items[0].score,null);
});
test('expired analysis cache does not hide the watchlist quote and daily movement', async t => {
  const h=cache({'wl:alice':{tickers:['NVDA']}}), requests=[];
  t.mock.method(globalThis,'fetch',async url=>{
    requests.push(String(url));
    return new Response(JSON.stringify({chart:{result:[{meta:{symbol:'NVDA',longName:'NVIDIA Corporation',currency:'USD',regularMarketPrice:120,regularMarketTime:NOW/1000,previousClose:100},timestamp:[(NOW-86400000)/1000,NOW/1000],indicators:{quote:[{close:[100,120]}]}}]}}));
  });
  const {items}=await readWatchlistSummary(h.env,'alice','',NOW);
  assert.equal(items[0].price,120); assert.equal(items[0].changePercent,20);
  assert.equal(items[0].name,'NVIDIA Corporation'); assert.equal(items[0].quoteAt,new Date(NOW).toISOString());
  assert.equal(items[0].score,null); // No implicit analysis, invented score or quota use.
  assert.equal(requests.length,1); assert.match(requests[0],/query1\.finance\.yahoo\.com\/v8\/finance\/chart\/NVDA\?/);
});

test('durable current-method score survives analysis expiry, without accepting an old-method score', async () => {
  const h=cache({'wl:alice':{tickers:['NVDA','MSFT']},
    [`stock-summary:${VERSION}:NVDA`]:{ticker:'NVDA',company:{name:'NVIDIA'},score:{total:72},_cachedAt:NOW-86400000},
    'stock-summary:v24:MSFT':{ticker:'MSFT',score:{total:99},_cachedAt:NOW-86400000},
  });
  const {items}=await readWatchlistSummary(h.env,'alice','',NOW);
  assert.equal(items[0].score,72); assert.equal(items[0].scoreAt,new Date(NOW-86400000).toISOString());
  assert.equal(items[1].score,null);
});
test('a full analysis with no supported score dimension cannot reappear as a current score',async()=>{
 const h=cache({'wl:alice':{tickers:['EMPTY']},[key('EMPTY')]:{ticker:'EMPTY',score:{total:55,breakdown:{insider:{dataOk:false},momentum:{dataOk:false}}},_cachedAt:NOW-1000}});
 const {items}=await readWatchlistSummary(h.env,'alice','',NOW);assert.equal(items[0].score,null);assert.equal(items[0].scoreStatus,'unavailable');
});
test('fresh cached entries do not prevent refreshing later watchlist symbols beyond position fifty',async t=>{
 const tickers=Array.from({length:64},(_,i)=>'T'+i),records={'wl:alice':{tickers}},requests=[];
 tickers.slice(0,48).forEach(ticker=>{records['watchlist-quote:v1:'+ticker]={ticker,price:{current:111,currency:'USD',regularMarketTime:NOW/1000},_quoteFetchedAt:NOW};});
 t.mock.method(globalThis,'fetch',async url=>{const ticker=new URL(url).pathname.split('/').at(-1);requests.push(ticker);return new Response(JSON.stringify({chart:{result:[{meta:{symbol:ticker,regularMarketPrice:120,currency:'USD',regularMarketTime:NOW/1000,regularMarketPreviousClose:100}}]}}));});
 const {items}=await readWatchlistSummary(cache(records).env,'alice','',NOW);
 assert.equal(items.at(-1).price,120);assert.equal(requests.length,16);
 assert.equal(items[0].price,111);
});
test('three-month curve keeps dated positive observations, excludes future/old data and computes actual period change',async()=>{
 const h=cache({'wl:alice':{tickers:['AAPL']},[key('AAPL')]:{ticker:'AAPL',chart:{points:[{date:'2026-09-22',close:120},{date:'2026-06-23',close:100},{date:'2026-06-22',close:20},{date:'2026-09-24',close:999},{date:'2026-07-01',close:null},{date:'2026-07-02',close:-1}]}}});
 const {items}=await readWatchlistSummary(h.env,'alice','',NOW);assert.deepEqual(items[0].sparkline3m.points,[{date:'2026-06-23',close:100},{date:'2026-09-22',close:120}]);assert.ok(Math.abs(items[0].sparkline3m.changePercent-20)<1e-8);assert.equal(items[0].sparkline3m.partial,false);
});

test('activity response is bounded and discloses truncation without losing its true count',async()=>{
 const transactions=Array.from({length:205},(_,i)=>({ticker:'AAPL',source:'sec',type:'buy',fileDate:'2026-09-23',insider:'Buyer '+i}));
 const h=cache({'wl:alice':{tickers:['AAPL']},'insider-transactions':{transactions}});
 const r=await readWatchlistSummary(h.env,'alice','',NOW);assert.equal(r.activity.events.length,200);assert.equal(r.activity.total,205);assert.equal(r.activity.truncated,true);
});

test('activity is personal, deduplicated and limited by publication date, with missing feed distinguished from no movement',async()=>{
 const event={ticker:'AAPL',source:'sec',type:'buy',fileDate:'2026-09-23',date:'2026-09-18',insider:'Buyer',value:1200,currency:'USD',sourceUrl:'https://www.sec.gov/filing'};
 const h=cache({'wl:alice':{tickers:['AAPL']},'insider-transactions':{transactions:[event,event,{...event,type:'sell',insider:'Seller'},{...event,ticker:'MSFT'},{...event,fileDate:'2026-07-01'},{...event,fileDate:'2026-09-24'}]}});
 const r=await readWatchlistSummary(h.env,'alice','',NOW);assert.equal(r.activity.available,true);assert.equal(r.activity.total,2);assert.equal(r.activity.events.length,2);assert.equal(r.activity.events[0].tradeDate,'2026-09-18');assert.equal(r.activity.events[0].sourceUrl,'https://www.sec.gov/filing');assert.equal(r.activity.truncated,false);
 const missing=await readWatchlistSummary(cache({'wl:alice':{tickers:['AAPL']}}).env,'alice','',NOW);assert.equal(missing.activity.available,false);
});

test('summary reads only the current user watchlist and projects actual cached values with freshness', async () => {
  const {env, reads} = cache({
    'wl:alice': {tickers: ['AAPL']}, 'wl:bob': {tickers: ['MSFT']},
    [key('AAPL')]: {ticker:'AAPL', company:{name:'Apple Inc.'}, price:{current:250, changePct:0, currency:'USD', regularMarketTime:1758630600}, score:{total:0}, _cachedAt:NOW-1000},
  });
  const result = await readWatchlistSummary(env, 'alice', 'MSFT', NOW);
  assert.equal(result.ok,true); assert.equal(result.cacheOnly,false); assert.equal(result.analysisCacheOnly,true); assert.equal(result.exists,true);
  assert.equal(result.updatedAt,new Date(NOW).toISOString());
  assert.deepEqual(result.items,[{ticker:'AAPL',name:'Apple Inc.',price:250,currency:'USD',changePercent:0,quoteAt:new Date(1758630600000).toISOString(),quoteFetchedAt:new Date(NOW-1000).toISOString(),quoteStatus:'stale',cachedAt:new Date(NOW-1000).toISOString(),score:0,scoreAt:new Date(NOW-1000).toISOString(),scoreStatus:'available',latestInsider:null,sparkline3m:null}]);
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
  assert.equal(h.reads.length,402); // Own list/feed, two analyses, durable score and lightweight quote per ticker.
  assert.ok(!h.reads.some(k=>k.includes('secret')));
});

test('missing/invalid numbers remain null, public cache fallback retains cache age without inventing quote time', async () => {
  const h=cache({'wl:alice':{tickers:['AAPL','MSFT']},
    [`stock-analysis:${VERSION}:AAPL:pub:1y`]: {ticker:'AAPL',company:{name:'Apple'},price:{current:'',changePct:false},score:{total:'NaN'},_cachedAt:NOW-60000},
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

test('HTTP route requires Firebase identity, accepts free users, cannot select another uid, and never analyses or mutates personal state', async t => {
  const {build}=await import('esbuild');
  const {fileURLToPath}=await import('node:url');
  const bundle=await build({entryPoints:[fileURLToPath(new URL('../src/index.js',import.meta.url))],bundle:true,format:'esm',platform:'neutral',target:'es2022',write:false,loader:{'.md':'text','.wasm':'binary','.ttf':'binary'},logLevel:'silent'});
  const {default:worker}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  const h=cache({'wl:alice':{tickers:['AAPL']},'wl:bob':{tickers:['MSFT']}}),network=[];
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    network.push(String(url));
    if(String(url).startsWith('https://query1.finance.yahoo.com/v8/finance/chart/AAPL?')) return new Response('{}',{status:503});
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
  assert.ok(h.reads.every(k=>k==='wl:alice'||k==='insider-transactions'||k.startsWith(`stock-analysis:${VERSION}:AAPL:`)||k===`stock-summary:${VERSION}:AAPL`||k==='watchlist-quote:v1:AAPL'));
  assert.equal(network.length,3); // Authentication and AAPL quote only, never another list or analysis, email or Telegram.
  assert.deepEqual(h.writes,['watchlist-quote:v1:AAPL']);
});
