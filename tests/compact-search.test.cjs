const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('persistent search preserves its field and filter while dismissing suggestions',()=>{
 const handlers={},keys={},popup={hidden:false},input={value:'Apple',setAttribute(){},focus(){this.focused=true;},select(){this.selected=true;},addEventListener(k,fn){keys[k]=fn;}},wrap={hidden:true,dataset:{},classList:{add(){}},querySelector(){return popup;},contains(x){return x===input;}},header={classList:{add(){}}};
 const context={window:{},document:{addEventListener(k,fn){handlers[k]=fn;}}};vm.runInNewContext(fs.readFileSync('assets/clarity/compact-search.js','utf8'),context);context.window.KairosCompactSearch.mount({header,wrap,input});
 assert.equal(wrap.hidden,false);keys.keydown({key:'Escape'});assert.equal(popup.hidden,true);assert.equal(wrap.hidden,false);assert.equal(input.value,'Apple');popup.hidden=false;handlers.pointerdown({target:{}});assert.equal(popup.hidden,true);assert.equal(wrap.hidden,false);
 let prevented=false;handlers.keydown({key:'k',ctrlKey:true,preventDefault(){prevented=true;},stopImmediatePropagation(){}});assert.equal(prevented,true);assert.ok(input.focused&&input.selected);assert.equal(input.value,'Apple');
});
