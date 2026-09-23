const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..');
test('account billing and admin links preserve parameters before API initialization',()=>{const source=fs.readFileSync(path.join(root,'assets/clarity/entry-routes.js'),'utf8');for(const [search,hash,target]of [['?lang=en&plan=pro&billing=yearly','','admin-workspace.html?lang=en&plan=pro&billing=yearly'],['?lang=fr','#admin','admin.html?lang=fr'],['?lang=fr&symbol=AAPL','','']]){let result='';vm.runInNewContext(source,{URLSearchParams,location:{search,hash,replace(v){result=v;}}});assert.equal(result,target);}});
test('production workspace loads no fixture or demonstration datasets',()=>{for(const name of ['dashboard.html','insiders.html']){const html=fs.readFileSync(path.join(root,name),'utf8');assert.doesNotMatch(html,/(?:demo-data|research-data|activist-data|insider-identities)\.js/);for(const [,file]of html.matchAll(/(?:src|href)="(assets\/clarity\/[^"?]+)(?:\?[^" ]*)?"/g))assert.ok(fs.existsSync(path.join(root,file)),file);}});

test('legacy destinations preserve working account and research screens',()=>{
  const source=fs.readFileSync(path.join(root,'assets/clarity/entry-routes.js'),'utf8');
  for(const [hash,target]of [
    ['#watchlist','watchlist.html?lang=en'],['#alerts','watchlist.html?lang=en#alerts'],
    ['#profile','account.html?lang=en'],
    ['#insiderProfile?name=LEE+JOHNNY&cik=123','admin-workspace.html?lang=en#insiderProfile?name=LEE+JOHNNY&cik=123'],
    ['#13f-explorer?t=MSFT','admin-workspace.html?lang=en#13f-explorer?t=MSFT'],
    ['#consensus13f','insiders.html?lang=en&screen=funds&view=consensus'],
    ['#clustering','insiders.html?lang=en&screen=insiders&view=convergences'],
    ['#stockAnalysis?t=MSFT',''],['#companyMain','']
  ]){let result='';vm.runInNewContext(source,{URLSearchParams,location:{search:'?lang=en',hash,replace(v){result=v;}}});assert.equal(result,target,hash);}
});

test('stock search works without a loaded company and tolerates market pages',async()=>{
  const source=fs.readFileSync(path.join(root,'assets/clarity/live-shell.js'),'utf8');
  const start=source.indexOf('function initializeStockSearch('),end=source.indexOf('\nconst format=',start);
  assert.ok(start>=0&&end>start,'search must initialize independently of stock rendering');
  const listeners={},attributes={},input={value:'MSFT',addEventListener(type,fn){listeners[type]=fn;},setAttribute(k,v){attributes[k]=v;},removeAttribute(k){delete attributes[k];},focus(){},select(){}};
  const popup={hidden:true},list={querySelectorAll(){return [];}},wrap={contains(){return true;},addEventListener(){}};
  const elements={companySearch:input,searchPopup:popup,searchResults:list,searchWrap:wrap};let chosen='';
  const context={document:{getElementById(id){return elements[id]||null;},addEventListener(){}},params:new URLSearchParams(),setTimeout(fn){return fn();},clearTimeout(){},search:async()=>[{ticker:'MSFT',symbol:'MSFT'}],renderSearch(){popup.hidden=false;},openStock(symbol){chosen=symbol;}};
  vm.runInNewContext(source.slice(start,end)+'\ninitializeStockSearch();',context);
  await listeners.input();await new Promise(resolve=>setImmediate(resolve));
  listeners.keydown({key:'Enter',preventDefault(){}});assert.equal(chosen,'MSFT');
  context.document.getElementById=()=>null;
  assert.doesNotThrow(()=>vm.runInNewContext('initializeStockSearch();',context));
});

test('account bridge returns authenticated readers to the new interface without interrupting billing',()=>{
  const source=fs.readFileSync(path.join(root,'assets/clarity/admin-bridge.js'),'utf8');
  for(const [hash,checkout,target]of [
    ['',false,'dashboard.html?lang=en'],['#home',false,'dashboard.html?lang=en'],
    ['#stockAnalysis?t=MSFT',false,'dashboard.html?lang=en&symbol=MSFT'],
    ['#profile',false,'account.html?lang=en'],['#profile',true,''],['#admin',false,''],['#watchlist',false,'watchlist.html?lang=en'],['#alerts',false,'watchlist.html?lang=en#alerts'],['#watchlist',true,''],['',true,'']
  ]){
    let result='';const events={},store=new Map(checkout?[['kairos_auto_checkout','1']]:[]);
    vm.runInNewContext(source,{URLSearchParams,window:{isAnonymous:false,addEventListener(type,fn){events[type]=fn;}},document:{addEventListener(){},documentElement:{classList:{contains(){return false;}}}},location:{search:'?lang=en',hash,replace(v){result=v;}},localStorage:{getItem(k){return store.get(k)||null;}},sessionStorage:{getItem(){return null;}}});
    store.clear();events['kairos:auth-ready']?.();assert.equal(result,target,hash+' checkout='+checkout);
  }
});
