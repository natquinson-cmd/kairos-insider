import {test} from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInsiderMovement, movementMessage, runInsiderMovementAlerts, seedInsiderMovementBaseline, telegramAlertPreferences, isInsiderQuietHours } from '../src/insider-alerts.js';
const now=Date.parse('2026-09-23T12:00:00Z');
const tx=(id,extra={})=>({ticker:'AAPL',source:'sec',type:'buy',insider:'A Reader',date:'2026-09-20',fileDate:'2026-09-23',shares:10,value:2000,accession:id,...extra});
function harness(){const store=new Map(),sent=[],env={CACHE:{async get(k){return store.get(k)??null;},async put(k,v){store.set(k,JSON.parse(v));}}};const user={uid:'one',watchlist:new Set(['AAPL']),watchStartedAt:{AAPL:1},email:'one@example.com',emailEnabled:true,emailActivation:1,telegramEnabled:true,telegramActivation:1,prefs:{},chatId:'1',lang:'fr'};return {store,sent,env,user,options:{now,sendEmail:async(s,e)=>{sent.push(['email',e.id]);return true;},sendTelegram:async(s,e)=>{sent.push(['telegram',e.id]);return true;},isQuiet:()=>false}};}
test('normalization distinguishes purchases/sales and publication dates without ticker region collisions',()=>{
  assert.equal(normalizeInsiderMovement(tx('1')).type,'buy');assert.equal(normalizeInsiderMovement(tx('2',{type:'S'})).type,'sell');
  assert.equal(normalizeInsiderMovement(tx('3',{type:'M'})),null);assert.equal(normalizeInsiderMovement(tx('4',{fileDate:null})),null);
  assert.equal(normalizeInsiderMovement(tx('5',{ticker:'SU',source:'amf',market:'FR',region:'Europe'})).ticker,'SU.PA');
  assert.equal(normalizeInsiderMovement(tx('6',{ticker:'SU',source:'sec'})).ticker,'SU');
  assert.equal(normalizeInsiderMovement(tx('6',{ticker:'AAPL',yahooSymbol:'AAPL',source:'amf',market:'FR'})).ticker,'AAPL');
  const message=movementMessage(normalizeInsiderMovement(tx('7',{type:'sell',sourceUrl:'https://www.sec.gov/example'})),'fr');
  assert.match(message.text,/Vente/);assert.match(message.text,/Transaction : 2026-09-20/);assert.match(message.text,/Publication : 2026-09-23/);assert.match(message.text,/Source : SEC/);
});
test('preferences preserve old triggers and require explicit individual alert activation',()=>{
  assert.equal(telegramAlertPreferences({}).insiderTransactions,false);
  assert.equal(telegramAlertPreferences({new13d:false},{insiderTransactions:true}).new13d,false);
  assert.throws(()=>telegramAlertPreferences({}, {insiderTransactions:'true'}));assert.throws(()=>telegramAlertPreferences({}, {quietHoursStart:25}));
});
test('first run seeds silently, one new filing reaches each channel once, exact duplicates are ignored',async()=>{
  const h=harness();h.store.set('insider-transactions',{transactions:[tx('1')]});
  await runInsiderMovementAlerts(h.env,[h.user],h.options);assert.equal(h.sent.length,0);
  h.store.set('insider-transactions',{transactions:[tx('1'),tx('2'),tx('2')]});
  await runInsiderMovementAlerts(h.env,[h.user],h.options);assert.deepEqual(h.sent.map(x=>x[0]),['email','telegram']);
  await runInsiderMovementAlerts(h.env,[h.user],h.options);assert.equal(h.sent.length,2);
});
test('new ticker and channel reactivation start silently; empty initial feeds still accept the next event',async()=>{
  const h=harness();h.store.set('insider-transactions',{transactions:[]});await runInsiderMovementAlerts(h.env,[h.user],h.options);
  h.store.set('insider-transactions',{transactions:[tx('1'),tx('2',{ticker:'MSFT'})]});h.user.watchlist.add('MSFT');h.user.watchStartedAt.MSFT=2;
  await runInsiderMovementAlerts(h.env,[h.user],h.options);assert.equal(h.sent.length,2);
  h.user.emailActivation=3;h.user.telegramActivation=3;h.store.set('insider-transactions',{transactions:[tx('3')]});
  await runInsiderMovementAlerts(h.env,[h.user],h.options);assert.equal(h.sent.length,2);
});
test('quiet hours and independent channel failures retain pending events for retry',async()=>{
  const h=harness();h.store.set('insider-transactions',{transactions:[]});await runInsiderMovementAlerts(h.env,[h.user],h.options);
  h.store.set('insider-transactions',{transactions:[tx('1')]});
  await runInsiderMovementAlerts(h.env,[h.user],{...h.options,isQuiet:()=>true});assert.deepEqual(h.sent.map(x=>x[0]),['email']);
  await runInsiderMovementAlerts(h.env,[h.user],{...h.options,sendTelegram:async()=>{throw Error('transport');}});assert.equal(h.sent.length,1);
  await runInsiderMovementAlerts(h.env,[h.user],h.options);assert.deepEqual(h.sent.map(x=>x[0]),['email','telegram']);
});
test('unsubscribing or removing a ticker drops pending delivery; unavailable data never establishes a baseline',async()=>{
  const h=harness();await runInsiderMovementAlerts(h.env,[h.user],h.options);assert.equal(h.store.size,0);
  h.store.set('insider-transactions',{transactions:[]});await runInsiderMovementAlerts(h.env,[h.user],h.options);
  h.store.set('insider-transactions',{transactions:[tx('1')]});await runInsiderMovementAlerts(h.env,[h.user],{...h.options,sendEmail:async()=>false,isQuiet:()=>true});
  h.user.emailEnabled=false;h.user.watchlist.clear();await runInsiderMovementAlerts(h.env,[h.user],h.options);assert.equal(h.sent.length,0);
});
test('configuration snapshot retains a newly collected filing before the first scheduled check',async()=>{
  const h=harness();h.store.set('insider-transactions',{transactions:[tx('old')]});
  await seedInsiderMovementBaseline(h.env,h.user,'email',now);await seedInsiderMovementBaseline(h.env,h.user,'telegram',now);
  h.store.set('insider-transactions',{transactions:[tx('old'),tx('new')]});await runInsiderMovementAlerts(h.env,[h.user],h.options);
  assert.equal(h.sent.length,2);assert.ok(h.sent.every(([,id])=>id.includes('new')));
});
test('two users receive separate channel deliveries and failures cannot consume another user’s event',async()=>{
  const h=harness(),second={...h.user,uid:'two',emailEnabled:false};
  h.store.set('insider-transactions',{transactions:[]});await runInsiderMovementAlerts(h.env,[h.user,second],h.options);
  h.store.set('insider-transactions',{transactions:[tx('new')]});const sent=[];
  await runInsiderMovementAlerts(h.env,[h.user,second],{...h.options,sendEmail:async()=>{throw Error('email offline');},sendTelegram:async(sub)=>{sent.push(sub.uid);return true;}});
  assert.deepEqual(sent,['one','two']);
  await runInsiderMovementAlerts(h.env,[h.user,second],{...h.options,sendEmail:async sub=>{sent.push('email:'+sub.uid);return true;},sendTelegram:async()=>assert.fail('must deduplicate')});
  assert.deepEqual(sent,['one','two','email:one']);
});
test('individual Telegram quiet hours follow Europe/Paris winter and summer time',()=>{
  assert.equal(isInsiderQuietHours({quietHoursStart:22,quietHoursEnd:7},new Date('2026-01-20T20:30:00Z')),false);
  assert.equal(isInsiderQuietHours({quietHoursStart:22,quietHoursEnd:7},new Date('2026-07-20T20:30:00Z')),true);
});
