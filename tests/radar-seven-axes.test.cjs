const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const read=name=>fs.readFileSync(require.resolve('../'+name),'utf8');
function radar(options={}){
 const elements=new Map();let focused=null;
 const element=selector=>{if(!elements.has(selector))elements.set(selector,{innerHTML:'',hidden:true,events:{},dataset:{krAxis:selector.match(/\d+/)?.[0]},classList:{toggle(){},remove(){}},setAttribute(){},addEventListener(type,fn){this.events[type]=fn;},focus(){focused=selector;}});return elements.get(selector);};
 const host={clientWidth:340,clientHeight:310,innerHTML:'',getBoundingClientRect(){return{};},querySelector:element,querySelectorAll(){return [...this.innerHTML.matchAll(/data-kr-axis="(\d+)"/g)].map(match=>element(`[data-kr-axis="${match[1]}"]`));}};
 const window={};vm.runInNewContext(read('assets/clarity/radar.js'),{window});
 const result=window.KairosRadar.render(host,{values:[21,42,63,84,45,66,87],...options});
 return {host,result,element,focused:()=>focused};
}
test('radar renders seven distinct spokes and preserves health/earnings positions',()=>{
 const {host,result}=radar(),axes=[...host.innerHTML.matchAll(/<g class="kr-axis"[^>]*aria-label="([^"]+)"[^>]*data-kr-axis="(\d+)"/g)];
 assert.equal(axes.length,7);assert.equal(result.values.length,7);
 assert.deepEqual(axes.map(m=>m[1].split(' : ')[0]),['Dirigeants','Hedge funds','Momentum du cours','Valorisation','Consensus analystes','Santé financière','Momentum des résultats']);
 assert.match(axes[5][1],/66 sur 100/);assert.match(axes[6][1],/87 sur 100/);
 const grid=host.innerHTML.match(/<polygon points="([^"]+)" class="kr-grid kr-grid-outer"/)[1].split(' ');
 assert.equal(grid.length,7);assert.equal(new Set(grid).size,7);
 assert.equal((host.innerHTML.match(/class="kr-spoke"/g)||[]).length,7);
 assert.doesNotMatch(host.innerHTML,/Politicien|gourou|Huit dimensions|data-kr-axis="7"/);
});
test('seven-axis keyboard navigation wraps and health tooltip follows its new index',()=>{
 const {element,focused}=radar();
 element('[data-kr-axis="6"]').events.keydown({key:'ArrowRight',preventDefault(){}});assert.equal(focused(),'[data-kr-axis="0"]');
 element('[data-kr-axis="0"]').events.keydown({key:'ArrowLeft',preventDefault(){}});assert.equal(focused(),'[data-kr-axis="6"]');
 element('[data-kr-axis="5"]').events.pointerenter();assert.match(element('.kr-tooltip').innerHTML,/Santé financière/);assert.match(element('.kr-tooltip').innerHTML,/66<span>/);
});
test('normalized seven-axis weights compute score without changing geometry',()=>{
 const weights=[22.22,22.22,16.67,11.11,11.11,11.11,5.56];
 const weighted=radar({weights}),unweighted=radar();
 assert.ok(Math.abs(weighted.result.score-[21,42,63,84,45,66,87].reduce((sum,value,index)=>sum+value*weights[index]/100,0))<1e-9);
 const points=html=>html.match(/<polygon points="([^"]+)" fill="none" stroke="#739efb"/)[1];
 assert.equal(points(weighted.host.innerHTML),points(unweighted.host.innerHTML));
 assert.equal(radar({weights,values:[21,42,63,84,45,null,87]}).result.score,null);
});
test('public radar copy and homepage illustration describe seven axes in both languages',()=>{
 const window={KairosI18n:{DICT:{fr:{},en:{}}}};vm.runInNewContext(read('assets/landing-i18n.js'),{window});
 assert.match(window.KairosI18n.DICT.fr['lp.radar_alt'],/sept dimensions/);assert.match(window.KairosI18n.DICT.en['lp.radar_alt'],/seven dimensions/);
 assert.equal(window.KairosI18n.DICT.fr['lp.axis_gurus'],undefined);
 const landing=read('index.html').match(/<svg class="radar-illustration"[\s\S]*?<\/svg>/)[0];
 assert.equal((landing.match(/data-i18n="lp.axis_/g)||[]).length,7);
 for(const name of ['dashboard.html','clarity-preview.html']){const html=read(name);assert.match(html,/Le profil en sept dimensions/);assert.match(html,/Comprendre les sept axes/);assert.doesNotMatch(html,/huit dimensions|huit axes/);}
});
test('seven-axis accessible descriptions and visible labels translate to English',()=>{
 const texts=['Le profil en sept dimensions','Comprendre les sept axes','Sept dimensions sur une échelle commune de zéro à cent. Santé financière : 66 sur 100. La pondération du score global ne modifie pas la forme du radar.'].map(nodeValue=>({nodeValue,parentElement:{closest(){return null;}}}));
 const document={body:{},createTreeWalker(){let i=0;return{nextNode(){return texts[i++]||null;}};},querySelectorAll(){return[];}};
 const window={KairosUI:{lang:'en'}};vm.runInNewContext(read('assets/clarity/live-i18n.js'),{window,document,NodeFilter:{SHOW_TEXT:4},MutationObserver:class{observe(){}},requestAnimationFrame:fn=>fn()});
 assert.equal(texts[0].nodeValue,'A seven-dimensional profile');
 assert.equal(texts[1].nodeValue,'Understand the seven axes');
 assert.match(texts[2].nodeValue,/^Seven dimensions.*Financial health: 66 out of 100/);
});
