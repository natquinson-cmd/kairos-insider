(async()=>{'use strict';
const U=window.KairosUI,{t}=U,key='kairos_exit_intent_shown',started=Date.now();
let shown=false,accountKnown=false,anonymous=false;
U.getAccount().then(account=>{anonymous=!account;accountKnown=true;}).catch(()=>{});
function alreadyShown(){try{return sessionStorage.getItem(key)==='1';}catch{return shown;}}
function openFeedback(automatic=false){
 if(document.querySelector('dialog[open]'))return;
 if(automatic&&(!accountKnown||!anonymous||shown||alreadyShown()||Date.now()-started<30000||document.visibilityState!=='visible'))return;
 shown=true;try{sessionStorage.setItem(key,'1');}catch{}
 const previous=document.activeElement,dialog=document.createElement('dialog');dialog.className='live-dialog feedback-dialog';dialog.setAttribute('aria-labelledby','feedbackTitle');
 dialog.innerHTML=`<button class="dialog-close" aria-label="${t('Fermer','Close')}">×</button><span class="feedback-eyebrow">${t('VOTRE AVIS COMPTE','YOUR FEEDBACK MATTERS')}</span><h2 id="feedbackTitle">${automatic?t('Avant de partir…','Before you leave…'):t('Comment améliorer Kairos ?','How can we improve Kairos?')}</h2><p>${t('Vous cherchiez quelque chose en particulier ? Dites-moi ce qui vous manque ou ce qui pourrait être plus clair. Je lis chaque retour personnellement.','Were you looking for something specific? Tell me what is missing or what could be clearer. I read every message personally.')}</p><form><label for="feedbackText">${t('Votre retour','Your feedback')}</label><textarea id="feedbackText" name="message" rows="3" maxlength="2000" required placeholder="${t('Je voulais trouver…','I was hoping to find…')}"></textarea><label for="feedbackEmail">${t('Votre email · facultatif','Your email · optional')}</label><input id="feedbackEmail" name="email" type="email" maxlength="100" autocomplete="email" placeholder="${t('Pour recevoir une réponse','To receive a reply')}"><p class="feedback-status" role="status" aria-live="polite"></p><div class="feedback-actions"><button type="button" class="secondary" data-dismiss>${t('Pas maintenant','Not now')}</button><button type="submit" class="primary">${t('Envoyer','Send')}</button></div></form><footer>${t('Nathanaël, fondateur de Kairos','Nathanaël, Kairos founder')} · <a href="mailto:contact@kairosinsider.fr">contact@kairosinsider.fr</a></footer>`;
 document.body.append(dialog);
 const close=()=>dialog.close();dialog.querySelector('.dialog-close').onclick=close;dialog.querySelector('[data-dismiss]').onclick=close;
 dialog.addEventListener('click',event=>{if(event.target===dialog)close();});
 dialog.addEventListener('close',()=>{dialog.remove();previous?.focus();},{once:true});
 const form=dialog.querySelector('form'),status=dialog.querySelector('[role=status]'),submit=form.querySelector('[type=submit]');let sending=false;
 form.onsubmit=async event=>{event.preventDefault();if(sending)return;const text=form.elements.message.value.trim(),email=form.elements.email.value.trim();if(!text){status.textContent=t('Écrivez votre retour avant de l’envoyer.','Please write your feedback before sending.');return;}if(!form.reportValidity())return;
  sending=true;submit.disabled=true;status.textContent=t('Envoi en cours…','Sending…');
  try{const response=await fetch('https://kairos-insider-api.natquinson.workers.dev/api/feedback/exit-intent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,email,page:location.pathname})});if(!response.ok)throw new Error(response.status===429?'rate':'network');const data=await response.json();if(!data.ok)throw new Error('network');status.textContent=t('Merci pour votre retour ! Votre message a bien été reçu.','Thank you! Your message has been received.');form.elements.message.disabled=true;form.elements.email.disabled=true;submit.hidden=true;dialog.querySelector('[data-dismiss]').textContent=t('Fermer','Close');}
  catch(error){status.textContent=error.message==='rate'?t('Vous avez envoyé plusieurs retours récemment. Réessayez plus tard.','You have sent several messages recently. Please try later.'):t('L’envoi a échoué. Votre message est conservé ici ; vous pouvez réessayer.','Sending failed. Your message is kept here; please try again.');submit.disabled=false;}
  finally{sending=false;}
 };
 dialog.showModal();
}
const footer=document.createElement('footer');footer.className='feedback-footer';const button=document.createElement('button');button.className='text-button';button.textContent=t('Donner mon avis','Give feedback');button.onclick=()=>openFeedback();footer.append(button);document.querySelector('.workspace-body').append(footer);
document.addEventListener('mouseleave',event=>{if(event.clientY<=0)openFeedback(true);});
})();
