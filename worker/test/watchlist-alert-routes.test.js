import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const bundle=await build({entryPoints:[fileURLToPath(new URL('../src/index.js',import.meta.url))],bundle:true,format:'esm',platform:'neutral',target:'es2022',write:false,loader:{'.md':'text','.wasm':'binary','.ttf':'binary'},logLevel:'silent'});
const {default:worker}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
function harness(t,{premium=true,uid='reader',admin=false,verified=true}={}){
  const email=admin?'natquinson@gmail.com':uid+'@example.com',store=new Map([['user:'+uid,{uid,email,emailVerified:verified}]]),calls=[],telegramCalls=[];
  if(premium)store.set('sub:'+uid,{status:'active',plan:'pro',billing:'monthly'});
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if(String(url).startsWith('https://identitytoolkit.googleapis.com/'))return new Response(JSON.stringify({users:[{localId:uid,email,emailVerified:verified}]}));
    if(String(url)==='https://api.brevo.com/v3/smtp/email'){calls.push(JSON.parse(options.body));return new Response('{}',{status:201});}
    if(String(url)==='https://api.telegram.org/bottest-token/sendMessage'){telegramCalls.push(JSON.parse(options.body));return new Response('{"ok":true}');}
    throw new Error('Unexpected external request: '+url);
  });
  const env={FIREBASE_API_KEY:'test',BREVO_API_KEY:'test',TELEGRAM_BOT_TOKEN:'test-token',WATCHLIST_SECRET:'test-only',ALLOWED_ORIGIN:'https://kairosinsider.fr',CACHE:{
    async get(k,type){const value=store.get(k);return value==null?null:type==='json'?structuredClone(value):typeof value==='object'?JSON.stringify(value):value;},
    async put(k,v){try{store.set(k,JSON.parse(v));}catch{store.set(k,v);}},async delete(k){store.delete(k);},
    async list({prefix}){return {keys:[...store.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name})),list_complete:true};}
  }};
  const request=async(path,body,auth=true)=>worker.fetch(new Request('https://kairosinsider.fr'+path,{method:body?'POST':'GET',headers:{Origin:env.ALLOWED_ORIGIN,...(auth?{Authorization:'Bearer test'}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),env,{waitUntil(){}});
  return {store,calls,telegramCalls,env,request,uid};
}
test('watchlist read distinguishes missing versus deliberately empty; list edits preserve preferences without sending',async t=>{
  const h=harness(t);let response=await h.request('/api/watchlist/get'),data=await response.json();assert.equal(data.exists,false);assert.equal(data.emailAlerts,false);assert.equal(data.emailInsiderAlerts,false);
  h.store.set('wl:reader',{tickers:[],emailAlerts:false,emailInsiderAlerts:true,optIn:false,types:{insider:true,cluster:false,activist:false},lastDigestAt:123,lang:'en',createdAt:1});
  response=await h.request('/api/watchlist/get');assert.equal((await response.json()).exists,true);
  response=await h.request('/api/watchlist/sync',{tickers:['AAPL'],sendConfirmation:false});assert.equal(response.status,200);
  const record=h.store.get('wl:reader');assert.equal(record.emailAlerts,false);assert.equal(record.emailInsiderAlerts,true);assert.equal(record.types.cluster,false);assert.equal(record.types.activist,false);assert.equal(record.lang,'en');assert.equal(record.lastDigestAt,123);assert.equal(h.calls.length,0);
});
test('free users can read and keep three tickers but cannot enable either event channel',async t=>{
  const h=harness(t,{premium:false,uid:'free'});
  assert.equal((await h.request('/api/watchlist/get',null,false)).status,401);
  assert.equal((await h.request('/api/watchlist/sync',{tickers:['AAPL','MSFT','NVDA'],emailAlerts:false,sendConfirmation:false})).status,200);
  assert.equal((await h.request('/api/watchlist/sync',{tickers:['AAPL','MSFT','NVDA','TSLA'],sendConfirmation:false})).status,403);
  assert.equal((await h.request('/api/watchlist/sync',{emailInsiderAlerts:true,sendConfirmation:false})).status,403);
  h.store.set('tg:free',{chatId:'123',alertPrefs:{new13d:false}});
  assert.equal((await h.request('/api/telegram/preferences',{insiderTransactions:true})).status,403);
  assert.equal((await h.request('/api/telegram/preferences',{insiderTransactions:false})).status,200);
  assert.equal(h.calls.length,0);
});
test('verified owner gets event preferences without paid subscription and preserves old Telegram switches',async t=>{
  const h=harness(t,{premium:false,uid:'owner',admin:true});h.store.set('tg:owner',{chatId:'123',alertPrefs:{new13d:false,scoreThreshold:80}});
  assert.equal((await (await h.request('/api/telegram/status')).json()).alertPrefs.insiderTransactions,false);
  let response=await h.request('/api/telegram/preferences',{insiderTransactions:true,lang:'en',quietHoursStart:23,quietHoursEnd:6});assert.equal(response.status,200);
  const prefs=(await response.json()).alertPrefs;assert.equal(prefs.new13d,false);assert.equal(prefs.scoreThreshold,80);assert.equal(prefs.lang,'en');
  assert.equal((await h.request('/api/telegram/preferences',{quietHoursEnd:24})).status,400);
  assert.equal((await h.request('/api/watchlist/sync',{tickers:['AAPL'],emailAlerts:false,emailInsiderAlerts:true,sendConfirmation:false})).status,200);
  assert.equal(h.store.get('wl:owner').adminVerified,true);assert.equal(h.calls.length,0);
});
test('explicit email confirmation seeds current data without activating legacy digest; unsubscribe stops both',async t=>{
  const h=harness(t,{uid:'confirm'});const today=new Date().toISOString().slice(0,10);
  h.store.set('insider-transactions',{transactions:[{ticker:'AAPL',type:'buy',fileDate:today,date:today,insider:'Person',accession:'old'}]});
  let response=await h.request('/api/watchlist/sync',{tickers:['AAPL'],emailAlerts:false,emailInsiderAlerts:true,sendConfirmation:true,lang:'en'});assert.equal(response.status,200);assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].subject,'Confirm your Kairos Insider watchlist');assert.match(h.calls[0].htmlContent,/Confirm my email alerts/);assert.match(h.calls[0].textContent,/each disclosed insider purchase or sale/);assert.doesNotMatch(h.calls[0].htmlContent,/Confirmez|quotidien/);
  const confirmUrl=h.calls[0].htmlContent.match(/href="([^" ]*\/watchlist\/confirm\?[^" ]+)"/)[1];
  response=await h.request(new URL(confirmUrl).pathname+new URL(confirmUrl).search);assert.equal(response.status,200);
  const confirmationHtml=await response.text();assert.match(confirmationHtml,/Confirmation saved/);assert.match(confirmationHtml,/Manage my watchlist/);assert.match(confirmationHtml,/watchlist.html\?lang=en/);
  const record=h.store.get('wl:confirm');assert.equal(record.optIn,true);assert.equal(record.emailAlerts,false);assert.ok(h.store.get('insider-alert-state:email:confirm').tickers.AAPL.seen.length);
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode('test-only'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('unsub:confirm'));const token=Buffer.from(signature).toString('base64url');
  response=await h.request('/watchlist/unsubscribe?uid=confirm&token='+token);assert.equal(response.status,200);
  assert.equal(h.store.get('wl:confirm').emailInsiderAlerts,false);assert.equal(h.store.get('wl:confirm').emailAlerts,false);
});
test('offline scheduled handler sends an individual email without Telegram and excludes free/unconfirmed users',async t=>{
  const h=harness(t,{uid:'email-only'}),today=new Date().toISOString().slice(0,10);
  const record={tickers:['AAPL'],emailAlerts:false,emailInsiderAlerts:false,optIn:true,email:'email-only@example.com',types:{insider:true},createdAt:1};
  h.store.set('wl:email-only',record);h.store.set('insider-transactions',{transactions:[]});
  assert.equal((await h.request('/api/watchlist/sync',{emailInsiderAlerts:true,sendConfirmation:false,lang:'en'})).status,200);
  h.store.set('wl:excluded-free',{...record,email:'free@example.com',emailInsiderAlerts:true});
  h.store.set('wl:excluded-unconfirmed',{...record,email:'pending@example.com',emailInsiderAlerts:true,optIn:false});h.store.set('sub:excluded-unconfirmed',{status:'active',plan:'pro'});
  h.store.set('insider-transactions',{transactions:[{ticker:'AAPL',type:'sell',source:'sec',sourceUrl:'https://www.sec.gov/example',fileDate:today,date:today,insider:'Person',accession:'new-sale'}]});
  const scheduled=async()=>{const pending=[];await worker.scheduled({cron:'*/5 * * * *'},h.env,{waitUntil(p){pending.push(p);}});await Promise.all(pending);};
  await scheduled();assert.equal(h.calls.length,1);assert.equal(h.calls[0].to[0].email,'email-only@example.com');assert.match(h.calls[0].subject,/Sale/);assert.match(h.calls[0].textContent,/Filed:/);assert.match(h.calls[0].htmlContent,/www.sec.gov\/example/);assert.match(h.calls[0].htmlContent,/watchlist\/unsubscribe/);assert.match(h.calls[0].textContent,/www.sec.gov\/example/);
  await scheduled();assert.equal(h.calls.length,1);
});
test('offline Telegram individual delivery is plain text and preserves explicit source links',async t=>{
  const h=harness(t,{uid:'telegram-only'}),today=new Date().toISOString().slice(0,10);
  h.store.set('wl:telegram-only',{tickers:['AAPL'],emailAlerts:false,optIn:false,types:{insider:true}});
  h.store.set('tg:telegram-only',{chatId:'42',alertPrefs:{new13d:false,insiderCluster:false,euThreshold:false,quietHoursStart:0,quietHoursEnd:0}});
  h.store.set('insider-transactions',{transactions:[]});
  assert.equal((await h.request('/api/telegram/preferences',{insiderTransactions:true,lang:'en'})).status,200);
  h.store.set('insider-transactions',{transactions:[{ticker:'AAPL',type:'buy',source:'sec',sourceUrl:'https://www.sec.gov/a_file.xml',fileDate:today,date:today,insider:'A_[Reader]',accession:'new'}]});
  const pending=[];await worker.scheduled({cron:'*/5 * * * *'},h.env,{waitUntil(p){pending.push(p);}});await Promise.all(pending);
  assert.equal(h.telegramCalls.length,1);assert.equal(h.calls.length,0);assert.equal(Object.hasOwn(h.telegramCalls[0],'parse_mode'),false);assert.match(h.telegramCalls[0].text,/https:\/\/www.sec.gov\/a_file.xml/);assert.match(h.telegramCalls[0].text,/Purchase/);
});
test('unverified owner email cannot activate paid alerts',async t=>{
  const h=harness(t,{uid:'unverified-owner',admin:true,premium:false,verified:false});
  h.store.set('tg:unverified-owner',{chatId:'42'});
  assert.equal((await h.request('/api/telegram/preferences',{insiderTransactions:true})).status,403);
  assert.equal((await h.request('/api/watchlist/sync',{tickers:['AAPL'],emailInsiderAlerts:true,sendConfirmation:false})).status,403);
});
