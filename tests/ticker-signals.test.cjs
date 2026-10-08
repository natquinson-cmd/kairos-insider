const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const context={window:{}};
vm.runInNewContext(fs.readFileSync('assets/clarity/ticker.js','utf8'),context);
const map=context.window.KairosTicker.fromFeed;

test('ticker distinguishes purchase amounts from ownership percentages and changes',()=>{
 const purchase=map({type:'cluster',ticker:'BBD',label:'CLUSTER · 19 insiders',value:'$25.7M',color:'green'});
 assert.equal(purchase.detail,'Achats cumulés $25.7M');assert.equal(purchase.tone,'buy');
 const holding=map({type:'activist',ticker:'ABC',label:'Investor',value:'6.5%',color:'orange'});
 assert.equal(holding.detail,'Participation 6.5%');assert.equal(holding.tone,'fund');
 const change=map({type:'threshold',ticker:'ABC',value:'▲+1.50pt → 7.50%',color:'orange'},{lang:'en'});
 assert.equal(change.detail,'Ownership ▲+1.50pt → 7.50%');assert.equal(change.tone,'fund');
});
test('ticker does not invent a size or turn a score or search spike into a trade',()=>{
 assert.equal(map({type:'cluster',ticker:'ABC'}).detail,'');
 assert.equal(map({type:'cluster',value:0}).detail,'Achats cumulés 0');
 assert.equal(map({type:'score',value:'85/100',color:'green'}).detail,'Score Kairos 85/100');
 const trend=map({type:'trend',value:'+150%',color:'red'},{lang:'en'});
 assert.equal(trend.detail,'Search interest +150%');assert.equal(trend.tone,'fund');
});
