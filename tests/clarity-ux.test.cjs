const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const adapter=require('../assets/clarity/live-adapter.js');
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;');
function ui(lang='en'){return {lang,t:(fr,en)=>lang==='fr'?fr:en,esc:escape,format:value=>value==null?'—':String(value),stockUrl:ticker=>'dashboard.html?symbol='+ticker,translate(){},showError(el,error){throw error;}};}
function calendar(next,lang='en',history=[],ticker='T'){
 const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id);};
 const window={KairosUI:ui(lang),KairosAdapter:adapter};
 vm.runInNewContext(fs.readFileSync('assets/clarity/live-stock-views.js','utf8'),{window,document:{getElementById:node},URLSearchParams});
 window.KairosStockViews.calendar({ticker,raw:{ticker,earnings:{next,history}},currency:'USD'});return node('calendarContent').innerHTML;
}
test('calendar distinguishes a missing date from an estimate, including contradictory confirmation flags',()=>{
 for(const next of [undefined,{}, {date:null,confirmed:true},{date:'invalid',confirmed:true}]){
  const html=calendar(next);assert.match(html,/Date unavailable/);assert.doesNotMatch(html,/>Confirmed<|Estimated · unconfirmed/);
 }
 assert.match(calendar(undefined,'fr'),/Date indisponible/);
 assert.match(calendar({date:'2026-11-05',confirmed:false}),/Estimated · unconfirmed/);
 assert.match(calendar({date:'2026-11-05',confirmed:true}),/>Confirmed</);
});
test('earnings calendar preserves uncertain date ranges and never borrows the quote currency for EPS',()=>{
 const next={date:'2026-11-05',dateEnd:'2026-11-08',confirmed:false,epsEst:1.25,currency:null};
 const html=calendar(next);assert.match(html,/Nov 5, 2026 – Nov 8, 2026/);assert.match(html,/Estimated EPS/);assert.match(html,/Estimated · unconfirmed/);assert.doesNotMatch(html,/1.25 USD/);
 assert.match(calendar({...next,currency:'EUR'}),/1.25 EUR/);
 const fr=calendar(next,'fr');assert.match(fr,/5 nov\. 2026 – 8 nov\. 2026/);assert.match(fr,/BPA estimé/);assert.doesNotMatch(fr,/1.25 USD/);
});
test('earnings history distinguishes a quarter end from an actual publication in both languages',()=>{
 const history=[{period:'Q2',year:2026,date:null,dateType:'period-end',periodEnd:'2026-06-30',epsActual:7.58,epsEst:6.93,epsSurprisePct:9.4},{period:'Q1',year:2026,date:'2026-04-15',epsActual:7.15,epsEst:6.67}];
 const en=calendar(null,'en',history);assert.match(en,/Period \/ publication/);assert.match(en,/Period ended Jun 30, 2026/);assert.match(en,/Published Apr 15, 2026/);
 const fr=calendar(null,'fr',history);assert.match(fr,/Période au 30 juin 2026/);assert.match(fr,/Publié le 15 avr\. 2026/);
});
test('ADR earnings identify their source listing once without assuming conversion or currency',()=>{
 const next={date:'2026-11-05',epsEst:1.25,sourceSymbol:'LVMUY'},history=[{period:'Q2',year:2026,sourceSymbol:'LVMUY',epsActual:1.1},{period:'Q1',year:2026,sourceSymbol:'MC.PA',epsActual:1}];
 const en=calendar(next,'en',history,'MC.PA');assert.match(en,/EPS figures for LVMUY refer to their source listings and are shown without conversion/);assert.equal(en.match(/LVMUY/g).length,1);assert.doesNotMatch(en,/1.25 USD/);
 const fr=calendar(next,'fr',history,'MC.PA');assert.match(fr,/BPA de LVMUY se rapportent à leur cotation d’origine et sont affichés sans conversion/);
 assert.doesNotMatch(calendar({...next,sourceSymbol:'MC.PA'},'en',[],'MC.PA'),/without conversion/);
 assert.doesNotMatch(calendar({...next,sourceSymbol:'<img onerror=x>'},'en',[],'MC.PA'),/<img|without conversion/);
});
async function market(search='?screen=funds',lang='en'){
 const nodes=new Map(),document={activeElement:null,getElementById:node,querySelectorAll:()=>[]};
 function node(id){
  if(nodes.has(id))return nodes.get(id);
  const element={id,hidden:id==='marketDetail',isConnected:true,value:'',innerHTML:'',textContent:'',dataset:{},attributes:{},classList:{toggle(){}},
   setAttribute(key,value){this.attributes[key]=String(value);},removeAttribute(key){delete this.attributes[key];},scrollIntoView(){},focus(){document.activeElement=this;},
   insertAdjacentHTML(_,html){this.innerHTML=html+this.innerHTML;},
   querySelector(selector){return selector==='#marketDetailTitle'?node('marketDetailTitle'):node(id+selector);},
   querySelectorAll(selector){if(id==='marketResults'&&selector==='[data-fund]'&&this.innerHTML.includes('data-fund=')){const button=node('fundButton');button.dataset.fund='0';return [button];}return [];}};
  nodes.set(id,element);return element;
 }
 const funds=[{fundName:'Example Capital',reportDate:'2026-06-30',totalValue:1000,holdingsCount:1,topHoldings:[]}];
 const U={...ui(lang),api:async path=>path==='/api/13f-funds'?funds:{consensus:[{ticker:'ABC',name:'Example',fundCount:2,totalValue:300,avgPctOfPortfolio:1.5}]}};
 const window={KairosUI:U,KairosAdapter:adapter,KairosSignalContext:require('../assets/clarity/signal-context.js'),KairosFundBrands:{displayName:f=>f.fundName,markup:()=>'',hydrate(){}}};
 await vm.runInNewContext(fs.readFileSync('assets/clarity/live-market.js','utf8'),{window,document,location:{search},history:{replaceState(){}},URL,URLSearchParams});
 return {node,document};
}
test('common holdings explain ranking, coverage and portfolio-weight denominator in both languages',async()=>{
 const en=await market('?screen=funds&view=consensus');let html=en.node('marketResults').innerHTML;
 assert.match(html,/200/);assert.match(html,/0\.3/);assert.match(html,/different dates/);assert.match(html,/Mean portfolio weight/);
 const fr=await market('?screen=funds&view=consensus','fr');html=fr.node('marketResults').innerHTML;
 assert.match(html,/0,3/);assert.match(html,/dates différentes/);assert.match(html,/Poids moyen du portefeuille/);
});
test('opening a fund detail moves focus into it, Escape closes it and restores the trigger',async()=>{
 const {node,document}=await market(),trigger=node('fundButton');trigger.focus();trigger.onclick();
 assert.equal(node('marketDetail').hidden,false);assert.equal(document.activeElement,node('marketDetailTitle'));
 let prevented=false;node('marketDetail').onkeydown?.({key:'Escape',preventDefault(){prevented=true;},stopPropagation(){}});
 assert.equal(prevented,true);assert.equal(node('marketDetail').hidden,true);assert.equal(document.activeElement,trigger);
 trigger.onclick();node('marketDetail').querySelector('[data-close]').onclick();assert.equal(document.activeElement,trigger);
});
test('pointer activation also remembers its trigger and safely falls back when results have changed',async()=>{
 const {node,document}=await market(),trigger=node('fundButton');trigger.onclick();
 node('marketDetail').querySelector('[data-close]').onclick();assert.equal(document.activeElement,trigger);
 trigger.onclick();trigger.isConnected=false;node('marketDetail').querySelector('[data-close]').onclick();
 assert.equal(document.activeElement,node('marketTitle'));assert.equal(node('marketTitle').attributes.tabindex,'-1');
});

test('fund dates pair the holding observation with its filing without inventing a purchase date',async()=>{
 const {node}=await market(),html=node('marketResults').innerHTML;
 assert.match(html,/neither identifies a purchase date/);assert.match(html,/Filed: <time>Date unavailable<\/time>/);
 assert.match(html,/Holdings as of: <time datetime="2026-06-30">/);assert.doesNotMatch(html,/Executed:|Qualifying purchase/);
 const fr=await market('?screen=funds','fr');assert.match(fr.node('marketResults').innerHTML,/Positions au :/);assert.match(fr.node('marketResults').innerHTML,/ne donnent pas la date d’achat/);
});
