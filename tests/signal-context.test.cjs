const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const api=require('../assets/clarity/signal-context.js');

test('publication freshness never substitutes the date of execution',()=>{
 const result=api.dates({fileDate:'2026-10-07',date:'2026-08-01'},{lang:'en',now:'2026-10-08'});
 assert.equal(result.publication.ageDays,1);
 assert.equal(result.publication.ageLabel,'Published yesterday');
 assert.equal(result.execution.date,'2026-08-01');
 assert.equal(result.execution.freshness,'older');
 assert.match(result.warnings.join(' '),/67 days after/);
 assert.equal(api.dates({fileDate:'2026-10-07'},{lang:'en',now:'2026-10-08'}).execution.date,null);
});

test('invalid and future dates cannot become fresh information',()=>{
 for(const value of [null,'','2026-02-30','2026-13-01','2026-01-01 garbage'])assert.equal(api.day(value),null);
 const result=api.dates({fileDate:'2026-10-09',tradeDate:'2026-10-10'},{lang:'fr',now:'2026-10-08'});
 assert.equal(result.publication.freshness,'future');
 assert.equal(result.publication.ageDays,null);
 assert.equal(result.execution.freshness,'future');
 assert.match(result.publication.warning,/future/);
 assert.doesNotMatch(result.publication.ageLabel,/hier|aujourd’hui/);
 const missing=api.dates({fileDate:'2026-02-30',tradeDate:''},{lang:'en',now:'2026-10-08'});
 assert.equal(missing.publication.freshness,'unknown');
 assert.equal(missing.execution.text,'Date unavailable');
});

test('an eligible purchase label describes evidence without guaranteeing intention',()=>{
 const result=api.qualification({code:'P',source:'sec',transactionFootnotes:['Open-market purchase.']},{lang:'fr'});
 assert.equal(result.status,'eligible');assert.equal(result.tone,'positive');
 assert.equal(result.label,'Achat retenu');assert.match(result.detail,/ne prouve pas/);
 const planned=api.qualification({code:'P',form10b5One:true},{lang:'en'});
 assert.equal(planned.planned,true);assert.match(planned.detail,/10b5-1/);
});

test('source exclusions win over contradictory normalized acquisition flags',()=>{
 const result=api.qualification({code:'A',type:'buy',purchaseSignalEligible:true,purchaseSignalStatus:'eligible'},{lang:'en'});
 assert.equal(result.status,'excluded');assert.equal(result.tone,'neutral');assert.match(result.label,/award/i);
 const normalized=api.qualification({type:'buy',purchaseSignalEligible:false,purchaseSignalStatus:'excluded',purchaseSignalReason:'employee-plan'},{lang:'fr'});
 assert.equal(normalized.status,'excluded');assert.match(normalized.detail,/Exclu/);
});

test('transported qualification is accepted only as a coherent complete classification',()=>{
 const normalized={type:'buy',purchaseSignalEligible:true,purchaseSignalStatus:'eligible',purchaseSignalReason:'reported-purchase'};
 assert.equal(api.qualification(normalized,{lang:'en'}).eligiblePurchase,true);
 for(const row of [{type:'buy'},{type:'buy',purchaseSignalEligible:true},{...normalized,purchaseSignalEligible:false},{...normalized,purchaseSignalReason:'employee-plan'}]){
  assert.notEqual(api.qualification(row,{lang:'en'}).tone,'positive');
 }
 assert.equal(api.qualification({type:'sell'},{lang:'fr'}).label,'Vente déclarée');
});

test('browser and CommonJS share the same presentation without producing HTML',()=>{
 const window={KairosInsiderTransaction:require('../assets/insider-transaction.js')};
 vm.runInNewContext(fs.readFileSync('assets/clarity/signal-context.js','utf8'),{window,Date,Intl});
 assert.equal(window.KairosSignalContext.qualification({code:'P'},{lang:'en'}).label,api.qualification({code:'P'},{lang:'en'}).label);
 assert.doesNotMatch(api.qualification({type:'buy',purchaseSignalReason:'<script>'},{lang:'en'}).detail,/<script>/);
});
