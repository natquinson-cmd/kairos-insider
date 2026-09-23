const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture({filter=false,value=''}={}){
 const handlers={},nodes=[];let doc;
 class Element{
  constructor(){this.children=[];this.dataset={};this.attrs={};this.handlers={};this.hidden=false;this.value='';this.classList={add(){}};nodes.push(this);}
  append(...children){for(const child of children){child.parent=this;this.children.push(child);}}
  before(node){this.sibling=node;}
  setAttribute(k,v){this.attrs[k]=v;}
  addEventListener(k,fn){(this.handlers[k]??=[]).push(fn);}
  dispatchEvent(event){for(const fn of this.handlers[event.type]||[])fn(event);return true;}
  querySelector(){return null;}
  contains(target){return this===target||this.children.some(child=>child.contains(target));}
  focus(){doc.activeElement=this;}select(){this.selected=true;}
 }
 doc={createElement(){return new Element();},addEventListener(k,fn){handlers[k]=fn;},activeElement:null};
 const header=new Element(),wrap=new Element(),input=new Element();wrap.id='searchWrap';input.value=value;wrap.append(input);
 const context={window:{},document:doc,setTimeout:fn=>fn(),Event:class{constructor(type){this.type=type;}}};
 vm.runInNewContext(fs.readFileSync('assets/clarity/compact-search.js','utf8'),context);
 context.window.KairosCompactSearch.mount({header,wrap,input,filter});
 const slot=wrap.sibling,[trigger,clear]=slot.children,close=wrap.children.at(-1);
 const key=(key,ctrlKey=false)=>{const event={key,ctrlKey,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;}};handlers.keydown(event);return event;};
 return {doc,header,wrap,input,trigger,clear,close,key,handlers};
}
test('search starts collapsed, click and Ctrl K open it with focus, Escape restores the trigger',()=>{
 const f=fixture();assert.equal(f.wrap.hidden,true);f.trigger.onclick();assert.equal(f.wrap.hidden,false);assert.equal(f.doc.activeElement,f.input);assert.equal(f.trigger.attrs['aria-expanded'],'true');
 f.key('Escape');assert.equal(f.wrap.hidden,true);assert.equal(f.doc.activeElement,f.trigger);const event=f.key('k',true);assert.ok(event.prevented&&event.stopped);assert.equal(f.wrap.hidden,false);
});
test('closing a screener search preserves a visible active filter and explicit clear notifies filtering',()=>{
 const f=fixture({filter:true,value:'Apple'});assert.equal(f.wrap.hidden,true);assert.equal(f.clear.hidden,false);assert.equal(f.trigger.children[0].textContent,'Filtre : Apple');
 f.trigger.onclick();f.close.onclick();assert.equal(f.input.value,'Apple');let notified=0;f.input.addEventListener('input',()=>notified++);f.clear.onclick();assert.equal(f.input.value,'');assert.equal(notified,1);assert.equal(f.clear.hidden,true);
});
test('outside click closes the overlay without stealing focus or clearing the query',()=>{
 const f=fixture();f.trigger.onclick();f.input.value='AAPL';const outside={};f.doc.activeElement=outside;f.handlers.pointerdown({target:outside});assert.equal(f.wrap.hidden,true);assert.equal(f.doc.activeElement,outside);assert.equal(f.input.value,'AAPL');
});
test('an explicit incoming stock search is opened while a screener filter stays compact',()=>{
 const stock=fixture({value:'ASML'}),market=fixture({filter:true,value:'ASML'});assert.equal(stock.wrap.hidden,false);assert.equal(market.wrap.hidden,true);
});
