const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const code=fs.readFileSync('assets/clarity/live-market.js','utf8'),model=require('../assets/clarity/live-market-model.js');
const day=new Date().toISOString().slice(0,10),buy={ticker:'ABC',company:'Example',type:'buy',transCode:'P',insider:'Alice',insiderCik:'1',fileDate:day,date:day,value:250,currency:'USD',url:'https://www.sec.gov/filing'};
async function mount(search='',{transactions=[buy],filings=[],activistFailure=false,lang='en'}={}){
 const nodes=new Map(),calls=[];function node(id){if(nodes.has(id))return nodes.get(id);const n={id,hidden:false,value:'',innerHTML:'',textContent:'',dataset:{},classList:{toggle(){}},removeAttribute(){},scrollIntoView(){},insertAdjacentHTML(_,html){this.innerHTML=html+this.innerHTML;},querySelector:s=>node(id+s),querySelectorAll:()=>[]};nodes.set(id,n);return n;}
 const document={getElementById:node,querySelectorAll:()=>[],createElement:()=>({}),head:{append(s){s.onload();}}};
 const U={lang,t:(fr,en)=>lang==='fr'?fr:en,esc:s=>String(s??'').replace(/[<>&"]/g,'_'),format:n=>String(n),stockUrl:s=>'dashboard.html?symbol='+s,translate(){},showError(el,err){el.textContent=err.message;},api:async path=>{calls.push(path);if(path.startsWith('/api/13dg')){if(activistFailure)throw Error('offline');return {filings,total:2001,updatedAt:day};}return {transactions,updatedAt:day};}};
 await vm.runInNewContext(code,{window:{KairosUI:U,KairosAdapter:require('../assets/clarity/live-adapter.js'),KairosSignalContext:require('../assets/clarity/signal-context.js'),KairosMarketLive:model,KairosInsiderTransaction:require('../assets/insider-transaction.js')},document,location:{search},history:{replaceState(){}},URL,URLSearchParams,Date,Map,Set});return {node,calls};
}
test('default purchase screener shows grouped buyers, dates and stock follow actions',async()=>{const h=await mount();assert.match(h.node('marketTitle').textContent,/Purchases/);assert.match(h.node('marketTabs').innerHTML,/view=purchases/);assert.match(h.node('marketControls').innerHTML,/value="7" selected/);assert.match(h.node('marketResults').innerHTML,/ABC/);assert.match(h.node('marketResults').innerHTML,/Stock & watchlist/);assert.match(h.node('marketResults').innerHTML,/Original filing/);assert.match(h.node('marketResults').innerHTML,/Filed \/ executed/);});
test('failed activist source is unavailable rather than a zero-result crossover',async()=>{const h=await mount('?view=activist-crossovers',{activistFailure:true});assert.match(h.node('marketResults').innerHTML,/unavailable/i);assert.doesNotMatch(h.node('marketResults').innerHTML,/No results|No crossovers/);assert.equal(h.calls.some(x=>x.includes('activistOnly=false&limit=2000')),true);});
test('crossover coverage reports capped source even if few qualifying matches are returned',async()=>{const h=await mount('?view=activist-crossovers');assert.match(h.node('marketResults').innerHTML,/2,000/);assert.match(h.node('marketResults').innerHTML,/initial|filing/i);});
test('legacy transaction deep link still displays sales and its 90-day period',async()=>{const h=await mount('?view=transactions&days=90&type=sell',{transactions:[{...buy,type:'sell',transCode:'S'}]});assert.match(h.node('marketResults').innerHTML,/Disclosed sale/);assert.match(h.node('marketControls').innerHTML,/value="90" selected/);});

test('the archive explains excluded purchases while the screener requires evidence',async()=>{
 const transactions=[{...buy,transCode:null,insider:'Legacy',insiderCik:'2'},{...buy,code:'A',transCode:null,insider:'Award recipient',insiderCik:'3'},{...buy,code:'P',form10b5One:true,insider:'Documented buyer',insiderCik:'4'}];
 const archive=await mount('?view=transactions',{transactions});
 assert.match(archive.node('marketResults').innerHTML,/Acquisition to verify/);assert.match(archive.node('marketResults').innerHTML,/Share award/);assert.match(archive.node('marketResults').innerHTML,/Excluded from purchase signals/);assert.match(archive.node('marketResults').innerHTML,/Planned · 10b5-1/);
 const screen=await mount('?view=purchases',{transactions});assert.match(screen.node('marketResults').innerHTML,/Documented buyer/);assert.doesNotMatch(screen.node('marketResults').innerHTML,/Award recipient|Legacy/);assert.match(screen.node('marketResults').innerHTML,/Which purchases qualify/);
});
test('crossover requires a valid execution in the last 30 days and never uses undated or impossible purchases',async()=>{
 const filings=[{ticker:'ABC',form:'13D',isActivist:true,isFirstFiling:true,fileDate:day,filerName:'Other Capital',filerCik:'9'}],offset=days=>new Date(Date.now()+days*86400000).toISOString().slice(0,10);
 const fresh=await mount('?view=activist-crossovers',{filings});assert.match(fresh.node('marketResults').innerHTML,/class="purchase-row"/);
 for(const extra of [{date:offset(-60)},{date:null},{date:offset(1)},{fileDate:offset(-1),date:day}]){const result=await mount('?view=activist-crossovers',{filings,transactions:[{...buy,...extra}]});assert.doesNotMatch(result.node('marketResults').innerHTML,/class="purchase-row"/);}
 const recent=await mount('?view=purchases',{transactions:[{...buy,date:offset(-60)}]});assert.match(recent.node('marketResults').innerHTML,/class="purchase-row"/);
});

test('convergence scan counts distinct people and shows the actual execution span, not the filter window',async()=>{
 const prior=days=>new Date(Date.now()-days*86400000).toISOString().slice(0,10);
 const h=await mount('?view=convergences&windowDays=30',{transactions:[{...buy,date:prior(2)},{...buy,date:prior(1),value:500},{...buy,insider:'Bob',insiderCik:'2',value:125}]});
 const html=h.node('marketResults').innerHTML,summary=html.split('class="purchase-row"')[1].split('class="purchase-detail-row"')[0];
 assert.match(summary,/2 distinct insider buyers/);assert.match(summary,/3 qualifying purchases/);assert.match(summary,/875 USD/);
 assert.match(summary,/Purchases executed:/);assert.match(summary,new RegExp(new Date(prior(2)+'T12:00:00Z').toLocaleDateString('en-US',{day:'numeric',month:'short',year:'numeric'})));
 assert.doesNotMatch(summary,new RegExp(new Date(prior(29)+'T12:00:00Z').toLocaleDateString('en-US',{day:'numeric',month:'short',year:'numeric'})));
});

test('unverified and excluded acquisitions remain neutral, with visible exclusion and expandable reasons',async()=>{
 const h=await mount('?view=transactions',{transactions:[{...buy,insider:'Unknown evidence',transCode:null},{...buy,insider:'Employee purchase',transactionFootnotes:[{text:'Employee stock purchase plan.'}]}]});
 const html=h.node('marketResults').innerHTML;
 assert.match(html,/data-qualification="unknown">Acquisition to verify/);assert.match(html,/data-qualification="excluded">Employee plan/);
 assert.match(html,/Outside purchase signals/);assert.match(html,/details class="market-qualification"/);assert.doesNotMatch(html,/live-pill positive/);
});

test('missing filing date is explicit beside execution and never replaced with the trade date',async()=>{
 const h=await mount('?view=transactions&days=all',{transactions:[{...buy,fileDate:null}]});const html=h.node('marketResults').innerHTML;
 assert.match(html,/Filed: <time>Date unavailable<\/time>/);assert.match(html,new RegExp('Executed: <time datetime="'+day+'"'));
});

test('a fresh filing of an older purchase keeps the delay explicit and uses the same French reading labels',async()=>{
 const date=new Date(Date.now()-20*86400000).toISOString().slice(0,10);
 const h=await mount('?view=transactions',{lang:'fr',transactions:[{...buy,date}]});const html=h.node('marketResults').innerHTML;
 assert.match(html,/Achat retenu/);assert.match(html,/Publication \/ exécution/);assert.match(html,/Publié :/);assert.match(html,/Exécuté :/);
 assert.match(html,/Publication 20 jours après l’opération/);assert.match(html,/market-date-warning/);
});

test('activist declarations are presented as reported stakes, not recent executed purchases',async()=>{
 const h=await mount('?screen=activists',{filings:[{ticker:'ABC',targetName:'Example',form:'13D',isActivist:true,fileDate:day,percentOfClass:5,percentDelta:1.2,filerName:'Other Capital'}]});
 const html=h.node('marketResults').innerHTML;assert.match(html,/ownership is not a recent purchase/);assert.match(html,/Change · points/);assert.match(html,/1.2 pt/);assert.doesNotMatch(html,/Qualifying purchase/);
});

test('today archive means only the UTC publication date, regardless of the execution date',async()=>{
 const yesterday=new Date(Date.now()-86400000).toISOString().slice(0,10),transactions=[{...buy,ticker:'TODAY',date:yesterday},{...buy,ticker:'YESTERDAY',fileDate:yesterday,date:day},{...buy,ticker:'ALIAS',fileDate:null,filingDate:day,date:yesterday},{...buy,ticker:'UNDATED',fileDate:null,date:day}];
 const h=await mount('?view=transactions&days=1',{transactions}),html=h.node('marketResults').innerHTML;
 assert.match(html,/>TODAY</);assert.match(html,/>ALIAS</);assert.doesNotMatch(html,/>YESTERDAY<|>UNDATED</);
});

test('all-date archive keeps unknown publications last and never sorts by execution',async()=>{
 const yesterday=new Date(Date.now()-86400000).toISOString().slice(0,10),transactions=[{...buy,ticker:'UNDATED',fileDate:null,date:day},{...buy,ticker:'YESTERDAY',fileDate:null,filingDate:yesterday,date:day},{...buy,ticker:'TODAY',date:yesterday}];
 const h=await mount('?view=transactions&days=all',{transactions}),html=h.node('marketResults').innerHTML;
 assert.ok(html.indexOf('>TODAY<')<html.indexOf('>YESTERDAY<'));assert.ok(html.indexOf('>YESTERDAY<')<html.indexOf('>UNDATED<'));
 const recent=await mount('?view=transactions&days=7',{transactions});assert.doesNotMatch(recent.node('marketResults').innerHTML,/>UNDATED</);
});

test('activist today filter accepts filingDate alias and does not use an event date as publication',async()=>{
 const yesterday=new Date(Date.now()-86400000).toISOString().slice(0,10),base={form:'13D',isActivist:true,filerName:'Other Capital'};
 const h=await mount('?screen=activists&days=1',{filings:[{...base,ticker:'TODAY',filingDate:day,date:yesterday},{...base,ticker:'YESTERDAY',fileDate:yesterday,date:day},{...base,ticker:'UNDATED',date:day}]}),html=h.node('marketResults').innerHTML;
 assert.match(html,/>TODAY</);assert.doesNotMatch(html,/>YESTERDAY<|>UNDATED</);
});
