import {test} from 'node:test';
import assert from 'node:assert/strict';
import {refreshWatchlistScore} from '../src/watchlist-summary.js';
import {STOCK_ANALYSIS_VERSION as VERSION} from '../src/watchlist-market-data.js';

const NOW=Date.now();
function fixture(tickers=['AVGO'],uid='alice') {
  const records=new Map([[`wl:${uid}`,{tickers}]]),writes=[];
  return {records,writes,env:{CACHE:{async get(key){return structuredClone(records.get(key)||null);},async put(key,value){assert.match(key,/^(stock-summary:|watchlist-score-refresh:)/);writes.push(key);records.set(key,JSON.parse(value));}}}};
}
const analysis=(ticker,total=74)=>({ticker,score:{total,breakdown:{momentum:{dataOk:true}}},price:{current:123,currency:'USD'},_cachedAt:Date.now(),company:{name:ticker}});
test('a saved watchlist gets a real current score without a stock-page quota or personal writes',async()=>{
 const h=fixture();let calls=0;
 const result=await refreshWatchlistScore(h.env,'alice','AVGO',async(ticker,env,options)=>{calls++;assert.equal(ticker,'AVGO');assert.equal(env,h.env);assert.deepEqual(options,{publicView:false,chartRange:'1y'});return analysis(ticker);});
 assert.equal(result.status,200);assert.equal(result.body.ok,true);assert.equal(result.body.item.score,74);
 assert.equal(result.body.item.scoreStatus,'available');assert.equal(result.body.item.scoreSource,'analysis');assert.equal(result.body.item.scoreVersion,VERSION);
 assert.ok(result.body.item.scoreAt);assert.equal(calls,1);assert.ok(h.records.has(`stock-summary:${VERSION}:AVGO`));
 const second=await refreshWatchlistScore(h.env,'alice','AVGO',()=>assert.fail('Fresh score must be reused'));
 assert.equal(second.body.item.score,74);
});
test('score calculation requires the authenticated saved membership and exact validated listing',async()=>{
 const h=fixture();h.records.set('wl:bob',{tickers:['MSFT']});
 for(const [uid,ticker] of [['alice','MSFT'],['alice','../AVGO'],['missing','AVGO'],['','AVGO']]){
  const result=await refreshWatchlistScore(h.env,uid,ticker,()=>assert.fail('Unauthorized analysis'));
  assert.ok([400,401,403].includes(result.status));
 }
 assert.equal(h.writes.length,0);
});
test('an old-method snapshot cannot avoid current calculation and a previous dated score is refreshed',async()=>{
 const h=fixture(['OLD']);h.records.set('stock-summary:v24:OLD',{ticker:'OLD',score:{total:99},_cachedAt:NOW});
 h.records.set(`stock-summary:${VERSION}:OLD`,{ticker:'OLD',score:{total:42},_cachedAt:NOW-2*86400000});
 const result=await refreshWatchlistScore(h.env,'alice','OLD',async()=>analysis('OLD',67));
 assert.equal(result.body.item.score,67);assert.equal(result.body.item.scoreVersion,VERSION);
});
test('a valid calculated score remains visible when persisting its optional snapshot fails',async()=>{
 const h=fixture(['WRITEFAIL'],'writefail'),put=h.env.CACHE.put;
 h.env.CACHE.put=async(key,...args)=>{if(key.startsWith('stock-summary:'))throw Error('KV write unavailable');return put(key,...args);};
 const result=await refreshWatchlistScore(h.env,'writefail','WRITEFAIL',async()=>analysis('WRITEFAIL',75));
 assert.equal(result.body.ok,true);assert.equal(result.body.item.score,75);
});
test('a failed or empty computation is explicit, preserves historical data and has a cooldown',async()=>{
 const h=fixture(['FAIL']);let calls=0;
 const result=await refreshWatchlistScore(h.env,'alice','FAIL',async()=>{calls++;throw Error('provider failure');});
 assert.equal(result.body.ok,false);assert.equal(result.body.state,'unavailable');assert.ok(result.body.retryAfterSeconds>0);
 const retry=await refreshWatchlistScore(h.env,'alice','FAIL',()=>assert.fail('Cooldown must avoid providers'));
 assert.equal(retry.body.state,'cooldown');assert.equal(calls,1);assert.ok(!h.records.has(`stock-summary:${VERSION}:FAIL`));
 for(const [ticker,value] of [['EMPTY',{ticker:'EMPTY',score:{total:55,breakdown:{momentum:{dataOk:false}}},_cachedAt:NOW}],['WRONG',analysis('OTHER')],['UNDATED',{ticker:'UNDATED',score:{total:75}}]]){
  const f=fixture([ticker],ticker);const r=await refreshWatchlistScore(f.env,ticker,ticker,async()=>value);assert.equal(r.body.ok,false,ticker);assert.equal(r.body.item,undefined);
 }
});
test('simultaneous calls share the same public calculation and a user cannot launch another ticker in parallel',async()=>{
 const h=fixture(['ONE','TWO'],'parallel');let release,calls=0;
 const calculate=async ticker=>{calls++;return new Promise(resolve=>{release=()=>resolve(analysis(ticker));});};
 const first=refreshWatchlistScore(h.env,'parallel','ONE',calculate);
 while(!release)await new Promise(resolve=>setImmediate(resolve));
 const second=refreshWatchlistScore(h.env,'parallel','ONE',calculate);
 const other=await refreshWatchlistScore(h.env,'parallel','TWO',()=>assert.fail('Second concurrent analysis'));
 assert.equal(other.body.state,'busy');release();
 assert.equal((await first).body.item.score,74);assert.equal((await second).body.item.score,74);assert.equal(calls,1);
});
test('HTTP score refresh requires Firebase auth and saved membership before returning a minimal score without account or quota side effects',async t=>{
 const {build}=await import('esbuild'),{fileURLToPath}=await import('node:url');
 const bundle=await build({entryPoints:[fileURLToPath(new URL('../src/index.js',import.meta.url))],bundle:true,format:'esm',platform:'neutral',target:'es2022',write:false,loader:{'.md':'text','.wasm':'binary','.ttf':'binary'},logLevel:'silent'});
 const {default:worker}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
 const h=fixture(),calls=[];h.records.set(`stock-summary:${VERSION}:AVGO`,analysis('AVGO'));
 t.mock.method(globalThis,'fetch',async(url,init)=>{calls.push(String(url));assert.match(String(url),/^https:\/\/identitytoolkit.googleapis.com\//);return new Response(JSON.stringify(JSON.parse(init.body).idToken==='alice-token'?{users:[{localId:'alice',email:'alice@example.com',emailVerified:true}]}:{users:[]}));});
 const env={...h.env,FIREBASE_API_KEY:'test',ALLOWED_ORIGIN:'https://kairosinsider.fr'},ctx={waitUntil(){assert.fail('No account tracking, notifications or background analysis');}};
 const request=(token,body)=>worker.fetch(new Request('https://kairosinsider.fr/api/watchlist/score?uid=bob',{method:'POST',headers:{Origin:env.ALLOWED_ORIGIN,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)}),env,ctx);
 assert.equal((await request(null,{symbol:'AVGO'})).status,401);
 assert.equal((await request('invalid',{symbol:'AVGO'})).status,401);
 assert.equal((await request('alice-token',{symbol:'MSFT'})).status,403);
 const response=await request('alice-token',{symbol:'AVGO'});assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'private, no-store');
 const body=await response.json();assert.equal(body.item.score,74);assert.equal(body.item.scoreVersion,VERSION);assert.equal(body.item.insiders,undefined);assert.equal(body.item.price,undefined);assert.equal(h.writes.length,0);assert.equal(calls.length,3);
});
