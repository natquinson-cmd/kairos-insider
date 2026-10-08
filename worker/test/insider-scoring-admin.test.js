import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const bundle=await build({entryPoints:[fileURLToPath(new URL('../src/index.js',import.meta.url))],bundle:true,format:'esm',platform:'neutral',target:'es2022',write:false,loader:{'.md':'text','.wasm':'binary','.ttf':'binary'},logLevel:'silent'});
const {default:worker}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
function harness(t,{owner=true,verified=true}={}){
 const store=new Map(),email=owner?'natquinson@gmail.com':'reader@example.com';
 t.mock.method(globalThis,'fetch',async url=>{
  if(String(url).startsWith('https://identitytoolkit.googleapis.com/'))return new Response(JSON.stringify({users:[{localId:'test',email,emailVerified:verified}]}));
  throw Error('Unexpected network request');
 });
 const env={FIREBASE_API_KEY:'test',ALLOWED_ORIGIN:'https://kairosinsider.fr',CACHE:{async get(k){return store.has(k)?structuredClone(store.get(k)):null;},async put(k,v){store.set(k,JSON.parse(v));}}};
 const request=(method='GET',body,auth=true)=>worker.fetch(new Request('https://kairosinsider.fr/api/admin/insider-scoring',{method,headers:{Origin:env.ALLOWED_ORIGIN,...(auth?{Authorization:'Bearer test'}:{}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env,{waitUntil(){}});
 return {store,request};
}
test('only the verified owner may read or change insider scoring settings',async t=>{
 for(const options of [{owner:false},{verified:false}]){const h=harness(t,options);for(const method of ['GET','PUT'])assert.ok([401,403].includes((await h.request(method,method==='PUT'?{saleWeight:.2}:undefined)).status));t.mock.restoreAll();}
 const h=harness(t);assert.ok([401,403].includes((await h.request('GET',undefined,false)).status));
});
test('owner reads defaults and saves insider parameters without changing global weights',async t=>{
 const h=harness(t);h.store.set('config:score-weights',{insider:20});
 let response=await h.request();assert.equal(response.status,200);const data=await response.json();assert.equal(data.config.saleWeight,.33);
 response=await h.request('PUT',{saleWeight:.25,halfLifeDays:21,convergenceWindowDays:14});assert.equal(response.status,200);
 assert.equal(h.store.get('config:insider-scoring').saleWeight,.25);assert.deepEqual(h.store.get('config:score-weights'),{insider:20});
 assert.equal((await (await h.request()).json()).config.halfLifeDays,21);
});
test('invalid settings are rejected without storing any changes',async t=>{
 const h=harness(t);for(const body of [{saleWeight:2},{halfLifeDays:0},{convergenceWindowDays:1000},null,[],{saleWeight:'0.2'},{surprise:1}]){assert.equal((await h.request('PUT',body)).status,400);assert.equal(h.store.has('config:insider-scoring'),false);}
});
