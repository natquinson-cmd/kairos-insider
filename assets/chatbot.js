// ============================================================
// KAIROS CHATBOT WIDGET — Phase 1 (mai 2026)
// ============================================================
// Widget flottant bottom-right qui :
//   1. Demande proactivement aux visiteurs s'ils ont des questions
//   2. Repond aux questions courantes via Claude Haiku
//   3. Collecte les feedbacks/reviews pour le founder
//
// API : POST /api/chatbot/message body { sessionId, messages, lang }
//       -> renvoie { reply, sessionId }
// ============================================================

(function () {
  if (window.__kairosChatbotInited) return;
  window.__kairosChatbotInited = true;

  // Detection automatique de la base API selon l'origine
  const API_BASE = (window.KAIROS_API_BASE || 'https://kairos-insider-api.natquinson.workers.dev').replace(/\/+$/, '');

  // Detection langue (i18n existant ou attribut html lang ou fallback FR)
  const detectLang = () => {
    if (window.KairosI18n && typeof window.KairosI18n.getLang === 'function') {
      const l = window.KairosI18n.getLang();
      if (l === 'en' || l === 'fr') return l;
    }
    const htmlLang = (document.documentElement.lang || '').toLowerCase().slice(0, 2);
    if (htmlLang === 'en') return 'en';
    return 'fr';
  };

  // Session id persistante (LocalStorage) pour garder l'historique entre pages
  const SESSION_KEY = 'kairos_chat_session_v1';
  const HISTORY_KEY = 'kairos_chat_history_v1';
  function getOrCreateSession() {
    try {
      let sid = localStorage.getItem(SESSION_KEY);
      if (!sid) {
        sid = 'sess_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        localStorage.setItem(SESSION_KEY, sid);
      }
      return sid;
    } catch { return 'sess_' + Math.random().toString(36).slice(2, 10); }
  }
  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); }
    catch { return []; }
  }
  function saveHistory(arr) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(arr.slice(-30))); }
    catch {}
  }

  const I18N = {
    fr: {
      bubbleAria: 'Ouvrir l\'aide',
      bubbleHint: 'Une question ? 💬',
      headerTitle: 'Aide Kairos',
      headerSubtitle: 'Réponse en quelques secondes',
      placeholder: 'Pose ta question...',
      send: 'Envoyer',
      welcome: '👋 Salut ! Je suis l\'assistant Kairos Insider. Tu cherches à comprendre comment ça marche ? Pose-moi tes questions sur les insiders, les hedge funds, le score Kairos, ou laisse-moi un avis pour qu\'on s\'améliore.',
      welcomeQuick: ['C\'est quoi Kairos ?', 'Pourquoi créer un compte ?', 'Combien ça coûte ?', 'Donner mon avis'],
      typing: 'En train d\'écrire…',
      errorMsg: 'Désolé, une erreur est survenue. Réessaie ou écris-nous à contact@kairosinsider.fr.',
      poweredBy: 'IA · réponse en français',
      closeAria: 'Fermer',
    },
    en: {
      bubbleAria: 'Open help',
      bubbleHint: 'Question? 💬',
      headerTitle: 'Kairos Help',
      headerSubtitle: 'Answer in seconds',
      placeholder: 'Ask your question...',
      send: 'Send',
      welcome: '👋 Hi! I\'m the Kairos Insider assistant. Want to understand how it works? Ask me about insiders, hedge funds, Kairos Score, or share feedback to help us improve.',
      welcomeQuick: ['What is Kairos?', 'Why sign up?', 'How much?', 'Give feedback'],
      typing: 'Typing…',
      errorMsg: 'Sorry, an error occurred. Try again or write us at contact@kairosinsider.fr.',
      poweredBy: 'AI · English response',
      closeAria: 'Close',
    },
  };

  let lang = detectLang();
  let t = I18N[lang];
  let isOpen = false;
  let isTyping = false;
  let sessionId = getOrCreateSession();
  let history = loadHistory();

  // ============================================================
  // STYLES
  // ============================================================
  const styles = `
    .kc-bubble {
      position: fixed; bottom: 24px; right: 24px; z-index: 9999;
      width: 60px; height: 60px; border-radius: 50%; cursor: pointer;
      background: linear-gradient(135deg, #3B82F6, #8B5CF6, #EC4899);
      color: #fff; border: none; box-shadow: 0 8px 24px rgba(139,92,246,0.4);
      display: flex; align-items: center; justify-content: center;
      font-size: 26px; transition: all 0.25s ease;
      animation: kc-bubble-pulse 2s infinite;
    }
    .kc-bubble:hover { transform: scale(1.08); box-shadow: 0 12px 32px rgba(139,92,246,0.55); }
    @keyframes kc-bubble-pulse {
      0%, 100% { box-shadow: 0 8px 24px rgba(139,92,246,0.4), 0 0 0 0 rgba(139,92,246,0.45); }
      50%      { box-shadow: 0 8px 24px rgba(139,92,246,0.4), 0 0 0 10px rgba(139,92,246,0); }
    }
    .kc-hint {
      position: fixed; bottom: 96px; right: 24px; z-index: 9998;
      background: #0F1729; color: #fff; padding: 9px 14px;
      border-radius: 12px; font-size: 12.5px; font-weight: 500;
      border: 1px solid #1F2937; box-shadow: 0 4px 14px rgba(0,0,0,0.3);
      pointer-events: none; opacity: 0; transform: translateY(6px);
      transition: opacity 0.3s, transform 0.3s;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      max-width: 200px;
    }
    .kc-hint.kc-show { opacity: 1; transform: translateY(0); }
    .kc-hint::after {
      content: ''; position: absolute; bottom: -6px; right: 24px;
      width: 12px; height: 12px; background: #0F1729; border-right: 1px solid #1F2937;
      border-bottom: 1px solid #1F2937; transform: rotate(45deg);
    }
    .kc-panel {
      position: fixed; bottom: 100px; right: 24px; z-index: 9999;
      width: 380px; max-width: calc(100vw - 32px); max-height: 540px; height: 540px;
      background: #0A0F1E; color: #F9FAFB;
      border: 1px solid #1F2937; border-radius: 16px;
      box-shadow: 0 24px 60px rgba(0,0,0,0.55);
      display: none; flex-direction: column; overflow: hidden;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    }
    .kc-panel.kc-open { display: flex; animation: kc-panel-in 0.22s ease-out; }
    @keyframes kc-panel-in { from { opacity:0; transform: translateY(12px) scale(0.96); } to { opacity:1; transform: translateY(0) scale(1); } }
    .kc-header {
      display: flex; align-items: center; gap: 12px; padding: 14px 16px;
      background: linear-gradient(135deg, rgba(59,130,246,0.10), rgba(139,92,246,0.10));
      border-bottom: 1px solid #1F2937;
    }
    .kc-header-avatar {
      width: 40px; height: 40px; border-radius: 50%;
      background: linear-gradient(135deg, #3B82F6, #8B5CF6, #EC4899);
      display: flex; align-items: center; justify-content: center;
      font-size: 18px; flex-shrink: 0;
    }
    .kc-header-info { flex: 1; min-width: 0; }
    .kc-header-title { font-size: 14px; font-weight: 700; color: #F9FAFB; }
    .kc-header-subtitle { font-size: 11px; color: #10B981; display: flex; align-items: center; gap: 5px; margin-top: 2px; }
    .kc-header-subtitle::before { content: ''; width: 6px; height: 6px; background: #10B981; border-radius: 50%; }
    .kc-close-btn {
      background: none; border: none; color: #9CA3AF; font-size: 22px; cursor: pointer;
      padding: 4px 8px; border-radius: 6px; transition: all 0.15s;
      width: 32px; height: 32px; display: flex; align-items: center; justify-content: center;
    }
    .kc-close-btn:hover { background: rgba(255,255,255,0.08); color: #fff; }
    .kc-messages {
      flex: 1; overflow-y: auto; padding: 14px 12px;
      display: flex; flex-direction: column; gap: 10px;
      scrollbar-width: thin; scrollbar-color: #374151 transparent;
    }
    .kc-messages::-webkit-scrollbar { width: 6px; }
    .kc-messages::-webkit-scrollbar-thumb { background: #374151; border-radius: 3px; }
    .kc-msg { max-width: 86%; padding: 9px 13px; border-radius: 12px; font-size: 13px; line-height: 1.5; word-wrap: break-word; }
    .kc-msg.kc-user { align-self: flex-end; background: linear-gradient(135deg, #3B82F6, #6366F1); color: #fff; border-bottom-right-radius: 4px; }
    .kc-msg.kc-assistant { align-self: flex-start; background: #1F2937; color: #E5E7EB; border-bottom-left-radius: 4px; }
    .kc-msg.kc-error { background: rgba(239,68,68,0.18); color: #FCA5A5; border: 1px solid rgba(239,68,68,0.3); }
    .kc-msg a { color: #60A5FA; text-decoration: underline; }
    .kc-typing { align-self: flex-start; padding: 11px 14px; background: #1F2937; border-radius: 12px; border-bottom-left-radius: 4px; display: inline-flex; gap: 4px; }
    .kc-typing span { width: 6px; height: 6px; background: #6B7280; border-radius: 50%; animation: kc-bounce 1.2s infinite; }
    .kc-typing span:nth-child(2) { animation-delay: 0.18s; }
    .kc-typing span:nth-child(3) { animation-delay: 0.36s; }
    @keyframes kc-bounce { 0%, 80%, 100% { transform: scale(0.7); opacity: 0.5; } 40% { transform: scale(1); opacity: 1; } }
    .kc-quick {
      display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 12px 0;
      animation: kc-quick-in 0.3s ease-out;
    }
    @keyframes kc-quick-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
    .kc-quick-btn {
      padding: 6px 11px; background: rgba(59,130,246,0.12); color: #93C5FD;
      border: 1px solid rgba(59,130,246,0.3); border-radius: 16px;
      font-size: 11.5px; cursor: pointer; transition: all 0.15s;
      font-family: inherit;
    }
    .kc-quick-btn:hover { background: rgba(59,130,246,0.22); transform: translateY(-1px); }
    .kc-input-row {
      display: flex; gap: 8px; padding: 12px; border-top: 1px solid #1F2937;
      background: #0A0F1E;
    }
    .kc-input {
      flex: 1; padding: 10px 13px; background: #1F2937; border: 1px solid #374151;
      color: #F9FAFB; border-radius: 10px; font-size: 13px; resize: none;
      font-family: inherit; outline: none; transition: border-color 0.15s;
      max-height: 80px;
    }
    .kc-input:focus { border-color: #3B82F6; }
    .kc-send {
      padding: 0 14px; background: linear-gradient(135deg, #3B82F6, #8B5CF6);
      color: #fff; border: none; border-radius: 10px; cursor: pointer;
      font-size: 13px; font-weight: 600; transition: all 0.15s;
      display: inline-flex; align-items: center; gap: 4px;
    }
    .kc-send:hover { transform: translateY(-1px); box-shadow: 0 4px 14px rgba(59,130,246,0.35); }
    .kc-send:disabled { opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none; }
    .kc-footer {
      padding: 6px 12px; font-size: 10px; color: #6B7280; text-align: center;
      background: #0A0F1E; border-top: 1px solid #1F2937;
    }
    .kc-footer a { color: #9CA3AF; text-decoration: none; }
    @media (max-width: 480px) {
      .kc-panel { right: 12px; bottom: 88px; width: calc(100vw - 24px); height: calc(100vh - 120px); max-height: 600px; }
      .kc-bubble { right: 16px; bottom: 16px; }
      .kc-hint { right: 16px; bottom: 88px; }
    }
  `;

  // ============================================================
  // DOM
  // ============================================================
  const styleEl = document.createElement('style');
  styleEl.textContent = styles;
  document.head.appendChild(styleEl);

  const bubble = document.createElement('button');
  bubble.className = 'kc-bubble';
  bubble.setAttribute('aria-label', t.bubbleAria);
  bubble.innerHTML = '💬';
  document.body.appendChild(bubble);

  const hint = document.createElement('div');
  hint.className = 'kc-hint';
  hint.textContent = t.bubbleHint;
  document.body.appendChild(hint);

  const panel = document.createElement('div');
  panel.className = 'kc-panel';
  panel.innerHTML = `
    <div class="kc-header">
      <div class="kc-header-avatar">🎯</div>
      <div class="kc-header-info">
        <div class="kc-header-title">${t.headerTitle}</div>
        <div class="kc-header-subtitle">${t.headerSubtitle}</div>
      </div>
      <button class="kc-close-btn" aria-label="${t.closeAria}">×</button>
    </div>
    <div class="kc-messages" id="kc-messages"></div>
    <div class="kc-input-row">
      <textarea class="kc-input" id="kc-input" rows="1" placeholder="${t.placeholder}"></textarea>
      <button class="kc-send" id="kc-send">${t.send}</button>
    </div>
    <div class="kc-footer">${t.poweredBy} · <a href="https://kairosinsider.fr" target="_blank" rel="noopener">kairosinsider.fr</a></div>
  `;
  document.body.appendChild(panel);

  const messagesEl = panel.querySelector('#kc-messages');
  const inputEl = panel.querySelector('#kc-input');
  const sendBtn = panel.querySelector('#kc-send');
  const closeBtn = panel.querySelector('.kc-close-btn');

  // ============================================================
  // RENDER
  // ============================================================
  function renderMessages() {
    messagesEl.innerHTML = '';
    if (history.length === 0) {
      // Welcome + quick replies
      const welcome = document.createElement('div');
      welcome.className = 'kc-msg kc-assistant';
      welcome.textContent = t.welcome;
      messagesEl.appendChild(welcome);
      const quick = document.createElement('div');
      quick.className = 'kc-quick';
      t.welcomeQuick.forEach(label => {
        const btn = document.createElement('button');
        btn.className = 'kc-quick-btn';
        btn.textContent = label;
        btn.addEventListener('click', () => sendMessage(label));
        quick.appendChild(btn);
      });
      messagesEl.appendChild(quick);
    } else {
      history.forEach(m => {
        const div = document.createElement('div');
        div.className = `kc-msg kc-${m.role}`;
        if (m.role === 'assistant') {
          // Auto-link URLs et basic markdown bold (**X**)
          const safe = escapeHtml(m.content)
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/(https?:\/\/[^\s)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
          div.innerHTML = safe;
        } else {
          div.textContent = m.content;
        }
        messagesEl.appendChild(div);
      });
    }
    if (isTyping) {
      const t1 = document.createElement('div');
      t1.className = 'kc-typing';
      t1.innerHTML = '<span></span><span></span><span></span>';
      messagesEl.appendChild(t1);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ============================================================
  // INTERACTION
  // ============================================================
  function openPanel() {
    isOpen = true;
    panel.classList.add('kc-open');
    bubble.style.display = 'none';
    hint.classList.remove('kc-show');
    renderMessages();
    setTimeout(() => inputEl.focus(), 200);
  }
  function closePanel() {
    isOpen = false;
    panel.classList.remove('kc-open');
    bubble.style.display = 'flex';
  }

  bubble.addEventListener('click', openPanel);
  closeBtn.addEventListener('click', closePanel);

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(inputEl.value);
    }
  });
  sendBtn.addEventListener('click', () => sendMessage(inputEl.value));

  // Hint apparait apres 8s sur la 1ere visite (jamais ouvert le chat)
  if (!localStorage.getItem('kairos_chat_hint_shown')) {
    setTimeout(() => {
      if (!isOpen) {
        hint.classList.add('kc-show');
        try { localStorage.setItem('kairos_chat_hint_shown', '1'); } catch {}
        setTimeout(() => hint.classList.remove('kc-show'), 8000);
      }
    }, 8000);
  }

  async function sendMessage(text) {
    text = String(text || '').trim();
    if (!text || isTyping) return;
    history.push({ role: 'user', content: text });
    saveHistory(history);
    inputEl.value = '';
    inputEl.style.height = 'auto';
    isTyping = true;
    renderMessages();
    try {
      const resp = await fetch(`${API_BASE}/api/chatbot/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          messages: history.slice(-12),  // 12 derniers msgs pour le contexte
          lang,
          page: location.pathname,
          referrer: document.referrer || null,
        }),
      });
      const data = await resp.json();
      isTyping = false;
      if (resp.ok && data.reply) {
        history.push({ role: 'assistant', content: data.reply });
        saveHistory(history);
      } else {
        history.push({ role: 'assistant', content: data.error || t.errorMsg });
      }
    } catch (e) {
      isTyping = false;
      history.push({ role: 'assistant', content: t.errorMsg });
    }
    renderMessages();
  }

  // Auto-resize textarea
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(80, inputEl.scrollHeight) + 'px';
  });
})();
