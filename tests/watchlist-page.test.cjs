const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const source=fs.readFileSync(path.join(__dirname,'../assets/clarity/live-watchlist.js'),'utf8');
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// A small DOM surface for page mounting and explicit button handlers, with no browser or network.
function documentFixture(){
  const nodes=new Map();
  function makeNode(id){
    let markup='',children=new Map(),appended=[];
    const listeners=new Map(),classes=new Set();
    return {id,textContent:'',hidden:id==='watchlistContent',disabled:false,value:'',dataset:{},classes,
      get innerHTML(){return markup;},set innerHTML(value){markup=String(value);children=new Map();appended=[];},
      append(node){appended.push(node);},get appended(){return appended;},
      classList:{toggle(name,force){const enabled=force??!classes.has(name);if(enabled)classes.add(name);else classes.delete(name);}},
      addEventListener(name,handler){listeners.set(name,handler);},
      async fire(name,event={}){return listeners.get(name)?.(event);},
      querySelector(selector){return this.querySelectorAll(selector)[0]||null;},
      querySelectorAll(selector){
        const attribute=selector.match(/^\[([^=\]]+)\]$/)?.[1];
        const matches=[...markup.matchAll(/<[a-z][a-z0-9]*\b[^>]*>/g)].filter(match=>attribute?new RegExp('(?:\\s)'+attribute+'(?:[\\s=>])').test(match[0]):selector==='button'?match[0].startsWith('<button'):selector.startsWith('.')?new RegExp('class="[^"]*\\b'+selector.slice(1)+'\\b').test(match[0]):false);
        return matches.map((match,index)=>{
          const key=selector+index;if(children.has(key))return children.get(key);
          const node=makeNode(id+':'+key),tag=match[0];node.disabled=/\sdisabled(?:[\s>])/.test(tag);
          for(const field of tag.matchAll(/data-([a-z-]+)="([^"]*)"/g))node.dataset[field[1].replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=field[2];
          children.set(key,node);return node;
        });
      },
    };
  }
  const get=id=>{if(!nodes.has(id))nodes.set(id,makeNode(id));return nodes.get(id);};
  return {document:{documentElement:{},getElementById:get,createElement:tag=>makeNode(tag)},get};
}

async function mount({anonymous=false,entitled=true,statusFailure=false,saveFailure=false,linked=false,lang='en'}={}){
  const {document,get}=documentFixture(),apiCalls=[],mutations=[],errors=[];
  let loads=0,clientCreations=0;
  const saved={tickers:['AAPL','MC.PA','NESN.SW'],emailAlerts:true,emailInsiderAlerts:false,optIn:false,types:{insider:false},lang,exists:true};
  const copy=()=>structuredClone(saved);
  const client={load:async()=>{loads++;return copy();},add:async symbol=>{mutations.push({operation:'add',symbol});throw Error('Unexpected add');},remove:async symbol=>{mutations.push({operation:'remove',symbol});throw Error('Unexpected removal');},preferences:async(patch,options)=>{mutations.push({operation:'preferences',patch,options});if(saveFailure)throw Error('Save failed');Object.assign(saved,patch);return copy();}};
  const U={lang,t:(fr,en)=>lang==='en'?en:fr,esc:escape,getAccount:async()=>anonymous?null:{email:'test@example.invalid'},watchlist:async()=>{clientCreations++;return client;},login(){},openStock(){},search:async()=>[],translate(){},showError:(host,error)=>{errors.push(error);host.textContent=error.message;},api:async(url,options)=>{
    apiCalls.push({url,options});
    if(url==='/stripe/status'){if(statusFailure)throw Error('Unavailable');return {entitled};}
    if(url==='/api/telegram/status')return {linked,alertPrefs:{insiderTransactions:false,quietHoursStart:22,quietHoursEnd:7}};
    throw Error('Unexpected API call: '+url);
  }};
  vm.runInNewContext(source,{window:{KairosUI:U},document,URL,setTimeout,clearTimeout});
  for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(errors,[]);
  return {get,apiCalls,mutations,saved,get loads(){return loads;},get clientCreations(){return clientCreations;}};
}

function assertReadOnly(result){
  assert.deepEqual(result.mutations,[]);
  assert.ok(result.apiCalls.every(call=>call.options===undefined||!call.options.method||call.options.method==='GET'));
}

test('anonymous mount offers sign in without reading private data or saving preferences',async()=>{
  const result=await mount({anonymous:true});
  assert.match(result.get('watchlistAccess').innerHTML,/Sign in/);
  assert.equal(result.get('watchlistContent').hidden,true);
  assert.equal(result.clientCreations,0);
  assert.equal(result.loads,0);
  assert.deepEqual(result.apiCalls,[]);
  assertReadOnly(result);
});

test('Pro mount loads the existing list and leaves both alert channels inactive without POST',async()=>{
  const result=await mount();
  assert.equal(result.loads,1);
  assert.equal(result.get('watchlistContent').hidden,false);
  for(const ticker of result.saved.tickers)assert.ok(result.get('watchlistRows').innerHTML.includes(ticker));
  assert.equal(result.get('watchlistSearch').disabled,false);
  assert.match(result.get('watchlistEmail').innerHTML,/Inactive/);
  assert.match(result.get('watchlistEmail').innerHTML,/previous daily summary/);
  assert.match(result.get('watchlistTelegram').innerHTML,/Not connected/);
  assertReadOnly(result);
});

test('free account can read its saved list while add remove and alert controls stay disabled',async()=>{
  const result=await mount({entitled:false});
  assert.match(result.get('watchlistAccess').innerHTML,/require Pro access/);
  assert.match(result.get('watchlistRows').innerHTML,/MC\.PA/);
  assert.equal(result.get('watchlistSearch').disabled,true);
  assert.ok(result.get('watchlistRows').querySelectorAll('[data-remove]').every(button=>button.disabled));
  assert.equal(result.get('watchlistEmail').querySelector('[data-email-enable]').disabled,true);
  assertReadOnly(result);
});

test('failed access lookup remains unknown and never substitutes a free or active status',async()=>{
  const result=await mount({statusFailure:true});
  assert.match(result.get('watchlistAccess').innerHTML,/could not be verified/);
  assert.doesNotMatch(result.get('watchlistAccess').innerHTML,/Explore Pro/);
  assert.match(result.get('watchlistEmail').innerHTML,/Access unverified/);
  assert.doesNotMatch(result.get('watchlistEmail').innerHTML,/is-active/);
  assert.equal(result.get('watchlistSearch').disabled,true);
  assertReadOnly(result);
});

test('failed explicit email save preserves the inactive state and displays an error',async()=>{
  const result=await mount({saveFailure:true});
  assertReadOnly(result);
  await result.get('watchlistEmail').querySelector('[data-email-enable]').fire('click');
  assert.equal(result.mutations.length,1);
  assert.equal(result.mutations[0].patch.emailInsiderAlerts,true);
  assert.equal(result.mutations[0].patch.types.insider,true);
  assert.equal(result.mutations[0].options.sendConfirmation,true);
  assert.equal(result.saved.emailInsiderAlerts,false);
  assert.equal(result.get('watchlistMessage').textContent,'Save failed');
  assert.equal(result.get('watchlistMessage').classes.has('is-error'),true);
  assert.match(result.get('watchlistEmail').innerHTML,/Inactive/);
  assert.doesNotMatch(result.get('watchlistEmail').innerHTML,/is-active/);
  assert.equal(result.get('watchlistEmail').querySelector('[data-email-enable]').disabled,false);
});

test('linked Telegram displays existing quiet hours without enabling alerts or changing hours on mount',async()=>{
  const result=await mount({linked:true});
  assert.match(result.get('watchlistTelegram').innerHTML,/Connected · alerts inactive/);
  assert.match(result.get('watchlistTelegram').innerHTML,/22:00–07:00/);
  const details=result.get('watchlistTelegram').querySelector('.watchlist-channel').appended;
  assert.equal(details.length,1);
  assert.match(details[0].innerHTML,/Receive night-time alerts too/);
  assertReadOnly(result);
});
