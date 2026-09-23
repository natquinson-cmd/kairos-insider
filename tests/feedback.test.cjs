const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('assets/clarity/feedback.js','utf8');
async function mount({account=null,prior=false,fail=false}={}){
 let now=0,dialog=null,stored=prior?'1':null,requests=[];const events={},created=[];
 function node(tag){const children=new Map(),listeners={};return {tag,innerHTML:'',textContent:'',hidden:false,disabled:false,open:false,children,listeners,setAttribute(){},append(){},focus(){},remove(){dialog=null;},addEventListener(k,f){listeners[k]=f;},querySelector(k){if(!children.has(k))children.set(k,node(k));return children.get(k);},showModal(){this.open=true;dialog=this;},close(){this.open=false;listeners.close?.();},reportValidity(){return true;},elements:{message:{value:'Useful feedback'},email:{value:''}}};}
 const body=node('body'),doc={body,visibilityState:'visible',activeElement:node('focus'),createElement(tag){const n=node(tag);created.push(n);return n;},querySelector(s){return s==='dialog[open]'?dialog:body;},addEventListener(k,f){events[k]=f;}};
 await vm.runInNewContext(source,{window:{KairosUI:{t:(fr,en)=>en,getAccount:async()=>account}},document:doc,Date:{now:()=>now},sessionStorage:{getItem:()=>stored,setItem:(k,v)=>stored=v},location:{pathname:'/dashboard.html'},fetch:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return {ok:!fail,status:fail?503:200,json:async()=>({ok:true})};}});
 await Promise.resolve();return {created,requests,events,advance:ms=>now=ms,get dialog(){return dialog;},open(){created.find(n=>n.tag==='button').onclick();}};
}
test('automatic feedback waits 30 seconds, requires anonymous identity, opens once and never sends on display',async()=>{
 const f=await mount();f.events.mouseleave({clientY:0});assert.equal(f.dialog,null);f.advance(30001);f.events.mouseleave({clientY:1});assert.equal(f.dialog,null);f.events.mouseleave({clientY:0});assert.ok(f.dialog);assert.equal(f.requests.length,0);f.dialog.close();f.events.mouseleave({clientY:0});assert.equal(f.dialog,null);
 for(const options of [{account:{email:'user@example.invalid'}},{prior:true}]){const g=await mount(options);g.advance(40000);g.events.mouseleave({clientY:0});assert.equal(g.dialog,null);g.open();assert.ok(g.dialog);}
});
test('feedback sends only on explicit submit, blocks duplicates and confirms success',async()=>{
 const f=await mount();f.open();const form=f.dialog.querySelector('form');const pending=form.onsubmit({preventDefault(){}});await form.onsubmit({preventDefault(){}});await pending;assert.equal(f.requests.length,1);assert.deepEqual(f.requests[0].body,{text:'Useful feedback',email:'',page:'/dashboard.html'});assert.equal(form.querySelector('[type=submit]').hidden,true);assert.match(f.dialog.querySelector('[role=status]').textContent,/received/);
});
test('failed delivery keeps the message and enables retry',async()=>{
 const f=await mount({fail:true});f.open();const form=f.dialog.querySelector('form');await form.onsubmit({preventDefault(){}});assert.equal(form.elements.message.value,'Useful feedback');assert.equal(form.querySelector('[type=submit]').disabled,false);assert.match(f.dialog.querySelector('[role=status]').textContent,/failed/);
});
