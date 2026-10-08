const {test}=require('node:test'),assert=require('node:assert/strict');
const chart=require('../assets/clarity/chart-events.js');
const operation=(id,overrides={})=>({id,type:'buy',publicationDate:'2026-10-05',date:'2026-10-05',tradeDate:'2026-08-31',amount:1000,currency:'BRL',insiderName:'Example person',insiderId:'123',role:'Director',shares:50,...overrides});

test('many executions become a single button while every original operation remains available',()=>{
  const events=Array.from({length:50},(_,i)=>operation('tx-'+i));
  const groups=chart.group(events),html=chart.choices(groups,'tx-35');
  assert.equal(groups.length,1);assert.equal(groups[0].totals[0].amount,50000);
  assert.equal((html.match(/<button /g)||[]).length,1);assert.match(html,/50 achats/);assert.match(html,/aria-expanded="true"/);
  const details=chart.details(chart.selected(groups,'tx-35'),'tx-35');
  assert.equal((details.match(/data-operation-id=/g)||[]).length,50);
  for(const event of events)assert.ok(details.includes(`data-operation-id="${event.id}"`));
  assert.match(details,/data-operation-id="tx-35" class="is-selected"/);
  assert.match(details,/1 déclarant identifié/);
  assert.match(details,/31 août 2026/);assert.match(details,/5 oct. 2026/);
});
test('filing date and side determine groups, not execution or shared chart session',()=>{
  const events=[operation('a',{publicationDate:'2026-09-19',date:'2026-09-21'}),operation('b',{publicationDate:'2026-09-20',date:'2026-09-21'}),operation('c',{publicationDate:'2026-09-20',date:'2026-09-21',type:'sell'}),operation('d',{publicationDate:'2026-09-19',date:'2026-09-21',tradeDate:'2026-09-15'})];
  const groups=chart.group(events);assert.equal(groups.length,3);
  assert.deepEqual(groups.map(x=>[x.publicationDate,x.type,x.events.length]),[['2026-09-20','buy',1],['2026-09-20','sell',1],['2026-09-19','buy',2]]);
  assert.equal(chart.selected(groups,'c').type,'sell');
  assert.equal(chart.selected(chart.group(events.filter(x=>x.id!=='c')),'c'),null);
  assert.equal(chart.details(null,'c'),'');
});
test('currencies never net together, partial totals are explicit, zero is not missing',()=>{
  const groups=chart.group([operation('a'),operation('b',{currency:'EUR',amount:20}),operation('c',{amount:null}),operation('d',{amount:0}),operation('e',{amount:NaN})]);
  assert.deepEqual(groups[0].totals,[{currency:'BRL',amount:1000},{currency:'EUR',amount:20}]);assert.equal(groups[0].missingAmounts,2);
  assert.match(chart.choices(groups,null),/BRL \+ 20 EUR/);assert.match(chart.choices(groups,null),/partiel/);
  assert.match(chart.details(groups[0],'a','en'),/2 amount\(s\) unavailable: the total is partial/);
  const missing=chart.group([operation('missing',{amount:null})])[0];assert.match(chart.details(missing,'missing'),/aucun total disponible/);assert.doesNotMatch(chart.choices([missing],null),/>0 /);
});
test('identical-looking executions are preserved, and activist filings do not enter insider groups',()=>{
  const groups=chart.group([operation('a'),operation('b'),operation('star',{type:'activist'})]);
  assert.equal(groups.length,1);assert.deepEqual(groups[0].events.map(x=>x.id),['a','b']);
});
test('details retain plan context and safe source links, escape names and keep both languages readable',()=>{
  const item=chart.group([operation('a',{insiderName:'<img onerror=alert(1)>',planned:true,sourceUrl:'https://www.sec.gov/example?a=1&b=2'}),operation('b',{sourceUrl:'javascript:alert(1)'})])[0];
  const en=chart.details(item,'a','en'),fr=chart.details(item,'a','fr');
  assert.match(en,/Planned · 10b5-1/);assert.match(en,/Reporting person/);assert.match(en,/2 purchases/);assert.match(fr,/2 achats/);
  assert.match(en,/&lt;img onerror=alert\(1\)&gt;/);assert.doesNotMatch(en,/<img|javascript:/);
  assert.match(en,/https:\/\/www.sec.gov\/example\?a=1&amp;b=2/);
  assert.match(en,/rel="noopener noreferrer"/);assert.match(en,/Unavailable/);
});
test('a missing filing date is never relabeled with the chart session',()=>{
  const item=chart.group([operation('a',{publicationDate:null})])[0];
  assert.match(chart.choices([item],null,'en'),/Date unavailable/);
  assert.doesNotMatch(chart.choices([item],null,'en'),/Oct/);
});
