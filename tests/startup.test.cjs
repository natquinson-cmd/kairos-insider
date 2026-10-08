const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const source=()=>fs.readFileSync(path.join(root,'assets/clarity/startup.js'),'utf8');
function run({pathname='/admin-workspace.html',search='?lang=en',hash='#admin',stored={}}={}){
 const attrs=new Map(pathname.includes('admin-workspace')?[['data-kairos-startup','legacy']]:[]),events={},elements={},classes=new Set();let target='';
 for(const id of ['kairosBoot','kairosBootTitle','kairosBootMessage','kairosBootRetry','kairosBootHome'])elements[id]={textContent:'',hidden:false,setAttribute(k,v){this[k]=v;}};
 const document={readyState:'loading',documentElement:{lang:'fr',getAttribute:k=>attrs.get(k)||null,setAttribute:(k,v)=>attrs.set(k,v),removeAttribute:k=>attrs.delete(k),classList:{add:k=>classes.add(k),contains:k=>classes.has(k)}},body:null,getElementById:id=>elements[id]||null,addEventListener:(k,v)=>events[k]=v};
 const window={document,location:{pathname,search,hash,href:'https://kairosinsider.fr'+pathname+search+hash,replace:v=>target=v},localStorage:{getItem:k=>stored[k]||null},sessionStorage:{getItem:k=>stored[k]||null},addEventListener:(k,v)=>events[k]=v};window.window=window;
 vm.runInNewContext(source(),{window,document,location:window.location,URL,URLSearchParams});
 return {window,document,attrs,events,elements,classes,target:()=>target};
}
test('legacy destinations redirect before DOM or authentication initialization',()=>{
 for(const [hash,target]of [['#profile','account.html?lang=en'],['#alerts','watchlist.html?lang=en#alerts'],['#watchlist','watchlist.html?lang=en'],['#stockAnalysis?t=MSFT','dashboard.html?lang=en&symbol=MSFT'],['#home','dashboard.html?lang=en'],['#consensus13f','insiders.html?lang=en&screen=funds&view=consensus']]){
  const app=run({hash});assert.equal(app.target(),target);assert.equal(app.attrs.get('data-kairos-startup'),'redirect');app.window.KairosStartup.ready();assert.equal(app.attrs.get('data-kairos-startup'),'redirect');
 }
});
test('billing and explicit sign-in flows remain on their existing handlers',()=>{
 for(const input of [{search:'?lang=en&plan=pro&billing=yearly',hash:'#profile'},{search:'?lang=en&action=login',hash:''},{stored:{kairos_auto_checkout:'pro'},hash:'#home'},{stored:{kairos_reopen_paywall:'1'},hash:'#watchlist'}])assert.equal(run(input).target(),'');
 assert.equal(run({hash:'#insiderProfile?name=LEE&cik=123'}).target(),'');
});
test('administrator placeholder is released only by the completed presentation',()=>{
 const app=run();assert.equal(app.attrs.get('data-kairos-startup'),'legacy');assert.ok(app.classes.has('clarity-admin'));app.window.KairosStartup.ready();assert.equal(app.attrs.has('data-kairos-startup'),false);
});
test('critical module failure gives localized recovery without exposing legacy content',()=>{
 const app=run();app.events.error({target:{tagName:'SCRIPT',src:'https://kairosinsider.fr/assets/clarity/admin-shell.js'}});app.events.DOMContentLoaded();
 assert.equal(app.attrs.get('data-kairos-startup'),'error');assert.match(app.elements.kairosBootTitle.textContent,/unable|could not|unavailable/i);assert.match(app.elements.kairosBootRetry.textContent,/retry|reload/i);
 assert.equal(app.elements.kairosBootHome.href,'index.html?lang=en');
});
test('image failures and errors after initialization do not hide a working page',()=>{
 const app=run({pathname:'/insiders.html'});app.events.error({target:{tagName:'IMG',src:'https://assets.parqet.com/missing.png'}});assert.notEqual(app.attrs.get('data-kairos-startup'),'error');app.window.KairosStartup.ready();app.events.error({filename:'https://kairosinsider.fr/assets/clarity/live-shell.js'});assert.notEqual(app.attrs.get('data-kairos-startup'),'error');
});
test('page markup has compact search and a recovery path before asynchronous shell',()=>{
 for(const name of ['dashboard.html','insiders.html','account.html','watchlist.html']){
  const html=fs.readFileSync(path.join(root,name),'utf8');assert.ok(html.indexOf('startup.js')<html.indexOf('live-shell.js'),name);assert.match(html,/class="topbar has-compact-search"/,name);assert.match(html,/class="search-wrap persistent-search"/,name);assert.match(html,/<noscript>/,name);assert.match(html,/id="kairosBootRetry"/,name);
 }
 const admin=fs.readFileSync(path.join(root,'admin-workspace.html'),'utf8');assert.ok(admin.indexOf('startup.js')<admin.indexOf('assets/i18n.js'));assert.match(admin,/<html[^>]*data-kairos-startup="legacy"/);assert.match(admin,/\[data-kairos-startup\] body> :not/);
});
test('stock content remains hidden until the renderer is loaded',()=>{
 const js=fs.readFileSync(path.join(root,'assets/clarity/live-shell.js'),'utf8');const render=js.indexOf("await loadScript('assets/clarity/app.js");assert.ok(render>=0);assert.ok(js.indexOf("document.getElementById('companyMain').hidden=false",render)>render);
});
