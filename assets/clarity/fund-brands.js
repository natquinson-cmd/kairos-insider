(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.KairosFundBrands=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  // Official source URLs and file hashes are recorded in ../fund-logos/sources.json.
  // Name-only matching is intentional: historical upstream CIK mappings contain collisions.
  const brands=[
    {id:'bridgewater',file:'bridgewater.png',names:['Bridgewater Associates','Bridgewater Associates LP']},
    {id:'pershing-square',file:'pershing-square.png',names:['Pershing Square','Pershing Square Capital','Pershing Square Capital Management','Pershing Square Capital Management LP']},
    {id:'renaissance',file:'renaissance.png',names:['Renaissance Technologies','Renaissance Technologies LLC']},
    {id:'baupost',file:'baupost.png',tone:'dark',wide:true,names:['Baupost Group','Baupost Group LLC','The Baupost Group','The Baupost Group LLC']},
    {id:'viking',file:'viking.png',names:['Viking Global Investors','Viking Global Investors LP']},
    {id:'situational-awareness',file:'situational-awareness.svg',names:['Situational Awareness','Situational Awareness LP']},
    {id:'point72',file:'point72.png',names:['Point72','Point72 Asset Management','Point72 Asset Management LP']},
    {id:'blackrock',file:'blackrock.svg',wide:true,names:['BlackRock','BlackRock Inc']},
    {id:'vanguard',file:'vanguard.svg',tone:'dark',names:['Vanguard','Vanguard Group','Vanguard Group Inc','The Vanguard Group','The Vanguard Group Inc','Vanguard Group Inc/']},
    {id:'two-sigma',file:'two-sigma.png',names:['Two Sigma','Two Sigma Advisers','Two Sigma Advisers LP','Two Sigma Investments','Two Sigma Investments LP']},
    {id:'millennium',file:'millennium.png',names:['Millennium Management','Millennium Management LLC']},
    {id:'de-shaw',file:'de-shaw.svg',tone:'dark',wide:true,names:['D.E. Shaw','D.E. Shaw & Co','D.E. Shaw & Co Inc','D.E. Shaw & Co LP']},
    {id:'third-point',file:'third-point.svg',wide:true,names:['Third Point','Third Point LLC','Third Point LP']},
    {id:'elliott',file:'elliott.jpg',names:['Elliott Management','Elliott Management Corp','Elliott Investment Management','Elliott Investment Management LP']},
    {id:'scion',file:'scion.webp',wide:true,names:['Scion Asset Management','Scion Asset Management LLC']},
    {id:'lone-pine',file:'lone-pine.png',names:['Lone Pine Capital','Lone Pine Capital LLC']},
    {id:'coatue',file:'coatue.jpg',names:['Coatue','Coatue Management','Coatue Management LLC']},
    {id:'greenlight',file:'greenlight.png',tone:'dark',wide:true,names:['Greenlight Capital','Greenlight Capital Inc']}
  ];
  const normalize=value=>String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
  const byName=new Map();
  brands.forEach(brand=>brand.names.forEach(name=>byName.set(normalize(name),brand)));
  function nameOf(fund){return typeof fund==='string'?fund:String(fund?.fundName||fund?.name||fund?.label||'');}
  function resolve(fund){return byName.get(normalize(nameOf(fund)))||null;}
  function displayName(fund){
    const label=String(fund?.label||nameOf(fund));
    // Hide listing symbols only; retain meaningful qualifiers such as (Aschenbrenner).
    return label.replace(/\s+\(([^()]*)\)\s*$/, (suffix,content)=>{
      const symbols=content.split(/,\s*/);
      const isTickerList=symbols.length>1&&symbols.every(s=>/^[A-Za-z]{1,5}(?:[.-][A-Za-z0-9]{1,3})?$/.test(s));
      const isTicker=symbols.length===1&&/^[A-Z]{1,5}(?:[.-][A-Z0-9]{1,3})?$/.test(content)&&!['US','USA','UK','EU'].includes(content);
      return isTickerList||isTicker?'':suffix;
    }).trim();
  }
  function initials(fund){return nameOf(fund).replace(/[^\p{L}\p{N}\s]/gu,' ').trim().split(/\s+/).filter(Boolean).slice(0,2).map(part=>Array.from(part)[0]).join('').toLocaleUpperCase()||'?';}
  const esc=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  function markup(fund,{large=false}={}){
    const brand=resolve(fund),classes=['fund-brand',large?'fund-brand--large':'',brand?.tone==='dark'?'fund-brand--dark':'',brand?.wide?'fund-brand--wide':''].filter(Boolean).join(' ');
    // Decorative image: the adjacent, visible fund name is the accessible label.
    return `<span class="${classes}" aria-hidden="true"><span class="fund-brand__initials">${esc(initials(fund))}</span>${brand?`<img data-fund-brand src="/assets/fund-logos/${brand.file}" alt="" width="${large?56:32}" height="${large?56:32}" decoding="async">`:''}</span>`;
  }
  function hydrate(container){
    container?.querySelectorAll('[data-fund-brand]').forEach(img=>{
      const loaded=()=>img.parentElement?.classList.add('fund-brand--loaded');
      const failed=()=>img.remove();
      img.addEventListener('load',loaded,{once:true});
      img.addEventListener('error',failed,{once:true});
      if(img.complete){if(img.naturalWidth>0)loaded();else failed();}
    });
  }
  return {brands,normalize,resolve,displayName,initials,markup,hydrate};
});
