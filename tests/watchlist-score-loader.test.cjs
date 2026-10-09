const {test}=require('node:test'),assert=require('node:assert/strict');
const {create}=require('../assets/clarity/watchlist-score-loader.js');
const item=(ticker,score=74)=>({ticker,score,scoreAt:'2026-10-09T12:00:00Z',scoreStatus:'available',scoreSource:'analysis',scoreVersion:'v26'});
const turn=()=>new Promise(resolve=>setImmediate(resolve));
test('missing and historical scores load automatically in a sequential bounded queue',async()=>{
 const calls=[],changes=[],resolves=[];const loader=create({api:async(path,options)=>{calls.push({path,options});return new Promise(resolve=>resolves.push(resolve));},onChange:event=>changes.push(event)});
 loader.load([{ticker:'AVGO',score:null},{ticker:'MSFT',score:69,scoreStatus:'historical'},{ticker:'NVDA',score:78,scoreStatus:'available'}]);
 await turn();assert.equal(calls.length,1);assert.equal(JSON.parse(calls[0].options.body).symbol,'AVGO');assert.match(calls[0].path,/watchlist\/score$/);
 resolves.shift()({ok:true,item:item('AVGO')});await turn();assert.equal(calls.length,2);
 resolves.shift()({ok:true,item:item('MSFT',70)});await turn();assert.equal(calls.length,2);
 assert.equal(changes.findLast(e=>e.ticker==='MSFT').item.score,70);assert.equal(changes.findLast(e=>e.ticker==='AVGO').state,'ready');loader.stop();
});
test('failure remains retryable and an invalid or undated score never replaces the row',async()=>{
 let calls=0;const changes=[];const loader=create({api:async()=>{calls++;return calls===1?{ok:false,state:'unavailable'}:{ok:true,item:{ticker:'AVGO',score:75}};},onChange:event=>changes.push(event)});
 loader.load([{ticker:'AVGO',score:70,scoreStatus:'historical'}]);await turn();assert.equal(changes.at(-1).state,'error');assert.equal(calls,1);
 loader.retry('AVGO');await turn();assert.equal(calls,2);assert.equal(changes.at(-1).state,'error');assert.equal(changes.at(-1).item,undefined);loader.stop();
});
test('removing a watched ticker prevents an old response from restoring its score',async()=>{
 let finish;const changes=[];const loader=create({api:()=>new Promise(resolve=>finish=resolve),onChange:event=>changes.push(event)});
 loader.load([{ticker:'AVGO'}]);await turn();loader.load([]);finish({ok:true,item:item('AVGO')});await turn();assert.ok(!changes.some(e=>e.state==='ready'));loader.stop();
});
test('queue accepts at most 100 unique valid symbols and never schedules a loaded current score',async()=>{
 const calls=[];const loader=create({api:async(_,options)=>{const ticker=JSON.parse(options.body).symbol;calls.push(ticker);return {ok:true,item:item(ticker)};},onChange(){}});
 loader.load([{ticker:'../bad'},...Array.from({length:110},(_,i)=>({ticker:'T'+i})),{ticker:'T0'}]);
 for(let i=0;i<4;i++)await turn();assert.equal(calls.length,100);assert.equal(new Set(calls).size,100);loader.stop();
});
test('a busy shared calculation retries automatically twice at most and then reports a real failure',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0;const changes=[];
 const loader=create({api:async()=>{calls++;return {ok:false,state:'busy',retryAfterSeconds:120};},onChange:e=>changes.push(e)});
 loader.load([{ticker:'AVGO'}]);await turn();assert.equal(calls,1);assert.equal(changes.at(-1).state,'queued');
 t.mock.timers.tick(5000);await turn();assert.equal(calls,2);
 t.mock.timers.tick(5000);await turn();assert.equal(calls,3);assert.equal(changes.at(-1).state,'error');
 t.mock.timers.tick(120000);await turn();assert.equal(calls,3);loader.stop();
});
test('leaving the list cancels a pending busy retry and a stalled calculation ends in an explicit error',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0;const changes=[];
 const loader=create({api:async()=>{calls++;return {ok:false,state:'busy',retryAfterSeconds:5};},onChange:e=>changes.push(e)});
 loader.load([{ticker:'AVGO'}]);await turn();loader.stop();t.mock.timers.tick(5000);await turn();assert.equal(calls,1);
 const stalled=create({api:()=>new Promise(()=>{}),onChange:e=>changes.push(e)});
 stalled.load([{ticker:'MSFT'}]);await turn();t.mock.timers.tick(90000);await turn();assert.equal(changes.at(-1).ticker,'MSFT');assert.equal(changes.at(-1).state,'error');stalled.stop();
});
