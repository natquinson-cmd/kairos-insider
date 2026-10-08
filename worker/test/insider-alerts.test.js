import {test} from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInsiderMovement, movementMessage, runInsiderMovementAlerts, seedInsiderMovementBaseline, telegramAlertPreferences, isInsiderQuietHours } from '../src/insider-alerts.js';
const now=Date.parse('2026-09-23T12:00:00Z');
const tx=(id,extra={})=>({ticker:'AAPL',source:'sec',type:'buy',insider:'A Reader',date:'2026-09-20',fileDate:'2026-09-23',shares:10,value:2000,accession:id,code:extra.type&&extra.type!=='buy'?(extra.type==='sell'?'S':extra.type):'P',...extra});
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

test('grants exercises gifts withholding and unproven legacy buys never generate purchase alerts',async()=>{
  const h=harness();h.store.set('insider-transactions',{transactions:[]});
  await runInsiderMovementAlerts(h.env,[h.user],h.options);
  const excluded=['M','A','F','G',undefined].map((code,i)=>tx('excluded-'+i,{code,purchaseSignalEligible:true}));
  excluded.push(tx('employee',{code:'P',transactionFootnotes:[{id:'F1',text:'Shares acquired under the employee stock purchase plan.'}]}));
  h.store.set('insider-transactions',{transactions:excluded});
  await runInsiderMovementAlerts(h.env,[h.user],h.options);assert.equal(h.sent.length,0);
  h.store.set('insider-transactions',{transactions:[...excluded,tx('actual',{code:'P',form10b5One:true})]});
  await runInsiderMovementAlerts(h.env,[h.user],h.options);assert.equal(h.sent.length,2);
});

test('IPSOS free-share delivery cannot become an alert and unknown legacy purchases remain readable',()=>{
  assert.equal(normalizeInsiderMovement(tx('ipsos',{ticker:'IPS',source:'amf',market:'FR',type:'P',code:"Acquisition définitive d'actions gratuites (livraison)",shares:1200,value:43776})),null);
  const unknown=normalizeInsiderMovement(tx('legacy',{code:undefined}));
  assert.equal(unknown.type,'buy');assert.equal(unknown.purchaseSignalEligible,false);assert.equal(unknown.purchaseSignalStatus,'unknown');
  assert.equal(normalizeInsiderMovement(tx('legacy',{code:undefined}),{forAlert:true}),null);
});

test('old queued purchases without retained proof are discarded before delivery',async()=>{
  const h=harness();h.store.set('insider-transactions',{transactions:[]});await runInsiderMovementAlerts(h.env,[h.user],h.options);
  for(const channel of ['email','telegram']){const state=h.store.get('insider-alert-state:'+channel+':one');state.pending=[{id:'legacy',type:'buy',ticker:'AAPL',fileDate:'2026-09-23',tradeDate:'2026-09-20'}];}
  await runInsiderMovementAlerts(h.env,[h.user],h.options);assert.equal(h.sent.length,0);
});

test('documented corrections revoke queued purchases and future convergence support',async()=>{
  for(const correction of [{transactionFootnotes:[{id:'F1',text:'Shares acquired under the employee stock purchase plan.'}]},{code:'A'}]){
    const h=harness();h.store.set('insider-transactions',{transactions:[]});await runInsiderMovementAlerts(h.env,[h.user],h.options);
    const original=tx('corrected');h.store.set('insider-transactions',{transactions:[original]});
    await runInsiderMovementAlerts(h.env,[h.user],{...h.options,sendEmail:async()=>false,sendTelegram:async()=>false});
    assert.equal(h.store.get('insider-alert-state:email:one').pending.length,1);
    h.store.set('insider-transactions',{transactions:[{...original,...correction}]});
    await runInsiderMovementAlerts(h.env,[h.user],h.options);
    assert.equal(h.sent.length,0,'a documented correction must cancel the pending purchase');
    for(const channel of ['email','telegram'])assert.equal(h.store.get('insider-alert-state:'+channel+':one').tickers.AAPL.purchases.length,0);
    const events=[];h.store.set('insider-transactions',{transactions:[tx('second',{insider:'B Reader'})]});
    await runInsiderMovementAlerts(h.env,[h.user],{...h.options,sendEmail:async(s,e)=>{events.push(e);return true;},sendTelegram:async()=>true});
    assert.equal(events.length,1);assert.equal(events[0].convergence,undefined,'the revoked observation must not manufacture a second buyer');
  }
});

test('a correction to another fill cannot erase a valid queued purchase in a partial feed',async()=>{
  const h=harness();h.store.set('insider-transactions',{transactions:[]});await runInsiderMovementAlerts(h.env,[h.user],h.options);
  h.store.set('insider-transactions',{transactions:[tx('same-filing')]});
  await runInsiderMovementAlerts(h.env,[h.user],{...h.options,sendEmail:async()=>false,sendTelegram:async()=>false});
  h.store.set('insider-transactions',{transactions:[tx('same-filing',{code:'A',shares:20,value:4000})]});
  await runInsiderMovementAlerts(h.env,[h.user],h.options);
  assert.equal(h.sent.length,2);assert.equal(h.store.get('insider-alert-state:email:one').tickers.AAPL.purchases.length,1);
});

test('a queued legacy activist crossover cannot bypass current purchase evidence',async()=>{
  const h=harness();h.store.set('insider-transactions',{transactions:[]});await runInsiderMovementAlerts(h.env,[h.user],h.options);
  for(const channel of ['email','telegram']){const state=h.store.get('insider-alert-state:'+channel+':one');state.pending=[{id:'old-cross',type:'activist-purchase',ticker:'AAPL',fileDate:'2026-09-23',convergence:{kind:'activist-purchase',firstTradeDate:'2026-09-20',buyerCount:1}}];state.tickers.AAPL.purchases=[{id:'old-grant',insider:'A Reader',tradeDate:'2026-09-20',fileDate:'2026-09-23'}];}
  await runInsiderMovementAlerts(h.env,[h.user],h.options);assert.equal(h.sent.length,0);
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

const activist=(id,extra={})=>({accession:id,ticker:'AAPL',fileDate:'2026-09-23',form:'SCHEDULE 13D',isActivist:true,filerName:'Example Capital',filerCik:'0000043210',targetName:'Apple',...extra});
function capture(h){const events=[];return {events,options:{...h.options,sendEmail:async(sub,event)=>{events.push(['email',event]);return true;},sendTelegram:async(sub,event)=>{events.push(['telegram',event]);return true;}}};}

test('new second distinct buyer enriches the purchase once without replaying historical convergence',async()=>{
  const h=harness(),c=capture(h);h.store.set('insider-transactions',{transactions:[tx('one',{insiderCik:'000001'})]});
  await runInsiderMovementAlerts(h.env,[h.user],c.options);
  h.store.set('insider-transactions',{transactions:[tx('one',{insiderCik:'000001'}),tx('two',{insider:'B Reader',insiderCik:'2'})]});
  await runInsiderMovementAlerts(h.env,[h.user],c.options);
  assert.equal(c.events.length,2);assert.equal(c.events[0][1].convergence?.kind,'buyers');assert.equal(c.events[0][1].convergence.buyerCount,2);
  assert.match(movementMessage(c.events[0][1],'en').text,/2 distinct buyers/);assert.match(movementMessage(c.events[0][1],'fr').text,/2 acheteurs distincts/);
  await runInsiderMovementAlerts(h.env,[h.user],c.options);assert.equal(c.events.length,2);
  h.store.set('insider-transactions',{transactions:[tx('one',{insiderCik:'000001'}),tx('two',{insider:'B Reader',insiderCik:'2'}),tx('three',{insider:'C Reader',insiderCik:'3'})]});
  await runInsiderMovementAlerts(h.env,[h.user],c.options);assert.equal(c.events.at(-1)[1].convergence,undefined);
});

test('same identified buyer, unknown buyers, old trades and future trades never create new conviction',async()=>{
  for(const extra of [{insider:'A. Reader'}, {insider:'Alias',insiderCik:'000001'}, {insider:''}, {insider:'Unknown'}, {insider:'B Reader',date:'2026-08-01'}, {insider:'B Reader',date:'2026-09-24'}, {insider:'B Reader',date:null}, {insider:'B Reader',type:'sell'}]){
    const h=harness(),c=capture(h);h.store.set('insider-transactions',{transactions:[tx('one',{insiderCik:'1'})]});await runInsiderMovementAlerts(h.env,[h.user],c.options);
    h.store.set('insider-transactions',{transactions:[tx('one',{insiderCik:'1'}),tx('two',extra)]});await runInsiderMovementAlerts(h.env,[h.user],c.options);
    assert.equal(c.events.length,2);assert.equal(c.events[0][1].convergence,undefined,JSON.stringify(extra));
  }
});

test('purchase observations survive a partial feed and source outage without inventing a second buyer',async()=>{
  const h=harness(),c=capture(h);h.store.set('insider-transactions',{transactions:[tx('one',{insiderCik:'1'})]});await runInsiderMovementAlerts(h.env,[h.user],c.options);
  h.store.delete('insider-transactions');await runInsiderMovementAlerts(h.env,[h.user],c.options);
  h.store.set('insider-transactions',{transactions:[tx('two',{insider:'B Reader',insiderCik:'2'})]});await runInsiderMovementAlerts(h.env,[h.user],c.options);
  assert.equal(c.events[0][1].convergence?.buyerCount,2);
});

test('activist crossover silently bootstraps existing filings then delivers only a new distinct 13D actor',async()=>{
  const h=harness(),c=capture(h);h.store.set('insider-transactions',{transactions:[tx('one')]});h.store.set('13dg-recent',{filings:[activist('historical')]});
  await runInsiderMovementAlerts(h.env,[h.user],c.options);assert.equal(c.events.length,0);
  h.store.set('13dg-recent',{filings:[activist('historical'),activist('new',{filerName:'Another Capital',filerCik:'43211'})]});
  await runInsiderMovementAlerts(h.env,[h.user],c.options);assert.equal(c.events.length,2);
  const event=c.events[0][1];assert.equal(event.type,'activist-purchase');assert.equal(event.convergence.buyerCount,1);assert.match(event.id,/activist-purchase/);assert.match(event.id,/new/);
  assert.match(movementMessage(event,'en').text,/13D/);assert.match(movementMessage(event,'en').text,/Trade date/);assert.match(movementMessage(event,'fr').text,/Publication/);
  await runInsiderMovementAlerts(h.env,[h.user],c.options);assert.equal(c.events.length,2);
});

test('activist source first becoming available and existing deployments establish a silent baseline',async()=>{
  const h=harness(),c=capture(h);h.store.set('insider-transactions',{transactions:[tx('one')]});await runInsiderMovementAlerts(h.env,[h.user],c.options);
  h.store.set('13dg-recent',{filings:[activist('existing')]});await runInsiderMovementAlerts(h.env,[h.user],c.options);assert.equal(c.events.length,0);
  h.store.set('13dg-recent',{filings:[activist('existing'),activist('next',{filerCik:'999',filerName:'Different Capital'})]});
  await runInsiderMovementAlerts(h.env,[h.user],c.options);assert.equal(c.events.length,2);
});

test('passive, stale, future, unidentified and duplicate buyer/fund filings do not trigger crossover',async()=>{
  for(const extra of [{form:'SCHEDULE 13G',isActivist:true}, {isActivist:false}, {fileDate:'2026-08-01'}, {fileDate:'2026-09-24'}, {filerName:'',filerCik:''}, {filerName:'A. Reader',filerCik:''}, {filerName:'Alias',filerCik:'000000001'}, {accession:''}]){
    const h=harness(),c=capture(h);h.store.set('insider-transactions',{transactions:[tx('one',{insiderCik:'1'})]});h.store.set('13dg-recent',{filings:[]});await runInsiderMovementAlerts(h.env,[h.user],c.options);
    h.store.set('13dg-recent',{filings:[activist('new',extra)]});await runInsiderMovementAlerts(h.env,[h.user],c.options);assert.equal(c.events.length,0,JSON.stringify(extra));
  }
});

test('activist events respect channel and trigger opt-outs and retain failed delivery through an outage',async()=>{
  const h=harness(),c=capture(h);h.user.prefs.new13d=false;h.store.set('insider-transactions',{transactions:[tx('one')]});h.store.set('13dg-recent',{filings:[]});
  await runInsiderMovementAlerts(h.env,[h.user],c.options);h.store.set('13dg-recent',{filings:[activist('new')]});
  await runInsiderMovementAlerts(h.env,[h.user],{...c.options,sendEmail:async()=>false});assert.equal(c.events.length,0);
  h.store.delete('13dg-recent');await runInsiderMovementAlerts(h.env,[h.user],c.options);assert.deepEqual(c.events.map(x=>x[0]),['email']);
  h.store.set('13dg-recent',{filings:[activist('new')]});await runInsiderMovementAlerts(h.env,[h.user],c.options);assert.equal(c.events.length,1);
  h.user.types={activist:false};h.store.set('13dg-recent',{filings:[activist('another',{filerCik:'999',filerName:'Different Capital'})]});await runInsiderMovementAlerts(h.env,[h.user],c.options);assert.equal(c.events.length,1);
});

test('configuration baselines activist arrivals and disabled channels never send crossover events',async()=>{
  const h=harness(),c=capture(h);h.user.telegramEnabled=false;h.store.set('insider-transactions',{transactions:[tx('one')]});h.store.set('13dg-recent',{filings:[activist('old')]});
  await seedInsiderMovementBaseline(h.env,h.user,'email',now);
  h.store.set('13dg-recent',{filings:[activist('old'),activist('new',{filerCik:'999',filerName:'Different Capital'})]});await runInsiderMovementAlerts(h.env,[h.user],c.options);
  assert.deepEqual(c.events.map(x=>x[0]),['email']);assert.equal(c.events[0][1].type,'activist-purchase');
});

test('an upgrade of legacy alert state never replays existing activist filings',async()=>{
  const h=harness(),c=capture(h),old=normalizeInsiderMovement(tx('one'));
  for(const channel of ['email','telegram'])h.store.set('insider-alert-state:'+channel+':one',{enabled:true,activation:1,tickers:{AAPL:{token:1,seen:[[old.id,old.fileDate]]}},pending:[]});
  h.store.set('insider-transactions',{transactions:[tx('one')]});h.store.set('13dg-recent',{filings:[activist('existing')]});
  await runInsiderMovementAlerts(h.env,[h.user],c.options);assert.equal(c.events.length,0);
});

test('repeat amendments by the same activist and purchases occurring after the filing do not create crossover',async()=>{
  const h=harness(),c=capture(h);h.store.set('insider-transactions',{transactions:[tx('one')]});h.store.set('13dg-recent',{filings:[activist('old')]});await runInsiderMovementAlerts(h.env,[h.user],c.options);
  h.store.set('13dg-recent',{filings:[activist('amended',{form:'SCHEDULE 13D/A',filerName:'Capital Alias',filerCik:'43210'})]});await runInsiderMovementAlerts(h.env,[h.user],c.options);assert.equal(c.events.length,0);
  h.store.set('13dg-recent',{filings:[activist('backfilled',{fileDate:'2026-09-19',filerName:'Different Capital',filerCik:'999'})]});await runInsiderMovementAlerts(h.env,[h.user],c.options);assert.equal(c.events.length,0);
});

test('purchase convergence expires before a delayed delivery without dropping the underlying filing',async()=>{
  const h=harness(),c=capture(h);h.user.telegramEnabled=false;h.store.set('insider-transactions',{transactions:[tx('one',{date:'2026-08-24'})]});await runInsiderMovementAlerts(h.env,[h.user],c.options);
  h.store.set('insider-transactions',{transactions:[tx('one',{date:'2026-08-24'}),tx('two',{insider:'B Reader',date:'2026-08-25'})]});
  await runInsiderMovementAlerts(h.env,[h.user],{...c.options,sendEmail:async()=>false});
  await runInsiderMovementAlerts(h.env,[h.user],{...c.options,now:Date.parse('2026-09-25T12:00:00Z')});
  assert.equal(c.events.length,1);assert.equal(c.events[0][1].type,'buy');assert.equal(c.events[0][1].convergence,undefined);
});

test('an activist event with expired supporting purchases is not delivered after a channel failure',async()=>{
  const h=harness(),c=capture(h);h.user.telegramEnabled=false;h.store.set('insider-transactions',{transactions:[tx('one',{date:'2026-08-24'})]});h.store.set('13dg-recent',{filings:[]});await runInsiderMovementAlerts(h.env,[h.user],c.options);
  h.store.set('13dg-recent',{filings:[activist('new')]});await runInsiderMovementAlerts(h.env,[h.user],{...c.options,sendEmail:async()=>false});
  await runInsiderMovementAlerts(h.env,[h.user],{...c.options,now:Date.parse('2026-09-25T12:00:00Z')});assert.equal(c.events.length,0);
});

test('filings first discovered after seven days cannot start a new convergence',async()=>{
  const h=harness(),c=capture(h);h.store.set('insider-transactions',{transactions:[tx('one',{date:'2026-09-10',fileDate:'2026-09-11'})]});h.store.set('13dg-recent',{filings:[]});await runInsiderMovementAlerts(h.env,[h.user],c.options);
  h.store.set('insider-transactions',{transactions:[tx('one',{date:'2026-09-10',fileDate:'2026-09-11'}),tx('old',{insider:'B Reader',date:'2026-09-14',fileDate:'2026-09-15'})]});h.store.set('13dg-recent',{filings:[activist('old',{fileDate:'2026-09-15'})]});
  await runInsiderMovementAlerts(h.env,[h.user],c.options);
  assert.equal(c.events.length,2);assert.ok(c.events.every(([,event])=>event.type==='buy'&&!event.convergence));
});

test('a delayed convergence loses priority after seven days from publication',async()=>{
  const h=harness(),c=capture(h);h.user.telegramEnabled=false;h.store.set('insider-transactions',{transactions:[tx('one')]});h.store.set('13dg-recent',{filings:[]});await runInsiderMovementAlerts(h.env,[h.user],c.options);
  h.store.set('insider-transactions',{transactions:[tx('one'),tx('two',{insider:'B Reader'})]});h.store.set('13dg-recent',{filings:[activist('new')]});await runInsiderMovementAlerts(h.env,[h.user],{...c.options,sendEmail:async()=>false});
  await runInsiderMovementAlerts(h.env,[h.user],{...c.options,now:Date.parse('2026-10-01T12:00:00Z')});assert.equal(c.events.length,1);assert.equal(c.events[0][1].type,'buy');assert.equal(c.events[0][1].convergence,undefined);
});

test('malformed activist rows cannot stop ordinary insider deliveries',async()=>{
  const h=harness(),c=capture(h);h.store.set('insider-transactions',{transactions:[]});h.store.set('13dg-recent',{filings:[null,42]});await runInsiderMovementAlerts(h.env,[h.user],c.options);
  h.store.set('insider-transactions',{transactions:[tx('one')]});await runInsiderMovementAlerts(h.env,[h.user],c.options);assert.equal(c.events.length,2);
});

test('a purchase dated after its own filing cannot support buyer or activist convergence',async()=>{
  const h=harness(),c=capture(h),impossible=tx('bad',{date:'2026-09-22',fileDate:'2026-09-21'});
  h.store.set('insider-transactions',{transactions:[impossible]});h.store.set('13dg-recent',{filings:[]});await runInsiderMovementAlerts(h.env,[h.user],c.options);
  h.store.set('13dg-recent',{filings:[activist('new')]});await runInsiderMovementAlerts(h.env,[h.user],c.options);assert.equal(c.events.length,0);
  h.store.set('insider-transactions',{transactions:[impossible,tx('good',{insider:'B Reader'})]});await runInsiderMovementAlerts(h.env,[h.user],c.options);
  assert.equal(c.events.length,2);assert.equal(c.events[0][1].convergence,undefined);
});

test('reversing person name tokens does not create a second buyer',async()=>{
  const h=harness(),c=capture(h);h.store.set('insider-transactions',{transactions:[tx('one',{insider:'Alice Doe',insiderCik:'123'})]});await runInsiderMovementAlerts(h.env,[h.user],c.options);
  h.store.set('insider-transactions',{transactions:[tx('one',{insider:'Alice Doe',insiderCik:'123'}),tx('two',{insider:'Doe, Alice'})]});await runInsiderMovementAlerts(h.env,[h.user],c.options);
  assert.equal(c.events.length,2);assert.equal(c.events[0][1].convergence,undefined);
});

test('reversed buyer and activist names are the same actor and ambiguous names remain unidentified',async()=>{
  for(const purchases of [[tx('one',{insider:'Alice Doe',insiderCik:'123'})],[tx('one',{insider:'Alice Doe',insiderCik:'123'}),tx('two',{insider:'Alice Doe',insiderCik:'456'})]]){
    const h=harness(),c=capture(h);h.store.set('insider-transactions',{transactions:purchases});h.store.set('13dg-recent',{filings:[]});await runInsiderMovementAlerts(h.env,[h.user],c.options);
    h.store.set('13dg-recent',{filings:[activist('new',{filerName:'Doe, Alice',filerCik:''})]});await runInsiderMovementAlerts(h.env,[h.user],c.options);assert.equal(c.events.length,0);
  }
});
