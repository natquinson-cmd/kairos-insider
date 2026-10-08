/* Presentation only: source evidence and filing dates remain separate concepts. */
(function(root,factory){
 const api=factory(typeof module==='object'&&module.exports?require('../insider-transaction.js'):root.KairosInsiderTransaction);
 if(typeof module==='object'&&module.exports)module.exports=api;else root.KairosSignalContext=api;
})(typeof window==='object'?window:globalThis,function(evidence){
 'use strict';
 const DAY=86400000;
 const text=(lang,fr,en)=>lang==='en'?en:fr;
 const exclusions={
  grant:['Attribution gratuite','Share award'],gift:['Donation','Gift'],exercise:['Exercice d’options','Option exercise'],
  conversion:['Conversion','Conversion'],'tax-withholding':['Retenue fiscale','Tax withholding'],
  'employee-plan':['Plan salarié','Employee plan'],'mandatory-acquisition':['Acquisition obligatoire','Mandatory acquisition'],
  'derivative-security':['Instrument dérivé','Derivative security'],'not-purchase':['Opération hors signal','Transaction outside signal'],
 };
 function day(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}(?:$|T\d{2}:\d{2})/.test(value))return null;
  const date=value.slice(0,10),stamp=Date.parse(date+'T00:00:00Z');
  return Number.isFinite(stamp)&&new Date(stamp).toISOString().slice(0,10)===date&&Number.isFinite(Date.parse(value))?date:null;
 }
 function formatDate(value,{lang='fr'}={}){
  const date=day(value);return date?new Date(date+'T12:00:00Z').toLocaleDateString(lang==='en'?'en-US':'fr-FR',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}):text(lang,'Date indisponible','Date unavailable');
 }
 function dateContext(value,{lang,now,kind}){
  const date=day(value),isPublication=kind==='publication',label=isPublication?text(lang,'Publié','Published'):text(lang,'Opération','Executed');
  const diff=date?Math.round((Date.parse(now+'T00:00:00Z')-Date.parse(date+'T00:00:00Z'))/DAY):null;
  const future=diff!==null&&diff<0,ageDays=future?null:diff,freshness=!date?'unknown':future?'future':ageDays<7?'recent':'older';
  let ageLabel='';
  if(ageDays!==null){
   if(isPublication)ageLabel=ageDays===0?text(lang,'Publié aujourd’hui','Published today'):ageDays===1?text(lang,'Publié hier','Published yesterday'):text(lang,`Publié il y a ${ageDays} jours`,`Published ${ageDays} days ago`);
   else ageLabel=ageDays===0?text(lang,'Opération aujourd’hui','Executed today'):ageDays===1?text(lang,'Opération hier','Executed yesterday'):text(lang,`Opération il y a ${ageDays} jours`,`Executed ${ageDays} days ago`);
  }
  const warning=future?text(lang,'Date future à vérifier','Future date to verify'):'';
  return {date,text:formatDate(date,{lang}),label,ageDays,ageLabel,freshness,warning};
 }
 function dates(input,{lang='fr',now}={}){
  const row=input&&typeof input==='object'?input:{},today=day(now)||new Date().toISOString().slice(0,10);
  const publication=dateContext(row.fileDate||row.publicationDate||row.filingDate,{lang,now:today,kind:'publication'});
  const execution=dateContext(row.tradeDate||row.date||row.transDate,{lang,now:today,kind:'execution'});
  const warnings=[publication.warning,execution.warning].filter(Boolean);
  if(publication.date&&execution.date){
   const delay=Math.round((Date.parse(publication.date+'T00:00:00Z')-Date.parse(execution.date+'T00:00:00Z'))/DAY);
   if(delay>7)warnings.push(text(lang,`Publication ${delay} jours après l’opération`,`Published ${delay} days after execution`));
   if(delay<0)warnings.push(text(lang,'Opération datée après la publication : à vérifier','Execution dated after publication: verify the dates'));
  }
  return {publication,execution,warnings:[...new Set(warnings)]};
 }
 function qualification(input,{lang='fr'}={}){
  const row=input&&typeof input==='object'?input:{};
  let result=evidence?.classifyInsiderTransaction(row)||{type:row.type==='sell'?'sell':row.type==='buy'?'buy':'other',status:'unknown',reason:'unknown',eligiblePurchase:false,planned:false};
  const sourceFields=['code','transactionCode','transCode','trans_code','nature','nature_raw','transactionNature','securityTitle','security_title','instrument','security','securityType','security_type'];
  const sourceEvidence=sourceFields.some(key=>typeof row[key]==='string'&&row[key].trim())||Array.isArray(row.transactionFootnotes)&&row.transactionFootnotes.length>0||row.isDerivative===true;
  // Summary endpoints already transport the classifier result. Never turn a bare
  // boolean, conflicting metadata or discarded raw evidence into a purchase.
  if(!sourceEvidence&&row.type==='buy'&&row.purchaseSignalEligible===true&&row.purchaseSignalStatus==='eligible'&&row.purchaseSignalReason==='reported-purchase')result={...result,type:'buy',status:'eligible',reason:'reported-purchase',eligiblePurchase:true};
  if(!sourceEvidence&&row.purchaseSignalStatus==='excluded'&&row.purchaseSignalEligible!==true&&Object.hasOwn(exclusions,row.purchaseSignalReason))result={...result,status:'excluded',reason:row.purchaseSignalReason,eligiblePurchase:false};
  let label,detail,tone='neutral';
  if(result.eligiblePurchase){
   label=text(lang,'Achat retenu','Qualifying purchase');tone='positive';
   detail=text(lang,'Achat déclaré retenu selon la nature et les éléments disponibles. Ce classement ne prouve pas une intention personnelle d’investissement.','Disclosed purchase included based on its reported nature and available evidence. This classification does not prove personal investment intent.');
  }else if(result.type==='sell'&&result.reason==='not-purchase'){
   label=text(lang,'Vente déclarée','Disclosed sale');tone='negative';
   detail=text(lang,'Cession déclarée, distincte des signaux d’achat. Son motif personnel n’est pas établi.','Disclosed sale, separate from purchase signals. Its personal motivation is not established.');
  }else if(result.status==='excluded'){
   const names=exclusions[result.reason]||exclusions['not-purchase'];label=lang==='en'?names[1]:names[0];
   detail=text(lang,'Exclu des signaux d’achat selon les modalités déclarées.','Excluded from purchase signals based on the reported transaction terms.');
  }else{
   label=result.type==='buy'?text(lang,'Acquisition à vérifier','Acquisition to verify'):text(lang,'Nature à vérifier','Nature to verify');
   detail=result.reason==='conflicting-direction'?text(lang,'Les indications de sens de l’opération se contredisent. Non retenue parmi les achats.','Reported transaction directions conflict. Not included among qualifying purchases.'):text(lang,'Les éléments disponibles ne permettent pas de qualifier un achat. Non retenue parmi les signaux d’achat.','Available evidence does not establish a qualifying purchase. Not included in purchase signals.');
  }
  if(result.planned)detail+=' '+text(lang,'Plan 10b5-1 déclaré.','A 10b5-1 plan is reported.');
  return {label,detail,tone,status:result.status,reason:result.reason,eligiblePurchase:result.eligiblePurchase,planned:result.planned===true};
 }
 return {day,formatDate,dates,qualification};
});
