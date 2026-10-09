const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const file=path.join(__dirname,'../assets/clarity/security-notice.js');
const notice=fs.existsSync(file)?require(file):{};
const payload=()=>({ticker:'VRME',securityNotice:{type:'successor',symbol:'OPNW',name:'OpenWorld, Inc.',effectiveDate:'2026-10-01',sourceUrl:'https://www.sec.gov/Archives/example.htm'}});
const options=lang=>({lang,stockUrl:symbol=>'dashboard.html?lang='+lang+'&symbol='+symbol});

test('successor notice presents dated company and source links in both languages',()=>{
  assert.equal(typeof notice.markup,'function');
  const fr=notice.markup(payload(),options('fr'));
  assert.match(fr,/role="note"/);assert.match(fr,/Changement de symbole/);assert.match(fr,/1 octobre 2026/);
  assert.match(fr,/href="dashboard.html\?lang=fr&amp;symbol=OPNW"/);assert.match(fr,/OpenWorld, Inc\./);
  assert.match(fr,/href="https:\/\/www.sec.gov\/Archives\/example.htm"/);assert.match(fr,/rel="noopener noreferrer"/);
  const en=notice.markup(payload(),options('en'));assert.match(en,/Symbol change/);assert.match(en,/October 1, 2026/);assert.match(en,/former symbol may be incomplete/);
});
test('notice escapes provider text and rejects executable source URLs or invalid symbols',()=>{
  assert.equal(typeof notice.markup,'function');
  const data=payload();data.securityNotice.name='<img src=x onerror=alert(1)>';data.securityNotice.sourceUrl='javascript:alert(1)';
  const html=notice.markup(data,options('en'));assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img|javascript:|Source filing/);
  data.securityNotice.symbol='OPNW" onclick="x';assert.equal(notice.markup(data,options('en')),'');
  assert.equal(notice.markup({ticker:'VRME'},options('en')),'');
});
test('loading the helper mounts one notice before the company tabs without changing the stock',()=>{
  assert.equal(fs.existsSync(file),true);
  const original=payload(),insertions=[];let removal=0;
  const document={getElementById:()=>({remove(){removal++;}}),querySelector:selector=>selector==='#companyMain .company-tabs'?{insertAdjacentHTML(position,html){insertions.push({position,html});}}:null};
  const window={document,KairosUI:options('en'),KairosLive:{companies:[{raw:original}]}};
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{window,URL,URLSearchParams});
  assert.equal(insertions.length,1);assert.equal(insertions[0].position,'beforebegin');assert.equal(removal,1);
  assert.equal(window.KairosLive.companies[0].raw,original);assert.equal(original.ticker,'VRME');
  assert.doesNotMatch(insertions[0].html,/http-equiv|location\./);
});
