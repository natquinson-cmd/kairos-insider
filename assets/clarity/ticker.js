/* Kairos signal strip. Local demonstration; no requests or persistent changes. */
(() => {
  'use strict';

  function mount(host, { items = [], onSelect = () => {}, labels = {} } = {}) {
    const copy = {region:'Le fil Kairos, signaux de démonstration',title:'Le fil Kairos',demo:'Démo',empty:'Aucun signal dans cette démonstration.',manual:'Manuel',resume:'▶ Reprendre',pause:'Ⅱ Pause',manualLabel:'Défilement manuel : réduction des animations activée',resumeLabel:'Reprendre le défilement du fil Kairos',pauseLabel:'Mettre le fil Kairos en pause',manualHint:'Les animations sont désactivées selon vos préférences. Faites défiler le fil horizontalement.',resumeHint:'Reprendre le défilement',pauseHint:'Mettre en pause pour parcourir les signaux',...labels};
    if (!(host instanceof HTMLElement)) throw new TypeError('KairosTicker.mount attend un élément HTML.');
    const signals = items.slice(0, 6);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let paused = false;
    let keyboardMode = false;
    let pointerFocus = false;
    let destroyed = false;

    const el = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const root = el('section', 'kairos-ticker');
    root.setAttribute('aria-label', copy.region);
    const heading = el('div', 'kairos-ticker__heading');
    const title = el('strong', '', copy.title);
    const demo = el('span', 'kairos-ticker__demo', copy.demo);
    heading.append(title, demo);
    const viewport = el('div', 'kairos-ticker__viewport');
    const track = el('div', 'kairos-ticker__track');
    const primary = el('div', 'kairos-ticker__group');
    const mirror = el('div', 'kairos-ticker__group kairos-ticker__mirror');
    mirror.setAttribute('aria-hidden', 'true');
    mirror.setAttribute('inert', '');
    const clones = [];

    const createItem = (item, duplicate) => {
      const tone = ['buy', 'sell', 'fund'].includes(item.tone) ? item.tone : 'fund';
      const card = el(duplicate ? 'span' : 'button', `kairos-ticker__item kairos-ticker__item--${tone}`);
      card.title = [item.company, item.ticker, item.label, item.detail].filter(Boolean).join(' · ');
      if (!duplicate) {
        card.type = 'button';
        card.setAttribute('aria-label', [item.company, item.ticker, item.label, item.detail].filter(Boolean).join(', '));
        card.addEventListener('click', () => onSelect(item));
      }
      const signal = el('span', 'kairos-ticker__signal');
      signal.setAttribute('aria-hidden', 'true');
      signal.textContent = tone === 'buy' ? '+' : tone === 'sell' ? '−' : '◈';
      const copy = el('span', 'kairos-ticker__copy');
      const first = el('span', 'kairos-ticker__first');
      first.append(el('strong', '', item.ticker || ''), el('span', 'kairos-ticker__label', item.label || ''));
      const second = el('span', 'kairos-ticker__second');
      second.textContent = [item.company, item.detail].filter(Boolean).join(' · ');
      copy.append(first, second);
      card.append(signal, copy);
      return card;
    };

    signals.forEach(item => {
      primary.append(createItem(item, false));
      const clone = createItem(item, true);
      clones.push({ node: clone, item });
      mirror.append(clone);
    });
    if (!signals.length) primary.append(el('span', 'kairos-ticker__empty', copy.empty));
    track.append(primary, mirror);
    viewport.append(track);
    const toggle = el('button', 'kairos-ticker__toggle');
    toggle.type = 'button';
    root.append(heading, viewport, toggle);
    host.replaceChildren(root);

    function sync() {
      const manual = reducedMotion.matches || paused || keyboardMode || !signals.length;
      root.classList.toggle('kairos-ticker--manual', manual);
      root.classList.toggle('kairos-ticker--keyboard', keyboardMode);
      toggle.setAttribute('aria-pressed', String(paused || reducedMotion.matches));
      toggle.disabled = reducedMotion.matches || !signals.length;
      toggle.textContent = reducedMotion.matches ? copy.manual : paused ? copy.resume : copy.pause;
      toggle.setAttribute('aria-label', reducedMotion.matches
        ? copy.manualLabel
        : paused ? copy.resumeLabel : copy.pauseLabel);
      toggle.title = reducedMotion.matches
        ? copy.manualHint
        : paused ? copy.resumeHint : copy.pauseHint;
      if (!manual) viewport.scrollLeft = 0;
    }

    const onToggle = () => { paused = !paused; sync(); };
    const onPointerDown = () => { pointerFocus = true; };
    const onKeyDown = event => {
      pointerFocus = false;
      if (event.key === 'Escape') {
        toggle.focus();
        keyboardMode = false;
        sync();
      }
    };
    const onFocusIn = event => {
      // Keyboard readers get the original, stationary list and its full labels.
      // A mouse click keeps the currently hovered signal under the pointer.
      if (pointerFocus) { pointerFocus = false; return; }
      if (event.target.closest('.kairos-ticker__item')) {
        keyboardMode = true;
        sync();
        const bounds = viewport.getBoundingClientRect();
        const itemBounds = event.target.getBoundingClientRect();
        if (itemBounds.left < bounds.left) viewport.scrollLeft -= bounds.left - itemBounds.left + 8;
        if (itemBounds.right > bounds.right) viewport.scrollLeft += itemBounds.right - bounds.right + 8;
      }
    };
    const onFocusOut = event => {
      if (!primary.contains(event.relatedTarget)) {
        keyboardMode = false;
        sync();
      }
    };
    const onMirrorClick = event => {
      // The repeated group is inert: no duplicate controls or reading order.
      // Pointer clicks on its visible copy select the corresponding real item.
      if (event.target !== viewport && event.target !== track) return;
      for (const { node, item } of clones) {
        const rect = node.getBoundingClientRect();
        if (event.clientX >= rect.left && event.clientX <= rect.right &&
            event.clientY >= rect.top && event.clientY <= rect.bottom) {
          onSelect(item);
          break;
        }
      }
    };
    toggle.addEventListener('click', onToggle);
    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('keydown', onKeyDown);
    root.addEventListener('focusin', onFocusIn);
    root.addEventListener('focusout', onFocusOut);
    viewport.addEventListener('click', onMirrorClick);
    reducedMotion.addEventListener('change', sync);
    sync();

    return {
      pause() { paused = true; sync(); },
      resume() { paused = false; sync(); },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        reducedMotion.removeEventListener('change', sync);
        root.remove();
      }
    };
  }

  window.KairosTicker = Object.freeze({ mount });
})();
