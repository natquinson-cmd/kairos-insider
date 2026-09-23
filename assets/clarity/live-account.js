(function(root){'use strict';
function subscriptionView(data,lang){
  if(!data||typeof data.entitled!=='boolean'||typeof data.hasSubscription!=='boolean')throw new Error('Subscription status unavailable');
  const t=(fr,en)=>lang==='en'?en:fr,owner=data.isAdmin===true,paid=data.hasSubscription===true;
  const plan=data.plan==='elite'?'Elite':'Pro';
  return {
    access:owner?t('Accès administrateur','Administrator access'):paid?t('Accès '+plan,plan+' access'):data.entitled?t('Accès Pro offert','Complimentary Pro access'):t('Accès gratuit','Free access'),
    explanation:owner?t('Les droits d’administration incluent l’accès aux recherches Pro. Ils sont indépendants d’un abonnement payant.','Administrator permissions include Pro research access. They are independent of a paid subscription.'):paid?t('Votre abonnement vous donne accès aux recherches Pro.','Your subscription provides access to Pro research.'):data.entitled?t('Un accès Pro vous a été accordé sans abonnement payant.','You have been granted Pro access without a paid subscription.'):t('Vous disposez des consultations incluses dans l’offre gratuite.','You have the analysis allowance included in the free plan.'),
    subscription:paid?'Kairos '+plan+' · '+(data.billing==='yearly'?t('Annuel','Annual'):t('Mensuel','Monthly')):t('Aucun abonnement payant','No paid subscription'),
    canManage:paid||!!(data.plan&&data.status),canUpgrade:!data.entitled&&!paid,
    status:({active:t('Actif','Active'),past_due:t('Paiement en retard','Payment overdue'),trialing:t('Période d’essai','Trial'),canceled:t('Résilié','Canceled'),unpaid:t('Paiement requis','Payment required'),incomplete:t('Paiement à finaliser','Payment incomplete')})[data.status]||data.status||'',
  };
}
if(typeof module==='object'&&module.exports){module.exports={subscriptionView};return;}
const U=root.KairosUI,{t,esc:e,lang}=U,$=id=>document.getElementById(id);
const date=value=>{const d=new Date(value);return value&&!Number.isNaN(d.getTime())?d.toLocaleDateString(lang==='en'?'en-US':'fr-FR',{day:'numeric',month:'long',year:'numeric'}):'—';};
const field=(label,value)=>`<div><dt>${e(label)}</dt><dd>${e(value||'—')}</dd></div>`;
document.title=t('Mon compte — Kairos Insider','My account — Kairos Insider');
$('accountEyebrow').textContent=t('VOTRE ESPACE PERSONNEL','YOUR PERSONAL WORKSPACE');$('accountTitle').textContent=t('Mon compte.','My account.');$('accountIntro').textContent=t('Votre identité, vos accès et votre abonnement, au même endroit.','Your identity, access and subscription in one place.');
async function loadSubscription(){
  const host=$('accountSubscription');host.innerHTML=`<p class="data-note">${t('Vérification de votre abonnement…','Checking your subscription…')}</p>`;
  try{
    const data=await U.api('/stripe/status'),view=subscriptionView(data,lang);
    $('accountAccess').innerHTML=`<span class="screen-eyebrow">${t('VOTRE ACCÈS','YOUR ACCESS')}</span><h2>${e(view.access)}</h2><p>${e(view.explanation)}</p>`;
    host.innerHTML=`<span class="screen-eyebrow">${t('ABONNEMENT & FACTURATION','SUBSCRIPTION & BILLING')}</span><h2>${e(view.subscription)}</h2>${view.status?`<p><span class="live-pill">${e(view.status)}</span></p>`:''}${data.currentPeriodEnd?`<p class="data-note">${t('Fin de la période en cours','Current period ends')}: ${date(data.currentPeriodEnd*1000)}</p>`:''}${view.canManage?`<p class="data-note">${t('Gérez votre carte, vos factures et la résiliation dans votre espace de facturation sécurisé.','Manage your card, invoices and cancellation in your secure billing portal.')}</p><button class="secondary" id="accountPortal">${t('Gérer mon abonnement','Manage subscription')} ↗</button>`:view.canUpgrade?`<p class="data-note">${t('Découvrez les fonctionnalités incluses dans Pro.','Explore the features included in Pro.')}</p><a class="secondary" href="index.html?lang=${lang}#pricing">${t('Découvrir Pro','Explore Pro')} →</a>`:`<p class="data-note">${t('Aucun abonnement payant actif n’est associé à ce compte. Vos droits d’accès sont indiqués séparément.','No active paid subscription is associated with this account. Your access permissions are shown separately.')}</p>`}<p id="accountBillingMessage" role="status"></p>`;
    if(view.canManage)$('accountPortal').addEventListener('click',async()=>{
      const button=$('accountPortal');button.disabled=true;$('accountBillingMessage').textContent=t('Ouverture du portail sécurisé…','Opening the secure portal…');
      try{const result=await U.api('/stripe/portal',{method:'POST'}),url=new URL(result.url);if(url.protocol!=='https:'||url.hostname!=='billing.stripe.com')throw new Error('Invalid portal');root.location.href=url.href;}
      catch{$('accountBillingMessage').textContent=t('Le portail est indisponible. Réessayez dans quelques instants.','The portal is unavailable. Please try again shortly.');button.disabled=false;}
    });
  }catch{
    $('accountAccess').innerHTML=`<h2>${t('Accès à vérifier','Access status unavailable')}</h2><p>${t('Nous n’avons pas pu confirmer vos droits d’accès.','We could not confirm your access permissions.')}</p>`;
    host.innerHTML=`<h2>${t('Abonnement indisponible','Subscription status unavailable')}</h2><p class="data-note">${t('Votre statut n’a pas pu être chargé.','Your status could not be loaded.')}</p><button class="secondary" id="accountRetry">${t('Réessayer','Retry')}</button>`;
    $('accountRetry').addEventListener('click',loadSubscription);
  }
}
async function mount(){
  const identity=await U.getAccount();$('liveStatus').hidden=true;
  if(!identity){$('accountContent').innerHTML=`<section class="account-card"><h2>${t('Retrouvez votre compte','Access your account')}</h2><p>${t('Connectez-vous pour consulter vos informations et gérer votre abonnement.','Sign in to view your information and manage your subscription.')}</p><button class="secondary" id="accountLogin">${t('Se connecter','Sign in')}</button></section>`;$('accountLogin').addEventListener('click',U.login);return;}
  $('accountIdentity').innerHTML=`<span class="screen-eyebrow">${t('IDENTITÉ','IDENTITY')}</span><h2>${e(identity.displayName||t('Votre profil','Your profile'))}</h2><dl class="account-fields">${field('Email',identity.email)}${field(t('Vérification','Verification'),identity.emailVerified?t('Email vérifié','Email verified'):t('Email non vérifié','Email not verified'))}${field(t('Membre depuis','Member since'),date(identity.createdAt))}</dl>${U.updateDisplayName?`<form id="accountNameForm"><label for="accountName">${t('Nom affiché','Display name')}</label><div class="account-name-controls"><input id="accountName" name="displayName" value="${e(identity.displayName||'')}" maxlength="100" required autocomplete="name"><button class="secondary" type="submit">${t('Enregistrer','Save')}</button></div><p id="accountNameMessage" role="status"></p></form>`:''}`;
  if(U.updateDisplayName)$('accountNameForm').addEventListener('submit',async event=>{event.preventDefault();const button=event.target.querySelector('button');button.disabled=true;try{await U.updateDisplayName($('accountName').value);$('accountNameMessage').textContent=t('Nom enregistré.','Name saved.');$('accountIdentity').querySelector('h2').textContent=$('accountName').value.trim();}catch{$('accountNameMessage').textContent=t('Impossible d’enregistrer le nom. Réessayez.','Could not save your name. Please retry.');}finally{button.disabled=false;}});
  await loadSubscription();U.translate?.();
}
mount().catch(error=>U.showError($('liveStatus'),error));
})(typeof window==='object'?window:globalThis);
