/* Local research explorer. Numeric ratios retain their original units. */
(() => {
  'use strict';
  const instances = new WeakMap();
  let sequence = 0;
  let activePopover = null;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const valid = value => typeof value === 'number' && Number.isFinite(value);
  const number = (value, digits = 1) => valid(value) ? value.toLocaleString(window.KairosUI?.lang==='en'?'en-US':'fr-FR', {minimumFractionDigits:digits, maximumFractionDigits:digits}) : '—';
  const colors = ['#fa98a7','#eec078','#b39aff','#80aaff','#73dfbf'];
  const caution = 'Repères de lecture, à comparer au secteur, à l’historique de la société et à sa croissance. Ces couleurs ne constituent pas un conseil d’achat ou de vente.';
  const metricPalette = metric => ['valuation','leverage'].includes(metric.tone) ? [...colors].reverse() : metric.tone==='sensitivity' ? ['#7aa9ff','#9aaeff','#b39aff','#eec078','#fa98a7'] : colors;
  const invalidBasis = metric => valid(metric.value)&&((metric.tone==='valuation'&&metric.value<=0)||(metric.tone==='leverage'&&metric.value<0));
  function metricReading(metric) {
    if(!valid(metric.value))return {color:metric.formatted&&metric.formatted!=='Indisponible'?'#c8bcf2':'#9cacc5',label:''};
    if(!metric.stops)return {color:metric.label==='Valeur d’entreprise'?'#cfb9ff':'#a7c9fa',label:''};
    if(invalidBasis(metric))return {color:'#a9b7cf',label:metric.tone==='leverage'?'Base non interprétable':'Base non positive'};
    const index=Math.max(0,Math.min(4,metric.stops.slice(1).findIndex(stop=>metric.value<stop)<0?4:metric.stops.slice(1).findIndex(stop=>metric.value<stop)));
    const readings={
      valuation:['Multiple bas','Multiple intermédiaire','Multiple élevé','Multiple très élevé','Multiple très élevé'],
      liquidity:['Couverture limitée','Couverture partielle','Couverture proche de 1×','Couverture supérieure à 1×','Liquidité plus élevée'],
      leverage:['Dette relative faible','Dette relative modérée','Dette / fonds propres < 1×','Dette ≥ fonds propres','Dette relative élevée'],
      health:['Peu de critères réunis','Plusieurs critères à examiner','Profil partagé','Majorité des critères réunis','Critères largement réunis'],
      sensitivity:['Sensibilité inverse','Sensibilité limitée','Proche du marché','Sensibilité élevée','Sensibilité très élevée']
    };
    let label=readings[metric.tone]?.[index]||'';
    if(metric.tone==='profit'){
      const noun=metric.label.startsWith('Marge')?'Marge':'Rentabilité';
      label=metric.value<0?`${noun} négative`:metric.value===0?'À l’équilibre':`${noun} ${['positive','positive','intermédiaire','élevée','très élevée'][index]}`;
    }
    return {color:metricPalette(metric)[index],label};
  }
  const definitions = {
    marketCap:['Capitalisation','money','La valeur boursière de l’ensemble des actions de la société. Sa taille ne dit pas si une action est attractive.','Cours × nombre d’actions en circulation.'],
    enterpriseValue:['Valeur d’entreprise','money','Une mesure de la valeur des activités, tenant compte de la dette et de la trésorerie.','Capitalisation + dette financière − trésorerie, avec ajustements selon la source.'],
    trailingPE:['P/E · 12 mois','ratio','Le multiple des bénéfices des douze derniers mois. Un faible multiple peut aussi refléter des risques ou des bénéfices exceptionnellement élevés.','Cours ÷ bénéfice par action des douze derniers mois.',[0,15,25,40,60,80],'valuation'],
    forwardPE:['P/E prévisionnel','ratio','Le multiple des bénéfices attendus. Il dépend d’estimations qui peuvent être révisées.','Cours ÷ bénéfice par action prévisionnel.',[0,15,25,40,60,80],'valuation'],
    priceSales:['Cours / ventes','ratio','Le prix de marché rapporté au chiffre d’affaires. Le niveau de marge compte beaucoup dans sa lecture.','Capitalisation ÷ chiffre d’affaires.',[0,2,5,10,15,25],'valuation'],
    priceBook:['Cours / actif net','ratio','La valeur de marché comparée aux capitaux propres comptables. Les rachats d’actions et les actifs incorporels peuvent fortement modifier ce ratio.','Capitalisation ÷ capitaux propres.',[0,1.5,3,5,10,20],'valuation'],
    priceFcf:['Cours / cash-flow libre','ratio','Le multiple des liquidités générées après les investissements. Des flux ponctuels peuvent le déformer.','Capitalisation ÷ flux de trésorerie disponible.',[0,15,25,40,60,80],'valuation'],
    evEbitda:['EV / EBITDA','ratio','La valeur des activités rapportée à un résultat avant intérêts, impôts et amortissements. Ce multiple ignore notamment les besoins d’investissement.','Valeur d’entreprise ÷ EBITDA.',[0,10,15,25,40,60],'valuation'],
    eps:['Bénéfice par action','price','Le résultat attribuable à une action. Il faut tenir compte du nombre de titres et des éléments exceptionnels.','Résultat net attribuable aux actionnaires ÷ nombre moyen d’actions.'],
    dividendYield:['Rendement du dividende','percent','Le dividende rapporté au cours. Un rendement élevé peut provenir d’une baisse du cours ; le dividende futur n’est pas garanti.','Dividende annuel par action ÷ cours × 100.'],
    beta:['Bêta · sensibilité au marché','decimal','La sensibilité historique de l’action aux mouvements de son marché de référence. Un bêta supérieur à 1 indique une sensibilité plus forte, sans mesurer tous les risques ni la volatilité absolue.','Covariance des rendements de l’action et du marché ÷ variance des rendements du marché.',[-.5,0,.7,1.3,2,3],'sensitivity'],
    grossMargin:['Marge brute','percent','La part des ventes conservée après les coûts directs de production. Les modèles économiques ne sont pas tous comparables.','Résultat brut ÷ chiffre d’affaires × 100.',[-20,0,20,40,60,80],'profit'],
    operatingMargin:['Marge opérationnelle','percent','La part des ventes qui reste après les charges d’exploitation, avant le résultat financier et l’impôt.','Résultat opérationnel ÷ chiffre d’affaires × 100.',[-20,0,10,20,30,50],'profit'],
    netMargin:['Marge nette','percent','La part des ventes transformée en résultat net, après l’ensemble des charges.','Résultat net ÷ chiffre d’affaires × 100.',[-20,0,5,15,25,40],'profit'],
    roe:['Rentabilité des fonds propres','percent','Le résultat rapporté aux capitaux propres. Un endettement élevé ou de faibles capitaux propres peuvent gonfler ce ratio.','Résultat net ÷ capitaux propres moyens × 100.',[-20,0,10,20,40,80],'profit'],
    roa:['Rentabilité des actifs','percent','Le résultat rapporté aux actifs mobilisés. Les secteurs qui utilisent beaucoup d’actifs ont des profils différents.','Résultat net ÷ total moyen des actifs × 100.',[-10,0,3,8,15,25],'profit'],
    roic:['Rentabilité du capital investi','percent','Le rendement des capitaux engagés dans les activités. Il s’apprécie notamment par rapport au coût de ce capital.','Résultat opérationnel après impôt ÷ capital investi moyen × 100.',[-10,0,5,10,20,35],'profit'],
    currentRatio:['Liquidité générale','ratio','La couverture des dettes à court terme par les actifs à court terme. Leur qualité et le cycle d’exploitation restent déterminants.','Actifs courants ÷ passifs courants.',[0,.5,1,1.5,2,3],'liquidity'],
    quickRatio:['Liquidité réduite','ratio','La couverture des dettes à court terme sans dépendre de la vente des stocks.','Actifs courants hors stocks ÷ passifs courants.',[0,.4,.8,1,1.5,2.5],'liquidity'],
    debtEquity:['Dette / fonds propres','ratio','La dette financière rapportée aux capitaux propres. Le niveau soutenable dépend notamment du secteur et de la stabilité des flux.','Dette financière ÷ capitaux propres.',[0,.25,.5,1,2,3],'leverage'],
    netCash:['Trésorerie nette','money','Les liquidités après déduction de la dette financière. Une valeur négative correspond à une dette nette.','Trésorerie et équivalents − dette financière.'],
    revenue:['Chiffre d’affaires','money','Le montant des ventes comptabilisées sur la période. Il ne correspond ni au bénéfice ni aux encaissements.','Somme des revenus comptabilisés sur l’exercice.'],
    netIncome:['Résultat net','money','Le bénéfice ou la perte après les charges, les intérêts et les impôts.','Total des produits − total des charges, y compris les intérêts et les impôts.'],
    freeCashFlow:['Cash-flow libre','money','Les liquidités disponibles après les investissements nécessaires. Une mesure distincte du résultat comptable.','Flux de trésorerie opérationnels − dépenses d’investissement.']
  };

  function render(host, company = {}) {
    if (!host || typeof host.replaceChildren !== 'function') throw new TypeError('KairosAnalysis.render attend un élément HTML.');
    const previous=instances.get(host);
    let currentView=previous?.view||'valuation';
    previous?.destroy();
    const doc = host.ownerDocument;
    const root = doc.createElement('section'); root.className = 'ka-analysis'; host.replaceChildren(root);
    const abort = new AbortController();
    const uid = `ka-${++sequence}`;
    const research = company.research;
    const popup = doc.createElement('div');
    popup.className = 'ka-popover'; popup.id = `${uid}-explanation`; popup.hidden = true;
    popup.setAttribute('role','dialog'); popup.setAttribute('aria-modal','false');
    doc.body.append(popup);
    let anchor = null, pinned = false, hideTimer = null, hoverTimer = null, hoverAnchor = null, destroyed = false, currentKey = null;
    const metrics = new Map();
    const currency = /^[A-Z]{3}$/.test(company.currency || '') ? company.currency : 'USD';
    const symbol = {USD:'$',EUR:'€',GBP:'£',CHF:'CHF'}[currency] || currency;
    const price = value => valid(value) ? `${number(value,2)} ${symbol}` : 'Indisponible';
    const money = value => {
      if (!valid(value)) return 'Indisponible';
      const abs = Math.abs(value), unit = abs >= 1e12 ? [1e12,'T'] : abs >= 1e9 ? [1e9,'Md'] : abs >= 1e6 ? [1e6,'M'] : abs >= 1e3 ? [1e3,'k'] : [1,''];
      return `${number(value/unit[0],unit[0]===1?0:1)} ${unit[1]}${symbol}`;
    };
    const display = (value, unit) => !valid(value) ? 'Indisponible' : unit === 'money' ? money(value) : unit === 'price' ? price(value) : unit === 'percent' ? `${number(value)} %` : unit === 'ratio' ? `${number(value)}×` : unit === 'integer' ? number(value,0) : number(value,2);
    const date = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value)) ? new Date(`${value}T12:00:00Z`).toLocaleDateString(window.KairosUI?.lang==='en'?'en-US':'fr-FR',{day:'numeric',month:'long',year:'numeric'}) : 'date non précisée';
    function destroy() {
      if (destroyed) return; destroyed = true; closePopup(); abort.abort(); popup.remove(); root.remove();
      if (instances.get(host) === instance) instances.delete(host);
    }
    const instance = {destroy,hideTooltip:closePopup,get view(){return currentView;}}; instances.set(host,instance);
    if (!research?.fundamentals) {
      root.innerHTML='<div class="ka-empty"><h3>Analyse bientôt disponible</h3><p>Les données de valorisation, de rentabilité et de consensus apparaîtront ici lorsqu’elles seront disponibles.</p></div>';
      return instance;
    }
    const fundamentals = research.fundamentals;
    const analysts = research.analysts || {};
    const criteria = Array.isArray(research.health?.criteria) ? research.health.criteria : [];
    const passed = criteria.filter(criterion=>criterion.pass===true).length;
    const knownCriteria = criteria.filter(criterion=>typeof criterion.pass==='boolean').length;
    const currentPrice = company.history?.at(-1)?.close;
    const buckets = [['strongBuy','Achat fort',colors[4]],['buy','Achat',colors[3]],['hold','Conserver',colors[2]],['sell','Vente',colors[1]],['strongSell','Vente forte',colors[0]]].map(([key,label,color])=>({key,label,color,count:valid(analysts[key])&&analysts[key]>=0?analysts[key]:null}));
    const hasCounts = buckets.every(bucket=>bucket.count!==null);
    const total = hasCounts ? buckets.reduce((sum,bucket)=>sum+bucket.count,0) : null;
    const bullish = total > 0 ? (analysts.strongBuy+analysts.buy)/total*100 : null;
    const potential = valid(analysts.targetMean)&&valid(currentPrice)&&currentPrice>0 ? (analysts.targetMean/currentPrice-1)*100 : null;
    function addMetric(key, config) { if(window.KairosUI?.lang==='en'){const pair=window.KairosMetricEnglish?.[key];if(pair){config.description=pair[0];config.formula=pair[1];}else if(key.startsWith('bucket-')){config.description='The number of analyst opinions in this rating category.';config.formula='Count supplied by the consensus provider.';}} metrics.set(key,config); return key; }
    Object.entries(definitions).forEach(([key,[label,unit,description,formula,stops,tone]])=>addMetric(key,{label,unit,value:fundamentals[key],description,formula,stops,tone}));
    const growthMetrics=(Array.isArray(company.financials)?company.financials:[]).filter(metric=>typeof metric.change==='string').map((metric,index)=>{
      const key=`annualGrowth${index}`;
      addMetric(key,{label:metric.label,formatted:metric.change,unit:'text',description:`Variation annuelle de « ${metric.label} » dans la période indiquée, par rapport à l’exercice précédent.`,formula:'(Valeur de l’exercice courant ÷ valeur de l’exercice précédent − 1) × 100. Les variations fournies restent celles du fournisseur.'});
      return key;
    });
    addMetric('healthScore',{label:'Critères de santé réunis',value:knownCriteria?passed:null,unit:'integer',formatted:knownCriteria?`${passed}/${criteria.length}`:'Indisponible',description:`Ce compteur vérifie ${criteria.length} critères visibles ci-dessous. Il est distinct du radar Kairos et de ses pondérations.${knownCriteria<criteria.length?` ${criteria.length-knownCriteria} critère(s) restent sans donnée.`:''}`,formula:'Un point par critère rempli ; aucun point attribué en l’absence de validation.',stops:criteria.length===7?[0,1,3,4,6,7]:[0,.2,.4,.6,.8,1].map(value=>value*Math.max(criteria.length,1)),tone:'health'});
    const tr=(fr,en)=>window.KairosUI?.lang==='en'?en:fr;
    const criterionValue=c=>valid(c.value)?number(c.value,2)+(c.unit==='percent'?' %':c.unit==='ratio'?'×':''):tr('Indisponible','Unavailable');
    criteria.forEach((criterion,index)=>{
      const definition=definitions[criterion.key],english=window.KairosMetricEnglish?.[criterion.key];
      const threshold=valid(criterion.threshold)&&['>','<'].includes(criterion.comparison)?(valid(criterion.minimum)?number(criterion.minimum,0)+' ≤ '+tr('valeur','value')+' ':'')+criterion.comparison+' '+number(criterion.threshold,0)+(criterion.unit==='percent'?' %':'×'):null;
      const status=criterion.pass===true?tr('Critère rempli.','Criterion met.'):criterion.pass===false?tr('Critère non rempli.','Criterion not met.'):tr('Validation indisponible.','Validation unavailable.');
      addMetric('criterion'+index,{label:String(criterion.label),value:criterion.value,formatted:criterionValue(criterion),unit:criterion.unit||'text',description:status+' '+(threshold?tr('Seuil de validation : ','Validation threshold: ')+threshold+'. ':'')+(window.KairosUI?.lang==='en'?english?.[0]||'':definition?.[2]||''),formula:(window.KairosUI?.lang==='en'?english?.[1]:definition?.[3])||tr('Un point par critère validé sur les données disponibles.','One point per criterion verified using available data.'),stops:definition?.[4],tone:definition?.[5]});
    });
    addMetric('altmanZ',{label:'Score Altman Z',value:research.health?.altmanZ,unit:'decimal',description:'Un modèle statistique d’analyse de la fragilité financière, dont la formule dépend du type de société.',formula:'Les données et la variante du modèle nécessaires ne sont pas disponibles dans les données disponibles.'});
    addMetric('piotroskiF',{label:'Score Piotroski F',value:research.health?.piotroskiF,unit:'integer',description:'Un score fondé sur neuf critères comptables de rentabilité, de financement et d’efficacité.',formula:'Somme de neuf critères binaires, de 0 à 9. Les comparaisons comptables nécessaires ne sont pas disponibles ici.'});
    addMetric('analystTotal',{label:'Analystes suivis',value:total,unit:'integer',description:'Le nombre d’avis dans les cinq catégories du consensus affiché. Il ne mesure pas à lui seul la fiabilité d’une prévision.',formula:'Achat fort + achat + conserver + vente + vente forte.'});
    addMetric('bullish',{label:'Avis à l’achat',value:bullish,unit:'percent',description:'La proportion des avis « achat fort » et « achat » dans ce consensus. Ce sont les opinions des analystes, pas une recommandation de Kairos.',formula:'(Achat fort + achat) ÷ total des avis × 100.'});
    addMetric('recommendation',{label:'Consensus',formatted:analysts.recommendation||'Indisponible',unit:'text',description:'La synthèse des recommandations fournie pour les données disponibles. Les analystes peuvent se tromper et réviser leurs avis.',formula:'Synthèse du consensus fourni avec les cinq catégories d’avis.'});
    addMetric('currentPrice',{label:'Cours actuel',value:currentPrice,unit:'price',description:'La dernière clôture disponible dans la série disponible. Elle sert de référence au calcul de l’écart à l’objectif moyen.',formula:'Dernière valeur de clôture de la série affichée.'});
    [['targetLow','Objectif bas'],['targetMean','Objectif moyen'],['targetHigh','Objectif haut']].forEach(([key,label])=>addMetric(key,{label,value:analysts[key],unit:'price',description:`${key==='targetLow'?'Le plus bas':key==='targetHigh'?'Le plus haut':'La moyenne'} des objectifs de cours à douze mois présents dans le consensus. Il s’agit d’une estimation, pas d’un cours futur garanti.`,formula:key==='targetMean'?'Somme des objectifs de cours ÷ nombre d’objectifs disponibles.':key==='targetLow'?'Minimum des objectifs de cours disponibles.':'Maximum des objectifs de cours disponibles.'}));
    addMetric('targetPotential',{label:'Écart à l’objectif moyen',value:potential,unit:'percent',formatted:valid(potential)?`${potential>0?'+':''}${number(potential)} %`:'Indisponible',description:'La distance entre l’objectif moyen et le cours actuel. Un écart positif n’est pas une prévision de rendement.',formula:'(Objectif moyen ÷ cours actuel − 1) × 100.'});
    buckets.forEach(bucket=>addMetric(`bucket-${bucket.key}`,{label:`Avis « ${bucket.label.toLowerCase()} »`,value:bucket.count,unit:'integer',description:'Le nombre d’analystes dans cette catégorie du consensus.',formula:total>0?`${number(bucket.count,0)} avis sur ${number(total,0)}, soit ${number(bucket.count/total*100)} % du consensus.`:'Le nombre total d’avis est indisponible.'}));

    function card(key, extra = '') {
      const metric=metrics.get(key), text=metric.formatted??display(metric.value,metric.unit),reading=metricReading(metric);
      return `<button type="button" class="ka-metric ${extra}" style="--ka-metric-color:${reading.color}" data-ka-metric="${key}" aria-haspopup="dialog" aria-expanded="false" aria-controls="${popup.id}"><span class="ka-metric-label">${escape(metric.label)}<i aria-hidden="true">?</i></span><strong class="${metric.unit==='text'?'ka-text-value':''}">${escape(text)}</strong>${reading.label?`<small class="ka-reading">${escape(reading.label)}</small>`:''}</button>`;
    }
    const targetValid = [analysts.targetLow,analysts.targetMean,analysts.targetHigh,currentPrice].every(valid)&&analysts.targetLow<=analysts.targetMean&&analysts.targetMean<=analysts.targetHigh;
    function targets() {
      if(!targetValid)return '<p class="ka-note">Les objectifs de cours ne sont pas tous disponibles.</p>';
      const low=Math.min(analysts.targetLow,currentPrice)*.94,high=Math.max(analysts.targetHigh,currentPrice)*1.06,span=Math.max(high-low,1),position=value=>(value-low)/span*100;
      return `<div class="ka-targets"><div class="ka-target-heading"><h4>Objectifs du consensus à 12 mois</h4><button type="button" class="ka-current" data-ka-metric="currentPrice" aria-haspopup="dialog" aria-expanded="false" aria-controls="${popup.id}"><i aria-hidden="true"></i>Cours actuel <b>${price(currentPrice)}</b><span aria-hidden="true">?</span></button></div><div class="ka-target-track" role="img" aria-label="${escape(`Objectifs à douze mois de ${price(analysts.targetLow)} à ${price(analysts.targetHigh)}, moyenne ${price(analysts.targetMean)}. Cours actuel ${price(currentPrice)}.`)}"><i class="ka-target-band" style="left:${position(analysts.targetLow)}%;width:${position(analysts.targetHigh)-position(analysts.targetLow)}%"></i><i class="ka-target-mean" style="left:${position(analysts.targetMean)}%"></i><i class="ka-target-current" style="left:${position(currentPrice)}%"></i></div><div class="ka-target-labels">${['targetLow','targetMean','targetHigh'].map(key=>card(key,'ka-target-card')).join('')}</div><p class="ka-note">L’intervalle décrit les objectifs à douze mois des analystes. Il ne représente pas une fourchette de prix garantie.</p></div>`;
    }
    const sections=[['valuation','Valorisation'],['profitability','Rentabilité'],['health','Santé financière'],['analysts','Analystes']];
    root.innerHTML=`<div class="ka-heading"><div><h2>Analyse financière</h2><p>${escape(research.financialPeriod||'Période financière non précisée')} · Données des fournisseurs</p></div><span>Analyse au ${date(research.asOf)}</span></div><div class="ka-tabs" role="tablist" aria-label="Dimensions de l’analyse">${sections.map(([key,label],index)=>`<button type="button" id="${uid}-tab-${key}" role="tab" aria-selected="${index===0}" aria-controls="${uid}-panel-${key}" tabindex="${index===0?0:-1}" data-ka-tab="${key}">${label}</button>`).join('')}</div>
      <section id="${uid}-panel-valuation" role="tabpanel" aria-labelledby="${uid}-tab-valuation" data-ka-panel="valuation"><div class="ka-section-intro"><h4>Quel prix pour cette entreprise ?</h4><p>Comparez ses multiples à ceux de sociétés proches et à son propre historique.</p></div><div class="ka-grid ka-size-grid">${card('marketCap','ka-size-blue')}${card('enterpriseValue','ka-size-purple')}</div><div class="ka-grid ka-ratios">${['trailingPE','forwardPE','priceSales','priceBook','priceFcf','evEbitda'].map(key=>card(key)).join('')}</div><div class="ka-grid ka-support-grid">${['eps','dividendYield','beta'].map(key=>card(key)).join('')}</div><p class="ka-note">Un multiple faible ne suffit pas à conclure qu’une action est sous-évaluée. Survolez ou sélectionnez un indicateur pour comprendre son calcul.</p></section>
      <section id="${uid}-panel-profitability" role="tabpanel" aria-labelledby="${uid}-tab-profitability" data-ka-panel="profitability" hidden><div class="ka-section-intro"><h4>Comment l’entreprise crée ses résultats</h4><p>Les marges parlent des ventes ; les rentabilités parlent des capitaux mobilisés.</p></div><div class="ka-grid ka-ratios">${['grossMargin','operatingMargin','netMargin','roe','roa','roic'].map(key=>card(key)).join('')}</div><div class="ka-grid ka-money-grid">${['revenue','netIncome','freeCashFlow','netCash'].map(key=>card(key)).join('')}</div>${growthMetrics.length?`<h4 class="ka-growth-heading">Évolution par rapport à l’exercice précédent</h4><div class="ka-grid ka-money-grid ka-growth-grid">${growthMetrics.map(key=>card(key,'ka-growth-card')).join('')}</div>`:''}</section>
      <section id="${uid}-panel-health" role="tabpanel" aria-labelledby="${uid}-tab-health" data-ka-panel="health" hidden><div class="ka-section-intro"><h4>Les moyens de tenir dans la durée</h4><p>Liquidité, dette et critères comptables : plusieurs lectures complémentaires.</p></div><div class="ka-health-layout">${card('healthScore','ka-health-score')}<div class="ka-criteria">${criteria.map((criterion,index)=>`<button type="button" class="ka-criterion ${criterion.pass===true?'is-met':criterion.pass===false?'is-unmet':''}" data-ka-metric="criterion${index}" aria-haspopup="dialog" aria-expanded="false" aria-controls="${popup.id}"><span aria-hidden="true">${criterion.pass===true?'✓':criterion.pass===false?'−':'?'}</span><b>${escape(criterion.label)}</b><em class="ka-criterion-value">${escape(criterionValue(criterion))}</em><small>${criterion.pass===true?'Rempli':criterion.pass===false?'Non rempli':'Indisponible'}</small></button>`).join('')||'<p class="ka-note">Les critères sont indisponibles.</p>'}</div></div><p class="ka-note">${research.health?.source==='kairos'?'Lorsque les scores Altman et Piotroski sont absents, ces critères alimentent l’axe Santé du radar. La pondération reste celle du score Kairos.':'Ce compteur reprend uniquement les critères affichés. Il ne remplace ni le radar Kairos ni ses pondérations.'}</p><div class="ka-grid ka-support-grid">${['currentRatio','quickRatio','debtEquity'].map(key=>card(key)).join('')}</div><div class="ka-grid ka-size-grid ka-unavailable">${card('altmanZ')}${card('piotroskiF')}</div><p class="ka-note">Altman Z et Piotroski F restent indisponibles tant que leurs données de calcul complètes ne sont pas présentes.</p></section>
      <section id="${uid}-panel-analysts" role="tabpanel" aria-labelledby="${uid}-tab-analysts" data-ka-panel="analysts" hidden><div class="ka-section-intro"><h4>Ce que dit le consensus</h4><p>Opinions d’analystes, au ${date(analysts.asOf||research.asOf)}. Elles peuvent être révisées.</p></div><div class="ka-grid ka-support-grid">${['recommendation','analystTotal','bullish'].map(key=>card(key)).join('')}</div><div class="ka-consensus"><div class="ka-consensus-bar" role="img" aria-label="${escape(total>0?buckets.map(bucket=>`${bucket.label} : ${bucket.count}`).join(', '):'Répartition indisponible')}">${total>0?buckets.map(bucket=>bucket.count>0?`<span style="width:${bucket.count/total*100}%;background:${bucket.color}"></span>`:'').join(''):'<span class="ka-consensus-empty"></span>'}</div><div class="ka-consensus-legend">${buckets.map(bucket=>`<button type="button" data-ka-metric="bucket-${bucket.key}" aria-haspopup="dialog" aria-expanded="false" aria-controls="${popup.id}"><i style="background:${bucket.color}" aria-hidden="true"></i><span>${bucket.label}</span><b>${number(bucket.count,0)}</b></button>`).join('')}</div></div><div class="ka-grid ka-size-grid ka-target-summary">${card('targetMean')}${card('targetPotential')}</div>${targets()}<p class="ka-note">« Achat » et « vente » décrivent ici les catégories d’avis des analystes. Kairos ne transforme pas ce consensus en consigne d’investissement.</p></section>`;

    function gauge(metric) {
      if(!metric.stops||!valid(metric.value)||invalidBasis(metric))return '';
      const stops=metric.stops,min=stops[0],max=stops.at(-1),level=Math.max(0,Math.min(100,(metric.value-min)/(max-min)*100));
      const palette=metricPalette(metric);
      const leftLabel=metric.tone==='valuation'?'Multiple plus bas':metric.tone==='sensitivity'?'Sensibilité plus faible':metric.tone==='leverage'?'Dette relative plus faible':metric.tone==='health'?'Moins de critères':'Valeur plus faible';
      const rightLabel=metric.tone==='valuation'?'Multiple plus élevé':metric.tone==='sensitivity'?'Sensibilité plus forte':metric.tone==='leverage'?'Dette relative plus élevée':metric.tone==='health'?'Plus de critères':'Valeur plus élevée';
      return `<div class="ka-gauge" role="img" aria-label="${escape(`Repères de ${min} à ${max}${metric.unit==='percent'?' pour cent':''}. Valeur : ${metric.formatted??display(metric.value,metric.unit)}.`)}"><div class="ka-gauge-track">${stops.slice(0,-1).map((stop,index)=>`<i style="width:${(stops[index+1]-stop)/(max-min)*100}%;background:${palette[index]}"></i>`).join('')}<span class="ka-gauge-marker" style="--ka-level:${level}%"></span></div><div class="ka-gauge-ticks">${stops.map((stop,index)=>`<span style="left:${(stop-min)/(max-min)*100}%" class="${index===0?'is-first':index===stops.length-1?'is-last':''}">${number(stop,Number.isInteger(stop)?0:1)}</span>`).join('')}</div><div class="ka-gauge-reading"><span>${leftLabel}</span><span>${rightLabel}</span></div>${metric.value<min||metric.value>max?'<p class="ka-gauge-outside">La valeur dépasse les repères affichés ; le marqueur est placé au bord de l’échelle.</p>':''}</div>`;
    }
    function cancelHide(){if(hideTimer!==null){clearTimeout(hideTimer);hideTimer=null;}}
    function cancelOpen(){if(hoverTimer!==null){clearTimeout(hoverTimer);hoverTimer=null;}hoverAnchor=null;}
    function closePopup(){
      cancelOpen();cancelHide();if(anchor){anchor.setAttribute('aria-expanded','false');anchor.removeAttribute('aria-describedby');}
      popup.hidden=true;anchor=null;currentKey=null;pinned=false;if(activePopover?.close===closePopup)activePopover=null;
    }
    function positionPopup(){
      if(popup.hidden||!anchor)return;
      const rect=anchor.getBoundingClientRect(),viewport=doc.documentElement.clientWidth,height=window.innerHeight;
      if(rect.bottom<0||rect.top>height){closePopup();return;}
      if(viewport<=620){
        popup.style.width=`${Math.max(0,viewport-24)}px`;
        popup.style.maxHeight=`${Math.max(0,height-24)}px`;
        const actual=popup.getBoundingClientRect();
        popup.style.left='12px';
        popup.style.top=`${Math.max(12,height-actual.height-12)}px`;
        return;
      }
      popup.style.width=`${Math.min(358,viewport-24)}px`;popup.style.maxHeight='none';
      const natural=popup.getBoundingClientRect().height,below=height-rect.bottom-12,above=rect.top-12;
      const useBelow=below>=natural||(below>=above);
      popup.style.maxHeight=`${Math.max(90,(useBelow?below:above)-5)}px`;
      const actual=popup.getBoundingClientRect();
      popup.style.left=`${Math.max(12,Math.min(viewport-actual.width-12,rect.left+rect.width/2-actual.width/2))}px`;
      popup.style.top=`${Math.max(8,useBelow?rect.bottom+8:rect.top-actual.height-8)}px`;
    }
    function openPopup(button,pin=false){
      const key=button.dataset.kaMetric,metric=metrics.get(key);if(!metric)return;
      cancelOpen();cancelHide();
      if(anchor===button&&!popup.hidden){if(pin)pinned=true;positionPopup();return;}
      activePopover?.close();anchor=button;currentKey=key;pinned=pin;activePopover={close:closePopup};
      const invalidMultiple=invalidBasis(metric);
      const invalidMessage=metric.tone==='leverage'?'Un ratio négatif peut provenir de capitaux propres négatifs. Cette base ne permet pas d’appliquer les repères usuels de dette ; la jauge est suspendue.':'La base de calcul est nulle ou négative : ce multiple ne permet pas de classer l’action comme « bon marché ». La jauge n’est pas appliquée.';
      const missing=!metric.formatted&&!valid(metric.value);
      popup.setAttribute('aria-labelledby',`${uid}-popover-title`);
      popup.innerHTML=`<div class="ka-popover-heading"><h4 id="${uid}-popover-title">${escape(metric.label)}</h4><button type="button" class="ka-popover-close" aria-label="Fermer l’explication">×</button></div><strong class="ka-popover-value" style="color:${metricReading(metric).color}">${escape(metric.formatted??display(metric.value,metric.unit))}</strong><p>${escape(metric.description)}</p><div class="ka-formula"><span>Calcul</span>${escape(metric.formula)}</div>${invalidMultiple?`<p class="ka-negative-multiple">${invalidMessage}</p>`:missing?'<p class="ka-missing-note">L’absence de donnée n’est pas une valeur zéro.</p>':gauge(metric)}${metric.stops?`<p class="ka-popover-context">${metric.tone==='sensitivity'?'Les couleurs indiquent des niveaux de sensibilité au marché, pas une qualité d’investissement. ':''}${metric.tone==='health'?'Repères du compteur de critères, distincts du score du radar. ':''}${caution}</p>`:''}`;
      popup.hidden=false;button.setAttribute('aria-expanded','true');button.setAttribute('aria-describedby',popup.id);positionPopup();
    }
    function scheduleHide(){
      if(pinned)return;cancelHide();const from=anchor;
      hideTimer=setTimeout(()=>{hideTimer=null;if(anchor===from&&!popup.matches(':hover')&&!popup.contains(doc.activeElement)&&doc.activeElement!==anchor)closePopup();},200);
    }
    function selectTab(key,focus=false){
      currentView=key;
      closePopup();root.querySelectorAll('[data-ka-tab]').forEach(button=>{const selected=button.dataset.kaTab===key;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;if(selected&&focus)button.focus();});
      root.querySelectorAll('[data-ka-panel]').forEach(panel=>panel.hidden=panel.dataset.kaPanel!==key);
    }
    root.addEventListener('click',event=>{
      const tab=event.target.closest('[data-ka-tab]');if(tab){selectTab(tab.dataset.kaTab);return;}
      const button=event.target.closest('[data-ka-metric]');if(!button)return;
      if(anchor===button&&pinned)closePopup();else {openPopup(button,true);if(event.detail===0)popup.querySelector('.ka-popover-close')?.focus({preventScroll:true});}
    },{signal:abort.signal});
    root.addEventListener('pointerover',event=>{
      if(event.pointerType==='touch')return;
      const button=event.target.closest('[data-ka-metric]');
      if(!button||button.contains(event.relatedTarget)||(pinned&&anchor!==button))return;
      cancelOpen();hoverAnchor=button;
      hoverTimer=setTimeout(()=>{hoverTimer=null;hoverAnchor=null;if(!destroyed&&button.matches(':hover')&&(!pinned||anchor===button))openPopup(button);},180);
    },{signal:abort.signal});
    root.addEventListener('pointerout',event=>{const button=event.target.closest('[data-ka-metric]');if(button&&!button.contains(event.relatedTarget)){if(button===hoverAnchor)cancelOpen();if(button===anchor)scheduleHide();}},{signal:abort.signal});
    root.addEventListener('focusin',event=>{const button=event.target.closest('[data-ka-metric]');if(button)openPopup(button);},{signal:abort.signal});
    root.addEventListener('focusout',event=>{if(!popup.contains(event.relatedTarget))scheduleHide();},{signal:abort.signal});
    root.addEventListener('keydown',event=>{
      const tab=event.target.closest('[data-ka-tab]');if(!tab)return;
      let index=sections.findIndex(([key])=>key===tab.dataset.kaTab);
      if(event.key==='ArrowRight')index=(index+1)%sections.length;else if(event.key==='ArrowLeft')index=(index+sections.length-1)%sections.length;else if(event.key==='Home')index=0;else if(event.key==='End')index=sections.length-1;else return;
      event.preventDefault();selectTab(sections[index][0],true);
    },{signal:abort.signal});
    popup.addEventListener('pointerenter',cancelHide,{signal:abort.signal});popup.addEventListener('pointerleave',scheduleHide,{signal:abort.signal});
    popup.addEventListener('focusout',event=>{if(!popup.contains(event.relatedTarget)&&event.relatedTarget!==anchor)scheduleHide();},{signal:abort.signal});
    popup.addEventListener('click',event=>{if(event.target.closest('.ka-popover-close')){const target=anchor;closePopup();target?.focus({preventScroll:true});closePopup();}},{signal:abort.signal});
    doc.addEventListener('keydown',event=>{if(event.key==='Escape'&&(!popup.hidden||hoverTimer!==null)){event.preventDefault();const target=popup.contains(doc.activeElement)?anchor:null;closePopup();target?.focus({preventScroll:true});closePopup();}},{signal:abort.signal});
    doc.addEventListener('pointerdown',event=>{if(!popup.hidden&&!popup.contains(event.target)&&!event.target.closest('[data-ka-metric]'))closePopup();},{signal:abort.signal});
    window.addEventListener('resize',positionPopup,{signal:abort.signal});doc.addEventListener('scroll',event=>{if(!popup.contains(event.target))positionPopup();},{capture:true,signal:abort.signal});
    selectTab(sections.some(([key])=>key===currentView)?currentView:'valuation');
    return instance;
  }
  window.KairosAnalysis=Object.freeze({render});
})();
