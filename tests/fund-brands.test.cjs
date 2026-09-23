const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const B=require('../assets/clarity/fund-brands.js');

test('official brand names match case, punctuation and legal-name aliases',()=>{
  assert.equal(B.resolve({fundName:'BRIDGEWATER ASSOCIATES, L.P.'}).id,'bridgewater');
  assert.equal(B.resolve({fundName:'D. E. SHAW & CO., INC.'}).id,'de-shaw');
  assert.equal(B.resolve({fundName:'Situational Awareness LP',label:'Leopold Aschenbrenner'}).id,'situational-awareness');
  assert.equal(B.resolve({fundName:'The Baupost Group, L.L.C.'}).id,'baupost');
  for(const brand of B.brands)for(const alias of brand.names)assert.equal(B.resolve({fundName:alias}).id,brand.id);
});
test('CIKs and personal labels cannot override a conflicting or unknown legal name',()=>{
  assert.equal(B.resolve({fundName:'Caxton Associates',cik:'0001067983'}),null);
  assert.equal(B.resolve({fundName:'Unrelated Partners',label:'Bridgewater Associates',cik:'0001350694'}),null);
  assert.equal(B.resolve({cik:'0001350694',label:'Ray Dalio'}),null);
  assert.equal(B.resolve({fundName:'Bridgewater Credit Opportunities'}),null);
  assert.equal(B.resolve({label:'Viking Global Investors'}).id,'viking');
});
test('fallback initials remain usable for missing and untrusted names',()=>{
  assert.equal(B.initials({fundName:'Unknown Capital Partners'}),'UC');
  assert.equal(B.initials({}),'?');
  assert.equal(B.markup({fundName:'<script>evil</script>'}).includes('<script>'),false);
  assert.equal(B.markup({fundName:'Unknown Capital'}).includes('<img'),false);
  assert.match(B.markup({fundName:'Point72 Asset Management'}),/\/assets\/fund-logos\/point72\.png/);
  assert.match(B.markup({fundName:'Point72 Asset Management'},{large:true}),/fund-brand--large/);
});
test('every bundled brand has a verified official-source manifest and intact local image',()=>{
  const manifest=require('../assets/fund-logos/sources.json');
  assert.ok(B.brands.length>=12);
  for(const brand of B.brands){
    const asset=manifest.assets.find(a=>a.id===brand.id);
    assert.ok(asset,brand.id);
    assert.match(asset.website,/^https:\/\//);
    assert.match(asset.sourceUrl,/^https:\/\//);
    assert.equal(asset.file,brand.file);
    const bytes=fs.readFileSync(path.join(__dirname,'../assets/fund-logos',brand.file));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),asset.sha256);
    if(brand.file.endsWith('.svg'))assert.doesNotMatch(bytes.toString(),/<script|<foreignObject|\bon\w+\s*=/i);
  }
});
test('image failure removes the broken image and leaves initials; cached images become visible',()=>{
  function mock(complete,naturalWidth){const listeners={};const classes=new Set();return {complete,naturalWidth,removed:false,parentElement:{classList:{add:x=>classes.add(x)}},addEventListener:(k,fn)=>listeners[k]=fn,remove(){this.removed=true;},listeners,classes};}
  const pending=mock(false,0),cached=mock(true,180),broken=mock(true,0);
  B.hydrate({querySelectorAll:()=>[pending,cached,broken]});
  assert.ok(cached.classes.has('fund-brand--loaded'));
  assert.equal(broken.removed,true);
  pending.listeners.error();
  assert.equal(pending.removed,true);
  assert.equal(pending.classes.has('fund-brand--loaded'),false);
});
