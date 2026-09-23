/* Kairos's eight-axis signature. Axis geometry always uses raw 0–100 scores. */
(() => {
  'use strict';

  const defaultLabels = ['Dirigeants', 'Hedge funds', 'Politiciens et gourous', 'Momentum du cours', 'Valorisation', 'Consensus analystes', 'Santé financière', 'Momentum des résultats'];
  const shortLabels = ['Initiés', 'Hedge funds', 'Politiciens', 'Cours', 'Valorisation', 'Analystes', 'Santé', 'Résultats'];
  const colors = ['#79a5ff', '#56dce9', '#ba9aff', '#9893ff', '#f4c77d', '#65dcce', '#7ce0b4', '#acb9ff'];
  const identities = new WeakMap();
  const gaugeCleanups = new WeakMap();
  let sequence = 0;
  const escape = value => String(value).replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
  const number = value => Number(value.toFixed(2));
  const frenchNumber = value => value.toLocaleString('fr-FR', {maximumFractionDigits: 1});
  const validNumber = value => typeof value === 'number' && Number.isFinite(value);

  // Same thresholds, colors and descriptive labels as the current Kairos radar.
  function scoreQuality(value) {
    if (!validNumber(value)) return { key: 'unavailable', main: '#7e91ad', light: '#b7c5d9', glow: 'rgba(126,145,173,0.2)', label: 'Score indisponible' };
    if (value >= 75) return { key: 'very-favorable', main: '#10B981', light: '#6EE7B7', glow: 'rgba(16,185,129,0.35)', label: 'Signal très favorable' };
    if (value >= 60) return { key: 'favorable', main: '#3B82F6', light: '#93C5FD', glow: 'rgba(59,130,246,0.35)', label: 'Signal favorable' };
    if (value >= 40) return { key: 'mixed', main: '#8B5CF6', light: '#C4B5FD', glow: 'rgba(139,92,246,0.30)', label: 'Signal mitigé' };
    if (value >= 25) return { key: 'unfavorable', main: '#F59E0B', light: '#FCD34D', glow: 'rgba(245,158,11,0.30)', label: 'Signal défavorable' };
    return { key: 'very-unfavorable', main: '#EF4444', light: '#FCA5A5', glow: 'rgba(239,68,68,0.30)', label: 'Signal très défavorable' };
  }

  /**
   * render(host, {values, labels?, score?, weights?})
   * host: an element with an explicit CSS height and a measurable width.
   * values/labels/weights follow the eight Kairos dimensions in their usual order.
   * score is displayed as supplied. If omitted, valid weights summing to 100
   * calculate the center score. Weights NEVER affect polygon geometry.
   * The caller may rerender after a size/data change; no observer is installed.
   */
  function render(host, options = {}) {
    if (!host || typeof host.getBoundingClientRect !== 'function') return null;
    const width = Math.round(host.clientWidth);
    const height = Math.round(host.clientHeight);
    if (width < 160 || height < 180) return null;
    gaugeCleanups.get(host)?.();
    const values = Array.from({length: 8}, (_, index) => {
      const value = options.values?.[index];
      return validNumber(value) ? Math.min(100, Math.max(0, value)) : null;
    });
    const labels = defaultLabels.map((label, index) => String(options.labels?.[index] || label));
    const weights = Array.from({length: 8}, (_, index) => options.weights?.[index]);
    const validWeights = weights.every(weight => validNumber(weight) && weight >= 0 && weight <= 100) && Math.abs(weights.reduce((sum, weight) => sum + weight, 0) - 100) < .001;
    const calculatedScore = validWeights && values.every(value => value !== null) ? values.reduce((sum, value, index) => sum + value * weights[index] / 100, 0) : null;
    const suppliedScore = validNumber(options.score) ? Math.min(100, Math.max(0, options.score)) : calculatedScore;
    const score = suppliedScore === null ? '—' : Math.round(suppliedScore);
    const quality = scoreQuality(score === '—' ? null : score);
    if (!identities.has(host)) identities.set(host, `kr-${++sequence}`);
    const id = identities.get(host);
    const cx = width / 2;
    const cy = height / 2 - 1;
    const radius = Math.min(width * .29, (height - 80) / 2);
    const centerRadius = Math.min(32, radius * .37);
    const gaugeWidth = Math.min(78, Math.max(58, width / 3));
    const gaugeLeft = Math.min(width - gaugeWidth - 5, cx + centerRadius + 9);
    const gaugeTop = Math.max(5, Math.min(height - 169, cy - 79));
    const fontSize = Math.min(11.5, Math.max(10, width / 28));
    const scoreSize = Math.min(44, Math.max(31, radius * .51)) * (String(score).length > 2 ? .82 : 1);
    const point = (index, proportion = 1) => {
      const angle = index * Math.PI / 4 - Math.PI / 2;
      return [number(cx + Math.cos(angle) * radius * proportion), number(cy + Math.sin(angle) * radius * proportion)];
    };
    const polygonAt = proportion => values.map((_, index) => point(index, proportion).join(',')).join(' ');
    const dataPoints = values.map((value, index) => point(index, (value ?? 0) / 100));
    const polygon = dataPoints.map(point => point.join(',')).join(' ');
    const descriptions = labels.map((label, index) => `${label} : ${values[index] === null ? 'donnée indisponible' : frenchNumber(values[index]) + ' sur 100'}${validWeights ? ', poids ' + frenchNumber(weights[index]) + ' % dans le score global' : ''}`);

    const definitions = colors.map((color, index) => {
      const current = point(index);
      const next = point((index + 1) % 8);
      return `<linearGradient id="${id}-wedge-${index}" gradientUnits="userSpaceOnUse" x1="${cx}" y1="${cy}" x2="${current[0]}" y2="${current[1]}"><stop stop-color="${color}" stop-opacity=".06"/><stop offset="1" stop-color="${color}" stop-opacity=".41"/></linearGradient><linearGradient id="${id}-edge-${index}" gradientUnits="userSpaceOnUse" x1="${current[0]}" y1="${current[1]}" x2="${next[0]}" y2="${next[1]}"><stop stop-color="${color}"/><stop offset="1" stop-color="${colors[(index + 1) % 8]}"/></linearGradient>`;
    }).join('');

    host.innerHTML = `<div class="kr-radar" data-score-quality="${quality.key}" style="--kr-label-size:${fontSize}px;--kr-score-size:${scoreSize}px;--kr-score-main:${quality.main};--kr-score-light:${quality.light};--kr-score-glow:${quality.glow}">
      <svg class="kr-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="group" aria-label="Le radar Kairos : ${score === '—' ? 'score indisponible' : score + ' sur 100, ' + quality.label}" aria-describedby="${id}-description">
        <desc id="${id}-description">Huit dimensions sur une échelle commune de zéro à cent. ${descriptions.map(escape).join('. ')}. La pondération du score global ne modifie pas la forme du radar.</desc>
        <defs>${definitions}<radialGradient id="${id}-ambient"><stop stop-color="#517cde" stop-opacity=".12"/><stop offset="1" stop-color="#517cde" stop-opacity="0"/></radialGradient><filter id="${id}-soft" x="-25%" y="-25%" width="150%" height="150%"><feGaussianBlur stdDeviation="3"/></filter></defs>
        <circle cx="${cx}" cy="${cy}" r="${radius * 1.23}" fill="url(#${id}-ambient)" aria-hidden="true"/>
        <g aria-hidden="true">
          ${[.25, .5, .75, 1].map(proportion => `<polygon points="${polygonAt(proportion)}" class="kr-grid ${proportion === 1 ? 'kr-grid-outer' : ''}"/>`).join('')}
          ${values.map((_, index) => { const end = point(index); return `<line x1="${cx}" y1="${cy}" x2="${end[0]}" y2="${end[1]}" class="kr-spoke"/>`; }).join('')}
          ${values.map((value, index) => value === null || values[(index + 1) % 8] === null ? '' : `<path d="M${cx} ${cy} L${dataPoints[index].join(' ')} L${dataPoints[(index + 1) % 8].join(' ')} Z" fill="url(#${id}-wedge-${index})"/>`).join('')}
          <polygon points="${polygon}" fill="none" stroke="#739efb" stroke-width="5" opacity=".22" filter="url(#${id}-soft)"/>
          ${values.map((value, index) => value === null || values[(index + 1) % 8] === null ? '' : `<path d="M${dataPoints[index].join(' ')} L${dataPoints[(index + 1) % 8].join(' ')}" fill="none" stroke="url(#${id}-edge-${index})" stroke-width="2.4" stroke-linecap="round"/>`).join('')}
        </g>
        ${values.map((value, index) => {
          const location = dataPoints[index];
          const label = point(index, 1.27);
          const isKnownLabel = labels[index] === defaultLabels[index];
          const short = isKnownLabel ? shortLabels[index] : labels[index].length > 13 ? labels[index].slice(0, 12) + '…' : labels[index];
          return `<g class="kr-axis" tabindex="0" role="img" aria-label="${escape(descriptions[index])}" data-kr-axis="${index}" style="--kr-axis-color:${colors[index]}">
            ${value === null ? '' : `<circle class="kr-axis-target" cx="${location[0]}" cy="${location[1]}" r="12"/><circle class="kr-axis-focus" cx="${location[0]}" cy="${location[1]}" r="8"/><circle class="kr-axis-dot" cx="${location[0]}" cy="${location[1]}" r="3.7"/>`}
            <text class="kr-label" x="${label[0]}" y="${label[1] + fontSize * .33}" text-anchor="middle">${escape(short)}</text>
          </g>`;
        }).join('')}
        <g class="kr-score-group" tabindex="0" role="button" aria-expanded="false" aria-controls="${id}-gauge" aria-disabled="${suppliedScore === null}" aria-label="${score === '—' ? 'Score Kairos indisponible' : 'Score Kairos : ' + score + ' sur 100, ' + quality.label + '. Afficher le niveau du score.'}"><circle cx="${cx}" cy="${cy}" r="${centerRadius + 3}" class="kr-score-ring"/><circle cx="${cx}" cy="${cy}" r="${centerRadius}" class="kr-center"/><text class="kr-score" x="${cx}" y="${cy + 5}" text-anchor="middle">${score}</text><text class="kr-denominator" x="${cx}" y="${cy + 20}" text-anchor="middle">/100</text></g>
        <text class="kr-scale-note kr-quality-label" x="${cx}" y="${height - 8}" text-anchor="middle" aria-hidden="true">${quality.label}</text>
      </svg>
      <div id="${id}-tooltip" class="kr-tooltip" role="tooltip" hidden></div>
      <div id="${id}-gauge" class="kr-gauge" role="tooltip" style="left:${gaugeLeft}px;top:${gaugeTop}px;width:${gaugeWidth}px;--kr-gauge-level:${score === '—' ? 0 : score}%" hidden>
        <span class="kr-gauge-caption">Score</span><strong class="kr-gauge-value">${score}<span>/100</span></strong>
        <div class="kr-gauge-scale" role="meter" aria-label="Niveau du score Kairos" aria-valuemin="0" aria-valuemax="100" ${score === '—' ? '' : `aria-valuenow="${score}" aria-valuetext="${score} sur 100, ${quality.label}"`}>
          <div class="kr-gauge-track" aria-hidden="true"><span class="kr-gauge-fill"></span></div><span class="kr-gauge-marker" aria-hidden="true"></span>
          ${[0, 25, 40, 60, 75, 100].map(level => `<span class="kr-gauge-tick" style="bottom:${level}%" aria-hidden="true">${level}</span>`).join('')}
        </div>
      </div>
    </div>`;

    const tooltip = host.querySelector('.kr-tooltip');
    const root = host.querySelector('.kr-radar');
    const scoreControl = host.querySelector('.kr-score-group');
    const gauge = host.querySelector('.kr-gauge');
    const ownerDocument = host.ownerDocument;
    let focusedIndex = null;
    let hoveredIndex = null;
    let scoreHovered = false;
    let scoreFocused = false;
    let gaugePinned = false;
    let gaugeDismissed = false;

    // The public rendering API is unchanged; this gauge is a local view of the same score.
    function updateGauge() {
      const visible = suppliedScore !== null && !gaugeDismissed && (scoreHovered || scoreFocused || gaugePinned);
      gauge.hidden = !visible;
      scoreControl.setAttribute('aria-expanded', String(visible));
      root.classList.toggle('kr-gauge-open', visible);
      if (visible) ownerDocument?.addEventListener('keydown', onGaugeEscape);
      else ownerDocument?.removeEventListener('keydown', onGaugeEscape);
      if (visible) {
        focusedIndex = null;
        hoveredIndex = null;
        tooltip.hidden = true;
        root.classList.remove('kr-has-tooltip');
      }
    }
    function dismissGauge() {
      gaugePinned = false;
      gaugeDismissed = true;
      updateGauge();
    }
    function onGaugeEscape(event) {
      if (event.key === 'Escape') { event.preventDefault(); dismissGauge(); }
    }
    gaugeCleanups.set(host, () => {
      ownerDocument?.removeEventListener('keydown', onGaugeEscape);
      gauge.hidden = true;
    });
    function toggleGauge() {
      if (gaugePinned) dismissGauge();
      else { gaugePinned = true; gaugeDismissed = false; updateGauge(); }
    }
    scoreControl.addEventListener('pointerenter', () => { scoreHovered = true; gaugeDismissed = false; updateGauge(); });
    scoreControl.addEventListener('pointerleave', () => { scoreHovered = false; updateGauge(); });
    scoreControl.addEventListener('focus', () => { scoreFocused = true; gaugeDismissed = false; updateGauge(); });
    scoreControl.addEventListener('blur', () => { scoreFocused = false; updateGauge(); });
    scoreControl.addEventListener('click', toggleGauge);
    scoreControl.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleGauge(); }
      if (event.key === 'Escape') { event.preventDefault(); dismissGauge(); }
    });
    function updateTooltip() {
      const index = hoveredIndex ?? focusedIndex;
      tooltip.hidden = index === null;
      root.classList.toggle('kr-has-tooltip', index !== null);
      if (index === null) return;
      // An axis inspection takes precedence over a previously pinned global gauge.
      scoreHovered = false;
      scoreFocused = false;
      gaugePinned = false;
      gaugeDismissed = true;
      updateGauge();
      tooltip.innerHTML = `<span class="kr-tooltip-label">${escape(labels[index])}</span><strong style="color:${colors[index]}">${values[index] === null ? 'Indisponible' : frenchNumber(values[index]) + '<span> /100</span>'}</strong>${validWeights ? `<small>Poids dans le score : ${frenchNumber(weights[index])} %</small>` : ''}`;
    }
    host.querySelectorAll('[data-kr-axis]').forEach(axis => {
      const index = Number(axis.dataset.krAxis);
      axis.addEventListener('pointerenter', () => { hoveredIndex = index; updateTooltip(); });
      axis.addEventListener('pointerleave', () => { hoveredIndex = null; updateTooltip(); });
      axis.addEventListener('focus', () => { focusedIndex = index; updateTooltip(); });
      axis.addEventListener('blur', () => { focusedIndex = null; updateTooltip(); });
      axis.addEventListener('keydown', event => {
        if (event.key === 'Escape') { hoveredIndex = null; focusedIndex = null; updateTooltip(); }
        if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) {
          event.preventDefault();
          const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
          host.querySelector(`[data-kr-axis="${(index + direction + 8) % 8}"]`).focus();
        }
      });
    });
    return {svg: host.querySelector('svg'), score: suppliedScore, values: [...values]};
  }

  window.KairosRadar = Object.freeze({render, scoreQuality});
})();
