const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const adapter=require('../assets/clarity/live-adapter.js');
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;');
function ui(lang='en'){return {lang,t:(fr,en)=>lang==='fr'?fr:en,esc:escape,format:value=>value==null?'—':String(value),stockUrl:ticker=>'dashboard.html?symbol='+ticker,translate(){},showError(el,error){throw error;}};}
function calendar(next,lang='en'){
 const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id);};
 const window={KairosUI:ui(lang),KairosAdapter:adapter};
 vm.runInNewContext(fs.readFileSync('assets/clarity/live-stock-views.js','utf8'),{window,document:{getElementById:node},URLSearchParams});
 window.KairosStockViews.calendar({raw:{earnings:{next,history:[]}},currency:'USD'});return node('calendarContent').innerHTML;
}
test('calendar distinguishes a missing date from an estimate, including contradictory confirmation flags',()=>{
 for(const next of [undefined,{}, {date:null,confirmed:true},{date:'invalid',confirmed:true}]){
  const html=calendar(next);assert.match(html,/Date unavailable/);assert.doesNotMatch(html,/>Confirmed<|Estimated · unconfirmed/);
 }
 assert.match(calendar(undefined,'fr'),/Date indisponible/);
 assert.match(calendar({date:'2026-11-05',confirmed:false}),/Estimated · unconfirmed/);
 assert.match(calendar({date:'2026-11-05',confirmed:true}),/>Confirmed</);
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
 const window={KairosUI:U,KairosAdapter:adapter,KairosFundBrands:{displayName:f=>f.fundName,markup:()=>'',hydrate(){}}};
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
