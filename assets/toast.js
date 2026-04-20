/* ============================================================
 * Kairos Insider — Toast notifications
 * ============================================================
 * Usage :
 *   Toast.success('Message enregistré');
 *   Toast.error('Erreur de connexion');
 *   Toast.info('Nouveau signal détecté');
 *   Toast.warning('Action irréversible');
 *
 * Options : { duration: 4000, action: { label: 'Annuler', onClick: () => ... } }
 * Remplacement drop-in de alert() : Toast.show(msg)
 * ============================================================ */
(function () {
  'use strict';

  const CONTAINER_ID = 'kairos-toast-container';
  const DEFAULT_DURATION = 4000;

  // Injecte les styles une seule fois
  function injectStyles() {
    if (document.getElementById('kairos-toast-styles')) return;
    const style = document.createElement('style');
    style.id = 'kairos-toast-styles';
    style.textContent = `
      #${CONTAINER_ID} {
        position: fixed;
        top: 20px; right: 20px;
        display: flex; flex-direction: column; gap: 10px;
        z-index: 99998;
        pointer-events: none;
        max-width: 420px;
      }
      .kairos-toast {
        pointer-events: auto;
        background: #111827;
        color: #F1F5F9;
        border: 1px solid rgba(255,255,255,0.12);
        border-left: 4px solid #3B82F6;
        border-radius: 10px;
        padding: 12px 16px;
        box-shadow: 0 12px 32px rgba(0,0,0,0.45);
        font-family: -apple-system, 'Inter', Segoe UI, Roboto, sans-serif;
        font-size: 13px; line-height: 1.5;
        display: flex; align-items: flex-start; gap: 12px;
        min-width: 280px; max-width: 420px;
        transform: translateX(120%);
        opacity: 0;
        transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s;
      }
      .kairos-toast.show { transform: translateX(0); opacity: 1; }
      .kairos-toast.hide { transform: translateX(120%); opacity: 0; }
      .kairos-toast-icon {
        font-size: 18px; line-height: 1; flex-shrink: 0; margin-top: 1px;
      }
      .kairos-toast-body { flex: 1; min-width: 0; }
      .kairos-toast-msg { word-break: break-word; }
      .kairos-toast-action {
        margin-top: 6px;
        background: transparent; border: none; padding: 0;
        color: #60A5FA; font: inherit; font-weight: 600; text-decoration: underline;
        cursor: pointer;
      }
      .kairos-toast-close {
        flex-shrink: 0;
        background: transparent; border: none; padding: 0;
        color: rgba(255,255,255,0.5); font-size: 18px; cursor: pointer;
        line-height: 1; margin-top: 1px;
      }
      .kairos-toast-close:hover { color: #fff; }
      .kairos-toast.success { border-left-color: #22C55E; }
      .kairos-toast.error { border-left-color: #EF4444; }
      .kairos-toast.warning { border-left-color: #F59E0B; }
      .kairos-toast.info { border-left-color: #3B82F6; }
      :root[data-theme="light"] .kairos-toast {
        background: #FFFFFF;
        color: #1F2937;
        border-color: rgba(0,0,0,0.08);
        box-shadow: 0 12px 32px rgba(0,0,0,0.15);
      }
      :root[data-theme="light"] .kairos-toast-close { color: rgba(0,0,0,0.4); }
      :root[data-theme="light"] .kairos-toast-close:hover { color: #000; }
      @media (max-width: 520px) {
        #${CONTAINER_ID} { left: 10px; right: 10px; top: 10px; max-width: none; }
        .kairos-toast { min-width: 0; }
      }
    `;
    document.head.appendChild(style);
  }

  function ensureContainer() {
    let c = document.getElementById(CONTAINER_ID);
    if (!c) {
      c = document.createElement('div');
      c.id = CONTAINER_ID;
      c.setAttribute('role', 'region');
      c.setAttribute('aria-live', 'polite');
      c.setAttribute('aria-label', 'Notifications');
      document.body.appendChild(c);
    }
    return c;
  }

  const ICONS = {
    success: '✅',
    error: '❌',
    warning: '⚠️',
    info: 'ℹ️',
  };

  function show(message, type, opts) {
    injectStyles();
    const container = ensureContainer();
    opts = opts || {};
    type = type || 'info';

    const toast = document.createElement('div');
    toast.className = 'kairos-toast ' + type;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');

    const icon = document.createElement('span');
    icon.className = 'kairos-toast-icon';
    icon.textContent = ICONS[type] || ICONS.info;

    const body = document.createElement('div');
    body.className = 'kairos-toast-body';
    const msgEl = document.createElement('div');
    msgEl.className = 'kairos-toast-msg';
    msgEl.textContent = String(message || ''); // textContent = XSS safe
    body.appendChild(msgEl);

    if (opts.action && typeof opts.action.onClick === 'function') {
      const btn = document.createElement('button');
      btn.className = 'kairos-toast-action';
      btn.type = 'button';
      btn.textContent = opts.action.label || 'Annuler';
      btn.addEventListener('click', function () {
        try { opts.action.onClick(); } catch (e) { console.error(e); }
        hide();
      });
      body.appendChild(btn);
    }

    const closeBtn = document.createElement('button');
    closeBtn.className = 'kairos-toast-close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Fermer');
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', hide);

    toast.appendChild(icon);
    toast.appendChild(body);
    toast.appendChild(closeBtn);
    container.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => {
      requestAnimationFrame(() => toast.classList.add('show'));
    });

    let timeoutId = null;
    function hide() {
      if (timeoutId) clearTimeout(timeoutId);
      toast.classList.add('hide');
      toast.classList.remove('show');
      setTimeout(() => { toast.remove(); }, 320);
    }

    const duration = opts.duration != null ? opts.duration : DEFAULT_DURATION;
    if (duration > 0) {
      timeoutId = setTimeout(hide, duration);
    }

    return { hide };
  }

  window.Toast = {
    show: (msg, opts) => show(msg, 'info', opts),
    info: (msg, opts) => show(msg, 'info', opts),
    success: (msg, opts) => show(msg, 'success', opts),
    error: (msg, opts) => show(msg, 'error', opts || { duration: 6000 }),
    warning: (msg, opts) => show(msg, 'warning', opts),
  };
})();
