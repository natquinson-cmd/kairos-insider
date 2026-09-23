const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..');
const account=require('../assets/clarity/live-account.js');
test('owner access and paid billing are distinct facts',()=>{
  const owner=account.subscriptionView({isAdmin:true,entitled:true,hasSubscription:false,effectivePlan:'elite'},'fr');
  assert.equal(owner.access,'Accès administrateur');assert.equal(owner.subscription,'Aucun abonnement payant');assert.equal(owner.canManage,false);assert.equal(owner.canUpgrade,false);
  const paid=account.subscriptionView({isAdmin:false,entitled:true,hasSubscription:true,plan:'pro',billing:'yearly',status:'active'},'en');
  assert.equal(paid.access,'Pro access');assert.equal(paid.subscription,'Kairos Pro · Annual');assert.equal(paid.canManage,true);
  const grant=account.subscriptionView({entitled:true,hasSubscription:false},'fr');
  assert.equal(grant.access,'Accès Pro offert');assert.equal(grant.subscription,'Aucun abonnement payant');
});
test('unknown status is never presented as a free plan',()=>{
  assert.throws(()=>account.subscriptionView(null,'fr'));
  assert.throws(()=>account.subscriptionView({},'fr'));
  assert.equal(account.subscriptionView({entitled:false,hasSubscription:false},'en').access,'Free access');
});
test('account shell uses real account data and no stock rendering fixtures',()=>{
  const html=fs.readFileSync(path.join(root,'account.html'),'utf8');assert.match(html,/data-screen="account"/);assert.doesNotMatch(html,/id="companyMain"|demo-data|research-data/);
  for(const [,file]of html.matchAll(/(?:src|href)="(assets\/[^"?]+)(?:\?[^" ]*)?"/g))assert.ok(fs.existsSync(path.join(root,file)),file);
});
test('rendering account information never creates a portal or updates a profile',async()=>{
  const source=fs.readFileSync(path.join(root,'assets/clarity/live-account.js'),'utf8'),calls=[],nodes=new Map();
  const node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',hidden:false,addEventListener(){},querySelector(){return {addEventListener(){}};}});return nodes.get(id);};
  const U={lang:'en',t:(fr,en)=>en,esc:String,getAccount:async()=>({displayName:'Reader',email:'reader@example.com',emailVerified:true}),api:async(path,options)=>{calls.push([path,options]);return {entitled:true,isAdmin:true,hasSubscription:false};},translate(){}};
  vm.runInNewContext(source,{window:{KairosUI:U},document:{getElementById:node,title:''},URL,Date,console});
  await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,[['/stripe/status',undefined]]);
  assert.match(node('accountSubscription').innerHTML,/No paid subscription/);
});
