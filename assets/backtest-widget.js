/**
 * Kairos Backtest Widget — module reutilisable monte sur n'importe quel container.
 *
 * Usage :
 *   <div id="myBacktest"></div>
 *   <script src="/assets/backtest-widget.js"></script>
 *   <script>
 *     KairosBacktest.mount(document.getElementById('myBacktest'), {
 *       defaultFiler: 'BERKSHIRE',
 *       defaultPeriod: '10y',
 *       defaultCapital: 5000,
 *       autoRun: true,
 *       showTrustFooter: true,    // false sur la landing pour eviter doublon
 *       showHeader: true,         // h1 + subtitle (false en embed)
 *     });
 *   </script>
 *
 * API :
 *   - KairosBacktest.mount(root, opts) : monte le widget dans `root`
 *   - KairosBacktest.unmount(root) : nettoie
 *
 * Le widget s'auto-encapsule : injecte ses styles une seule fois (id 'kairos-backtest-styles')
 * et utilise des requetes DOM scopees au root (pas d'ID globaux).
 */
(function() {
  'use strict';

  if (window.KairosBacktest) return;  // deja monte

  const API = 'https://kairos-insider-api.natquinson.workers.dev/api';

  // Tag emoji selon categorie (legend, activist, institutional, hedgefund, family, state)
  const TAG_EMOJI = {
    legend: '⭐', activist: '⚡', institutional: '🏦',
    hedgefund: '💰', family: '👑', state: '🏛️',
  };

  const PERIOD_LABELS = { '1y': '1 an', '3y': '3 ans', '5y': '5 ans', '10y': '10 ans', '20y': '20 ans' };

  // Inject styles once
  function injectStyles() {
    if (document.getElementById('kairos-backtest-styles')) return;
    const style = document.createElement('style');
    style.id = 'kairos-backtest-styles';
    style.textContent = `
      .kbt-form {
        background: var(--surface, #131829);
        border: 1px solid var(--border, #2A3149);
        border-radius: 14px;
        padding: 20px 24px;
        margin-bottom: 24px;
      }
      .kbt-row { display: flex; gap: 14px; align-items: end; flex-wrap: wrap; }
      .kbt-row > div { flex: 1; min-width: 180px; }
      .kbt-row label {
        display: block; font-size: 12px; font-weight: 600;
        text-transform: uppercase; letter-spacing: 0.5px;
        color: var(--text-secondary, #94A3B8); margin-bottom: 6px;
      }
      .kbt-row select, .kbt-row input[type=number] {
        width: 100%; padding: 12px 14px;
        background: var(--surface-2, #1A2138);
        border: 1px solid var(--border-strong, #3A4366);
        border-radius: 8px;
        color: var(--text-primary, #F1F5F9);
        font-size: 15px; font-family: inherit; outline: none;
      }
      .kbt-row select:focus, .kbt-row input:focus {
        border-color: var(--accent, #3B82F6);
      }
      .kbt-btn {
        padding: 12px 28px;
        background: linear-gradient(135deg, #3B82F6 0%, #8B5CF6 100%);
        color: #fff; border: none; border-radius: 10px;
        font-size: 15px; font-weight: 700;
        font-family: inherit; cursor: pointer; white-space: nowrap;
        box-shadow: 0 4px 14px rgba(59,130,246,0.4), 0 0 0 1px rgba(255,255,255,0.1) inset;
        transition: transform 0.15s, box-shadow 0.15s, filter 0.15s;
      }
      .kbt-btn:hover {
        transform: translateY(-1px);
        box-shadow: 0 8px 24px rgba(59,130,246,0.55), 0 0 0 1px rgba(255,255,255,0.18) inset;
        filter: brightness(1.08);
      }
      .kbt-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
      .kbt-capital {
        margin-top: 18px; padding-top: 18px;
        border-top: 1px solid var(--border, #2A3149);
      }
      .kbt-capital label {
        display: block; font-size: 12px; font-weight: 600;
        text-transform: uppercase; letter-spacing: 0.5px;
        color: var(--text-secondary, #94A3B8); margin-bottom: 10px;
      }
      .kbt-capital-display {
        color: #3B82F6; font-size: 16px; font-weight: 800; text-transform: none;
      }
      .kbt-slider {
        width: 100%; height: 6px; border-radius: 3px;
        background: var(--surface-2, #1A2138); outline: none;
        -webkit-appearance: none; appearance: none; cursor: pointer;
      }
      .kbt-slider::-webkit-slider-thumb {
        -webkit-appearance: none; appearance: none;
        width: 18px; height: 18px; border-radius: 50%;
        background: linear-gradient(135deg, #3B82F6, #8B5CF6);
        cursor: pointer; border: 2px solid #fff;
        box-shadow: 0 2px 8px rgba(59,130,246,0.5);
      }
      .kbt-slider-marks {
        display: flex; justify-content: space-between;
        font-size: 11px; color: var(--text-muted, #64748B); margin-top: 6px;
      }
      .kbt-loading, .kbt-empty {
        text-align: center; padding: 48px;
        color: var(--text-secondary, #94A3B8);
      }
    `;
    document.head.appendChild(style);
  }

  function fmtPct(n) {
    if (n == null || isNaN(n)) return '—';
    const sign = n > 0 ? '+' : '';
    return sign + n.toFixed(1) + '%';
  }

  function fmtEur(n) {
    return Math.round(n).toLocaleString('fr-FR') + ' €';
  }

  // SVG equity curve: fund + S&P 500 with pills
  function renderEquityCurveDual(curve, fundLabel) {
    if (!curve || curve.length < 2) return '';
    const W = 900, H = 320, padL = 60, padR = 100, padT = 30, padB = 50;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    const valsFund = curve.map(p => p.totalReturnPct);
    const valsBench = curve.map(p => p.benchmarkReturnPct).filter(v => v != null);
    const allVals = [...valsFund, ...valsBench];
    const minVal = Math.min(0, ...allVals);
    const maxVal = Math.max(0, ...allVals);
    const range = (maxVal - minVal) || 1;
    const scaleY = v => padT + innerH - ((v - minVal) / range) * innerH;
    const scaleX = i => padL + (i / (curve.length - 1)) * innerW;

    const fundPath = curve.map((p, i) => `${i === 0 ? 'M' : 'L'}${scaleX(i).toFixed(1)} ${scaleY(p.totalReturnPct).toFixed(1)}`).join(' ');
    const fundArea = fundPath + ` L${scaleX(curve.length-1).toFixed(1)} ${scaleY(0).toFixed(1)} L${scaleX(0).toFixed(1)} ${scaleY(0).toFixed(1)} Z`;
    const benchPath = curve.filter(p => p.benchmarkReturnPct != null)
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${scaleX(curve.indexOf(p)).toFixed(1)} ${scaleY(p.benchmarkReturnPct).toFixed(1)}`).join(' ');

    const zeroY = scaleY(0).toFixed(1);
    const finalFund = valsFund[valsFund.length - 1];
    const finalBench = valsBench.length ? valsBench[valsBench.length - 1] : null;
    const fundColor = finalFund > 0 ? '#10B981' : '#EF4444';
    const benchColor = '#94A3B8';

    const yTicks = [];
    const yStep = Math.max(10, Math.ceil(range / 5 / 10) * 10);
    for (let v = Math.ceil(minVal / yStep) * yStep; v <= maxVal; v += yStep) {
      yTicks.push({ y: scaleY(v), label: (v > 0 ? '+' : '') + v.toFixed(0) + '%' });
    }
    const xTickCount = 5;
    const xTicks = [];
    for (let i = 0; i < xTickCount; i++) {
      const idx = Math.floor((i / (xTickCount - 1)) * (curve.length - 1));
      xTicks.push({ x: scaleX(idx), label: curve[idx].date.slice(0, 7) });
    }

    // Generate unique gradient id (avoid clashes when several widgets on same page)
    const gradId = 'kbtGrad_' + Math.random().toString(36).slice(2, 8);

    return `
      <div style="background:var(--surface,#131829);border:1px solid var(--border,#2A3149);border-radius:14px;padding:24px;margin-bottom:24px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:14px">
          <h3 style="margin:0;font-size:18px">📈 ${fundLabel} vs S&P 500</h3>
          <div style="display:flex;gap:18px;font-size:13px">
            <span style="display:inline-flex;align-items:center;gap:6px"><span style="display:inline-block;width:14px;height:3px;background:${fundColor};border-radius:2px"></span>${fundLabel}</span>
            <span style="display:inline-flex;align-items:center;gap:6px"><span style="display:inline-block;width:14px;height:3px;background:${benchColor};border-radius:2px"></span>S&P 500</span>
          </div>
        </div>
        <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">
          <defs>
            <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="${fundColor}" stop-opacity="0.3"/>
              <stop offset="100%" stop-color="${fundColor}" stop-opacity="0"/>
            </linearGradient>
          </defs>
          ${yTicks.map(t => `<line x1="${padL}" x2="${W-padR}" y1="${t.y.toFixed(1)}" y2="${t.y.toFixed(1)}" stroke="#1A2138" stroke-width="1" />`).join('')}
          <line x1="${padL}" x2="${W-padR}" y1="${zeroY}" y2="${zeroY}" stroke="#3A4366" stroke-width="1" stroke-dasharray="3,3" />
          ${yTicks.map(t => `<text x="${padL-8}" y="${t.y+4}" text-anchor="end" font-size="11" fill="#64748B">${t.label}</text>`).join('')}
          ${xTicks.map(t => `<text x="${t.x}" y="${H-padB+22}" text-anchor="middle" font-size="11" fill="#64748B">${t.label}</text>`).join('')}
          <path d="${fundArea}" fill="url(#${gradId})" stroke="none" />
          ${benchPath ? `<path d="${benchPath}" stroke="${benchColor}" stroke-width="2" fill="none" stroke-dasharray="4,3" opacity="0.7" />` : ''}
          <path d="${fundPath}" stroke="${fundColor}" stroke-width="3" fill="none" />
          <circle cx="${scaleX(curve.length-1).toFixed(1)}" cy="${scaleY(finalFund).toFixed(1)}" r="6" fill="${fundColor}" stroke="#0B0F1A" stroke-width="2" />
          ${(() => {
            const cx = scaleX(curve.length - 1);
            const cy = scaleY(finalFund);
            const txt = fmtPct(finalFund);
            const pillW = Math.max(58, txt.length * 9.5 + 12);
            const pillX = cx + 10;
            const pillY = cy - 14;
            return `
              <rect x="${pillX.toFixed(1)}" y="${pillY.toFixed(1)}" width="${pillW.toFixed(1)}" height="28" rx="14" ry="14" fill="${fundColor}" />
              <text x="${(pillX + pillW/2).toFixed(1)}" y="${(pillY + 19).toFixed(1)}" text-anchor="middle" font-size="15" font-weight="800" fill="#0B0F1A">${txt}</text>`;
          })()}
          ${finalBench != null ? (() => {
            const cx = scaleX(curve.length - 1);
            const cy = scaleY(finalBench);
            const txt = fmtPct(finalBench);
            const pillW = Math.max(54, txt.length * 8.5 + 12);
            const pillX = cx + 10;
            const pillY = cy - 12;
            return `
              <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5" fill="${benchColor}" stroke="#0B0F1A" stroke-width="2" opacity="0.9" />
              <rect x="${pillX.toFixed(1)}" y="${pillY.toFixed(1)}" width="${pillW.toFixed(1)}" height="24" rx="12" ry="12" fill="#1A2138" stroke="${benchColor}" stroke-width="1" />
              <text x="${(pillX + pillW/2).toFixed(1)}" y="${(pillY + 16).toFixed(1)}" text-anchor="middle" font-size="13" font-weight="700" fill="${benchColor}">${txt}</text>`;
          })() : ''}
        </svg>
      </div>`;
  }

  function renderBestCalls(bc, filerLabel) {
    if (!bc || !Array.isArray(bc.calls) || bc.calls.length === 0) return '';
    const cards = bc.calls.map((call, idx) => {
      const isPositive = (call.returnPct || 0) >= 0;
      const color = isPositive ? '#10B981' : '#EF4444';
      const sign = isPositive ? '+' : '';
      const rankBadge = ['🥇', '🥈', '🥉', '4', '5'][idx] || (idx + 1);
      return `
        <div style="background:var(--surface,#131829);border:1px solid var(--border,#2A3149);border-radius:14px;padding:18px;display:flex;flex-direction:column;gap:8px;transition:transform 0.15s,border-color 0.15s" onmouseover="this.style.transform='translateY(-2px)';this.style.borderColor='var(--border-strong,#3A4366)'" onmouseout="this.style.transform='';this.style.borderColor='var(--border,#2A3149)'">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
            <div style="display:flex;align-items:center;gap:8px">
              <div style="font-size:18px">${rankBadge}</div>
              <div>
                <div style="font-weight:800;font-size:15px;color:var(--text-primary,#F1F5F9)">${call.name}</div>
                <div style="font-size:11px;color:var(--text-muted,#64748B);font-family:monospace;letter-spacing:0.4px">${call.ticker} · entrée ${call.entryDate}</div>
              </div>
            </div>
            <div style="font-size:22px;font-weight:900;color:${color};letter-spacing:-0.5px">${sign}${call.returnPct}%</div>
          </div>
          <p style="margin:0;font-size:13px;color:var(--text-secondary,#94A3B8);line-height:1.5">${call.story}</p>
        </div>`;
    }).join('');

    return `
      <div style="margin-top:32px">
        <div style="background:linear-gradient(135deg,rgba(251,191,36,0.10),rgba(59,130,246,0.06));border:1px solid rgba(251,191,36,0.25);border-radius:18px;padding:24px 28px;margin-bottom:20px;text-align:center">
          <div style="font-size:11px;color:#FBBF24;text-transform:uppercase;letter-spacing:1.5px;font-weight:700;margin-bottom:10px">Philosophie d'investissement</div>
          <div style="font-size:18px;font-style:italic;color:var(--text-primary,#F1F5F9);line-height:1.5;max-width:720px;margin:0 auto">${bc.quote}</div>
          ${bc.aum ? `<div style="margin-top:10px;display:inline-block;padding:4px 12px;background:rgba(59,130,246,0.15);color:#3B82F6;border:1px solid rgba(59,130,246,0.3);border-radius:12px;font-size:11px;font-weight:700;letter-spacing:0.5px">${bc.aum}</div>` : ''}
        </div>
        <div style="margin-bottom:14px">
          <h3 style="margin:0;font-size:22px;font-weight:800;letter-spacing:-0.3px">${bc.callsLabel || "Trades qui ont marqué l'histoire"}</h3>
          <p style="margin:6px 0 0;color:var(--text-secondary,#94A3B8);font-size:14px">Détectés <strong style="color:var(--text-primary,#F1F5F9)">avant la masse</strong> par ${filerLabel}. Sources : 13F SEC, lettres aux actionnaires, presse financière.</p>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px">${cards}</div>
      </div>`;
  }

  function renderTrustFooter(filerLabel) {
    return `
      <div style="margin-top:48px;background:linear-gradient(135deg,rgba(59,130,246,0.12),rgba(139,92,246,0.10));border:1px solid rgba(139,92,246,0.3);border-radius:20px;padding:32px;text-align:center">
        <div style="font-size:11px;color:#3B82F6;text-transform:uppercase;letter-spacing:1.5px;font-weight:700;margin-bottom:12px">Vous voulez les prochains coups ?</div>
        <h3 style="margin:0 0 8px;font-size:26px;font-weight:800;letter-spacing:-0.3px">Suivez ${filerLabel} en temps réel</h3>
        <p style="margin:0 auto 24px;color:var(--text-secondary,#94A3B8);max-width:560px;line-height:1.6">
          Kairos Insider trace <strong style="color:var(--text-primary,#F1F5F9)">tous les filings SEC, AMF, FCA, BaFin, AFM, SIX</strong> dès leur publication.
          Reçoit une alerte email <strong style="color:var(--text-primary,#F1F5F9)">avant que la presse ne couvre la news</strong>.
        </p>
        <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
          <a href="/dashboard.html?action=signup" style="display:inline-flex;align-items:center;gap:8px;padding:14px 28px;background:linear-gradient(135deg,#3B82F6 0%,#8B5CF6 100%);color:white;text-decoration:none;border-radius:12px;font-weight:700;font-size:15px;box-shadow:0 4px 14px rgba(59,130,246,0.4),0 0 0 1px rgba(255,255,255,0.1) inset;transition:transform 0.15s,filter 0.15s" onmouseover="this.style.transform='translateY(-1px)';this.style.filter='brightness(1.08)'" onmouseout="this.style.transform='';this.style.filter=''">
            Créer mon compte gratuit
          </a>
          <a href="/" style="display:inline-flex;align-items:center;gap:8px;padding:14px 28px;background:transparent;color:var(--text-primary,#F1F5F9);text-decoration:none;border-radius:12px;font-weight:600;font-size:15px;border:1px solid var(--border-strong,#3A4366)">
            En savoir plus
          </a>
        </div>
        <div style="margin-top:18px;font-size:12px;color:var(--text-muted,#64748B);display:flex;gap:18px;justify-content:center;flex-wrap:wrap">
          <span>✓ Aucune CB requise</span>
          <span>✓ Données régulateurs officiels</span>
          <span>✓ 12 marchés couverts</span>
        </div>
      </div>`;
  }

  function renderResults(state) {
    const { data, capitalEl, resultsEl, opts } = state;
    const s = data.summary || {};
    const c = data.comparison || {};
    const filerLabel = data.metadata?.filerLabel || data.filer;

    if (s.totalPositions === 0 && !s.avgReturn) {
      resultsEl.innerHTML = `
        <div class="kbt-empty">
          <h3 style="color:#94A3B8">${filerLabel}</h3>
          <p>Aucune donnée disponible pour ce fonds sur la période ${data.period}.</p>
        </div>`;
      return;
    }

    const capital = parseInt(capitalEl.value, 10) || 5000;
    const finalCapital = capital * (1 + (s.avgReturn || 0) / 100);
    const gainAbsolu = finalCapital - capital;
    const benchFinal = capital * (1 + (c.benchmarkReturn || 0) / 100);
    const alphaEur = finalCapital - benchFinal;
    const fundColor = gainAbsolu >= 0 ? '#10B981' : '#EF4444';
    const periodLabel = PERIOD_LABELS[data.period] || data.period;

    const html = `
      <div style="background:linear-gradient(135deg,rgba(59,130,246,0.15),rgba(139,92,246,0.12));border:1px solid rgba(139,92,246,0.3);border-radius:18px;padding:32px;margin-bottom:24px;text-align:center">
        <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-secondary,#94A3B8);margin-bottom:6px">Avec ${fmtEur(capital)} investis dans ${filerLabel} il y a ${periodLabel}</div>
        <div style="font-size:14px;color:var(--text-muted,#64748B);margin-bottom:18px">Vous auriez aujourd'hui</div>
        <div style="font-size:64px;font-weight:900;color:${fundColor};line-height:1;letter-spacing:-1.5px">${fmtEur(finalCapital)}</div>
        <div style="margin-top:14px;font-size:18px;font-weight:700;color:${fundColor}">
          ${gainAbsolu >= 0 ? '+' : ''}${fmtEur(gainAbsolu)} de gain
          <span style="font-size:14px;color:var(--text-secondary,#94A3B8);font-weight:500;margin-left:8px">(${fmtPct(s.avgReturn)} sur ${periodLabel})</span>
        </div>
        ${c.benchmarkReturn != null ? `
          <div style="margin-top:6px;font-size:13px;color:${alphaEur >= 0 ? '#10B981' : '#EF4444'}">
            Soit ${alphaEur >= 0 ? '+' : ''}${fmtEur(alphaEur)} de plus que le S&P 500
          </div>` : ''}
      </div>
      ${renderEquityCurveDual(data.equityCurve || [], filerLabel)}
      ${opts.showBestCalls !== false ? renderBestCalls(data.bestCalls, filerLabel) : ''}
      ${opts.showTrustFooter !== false ? renderTrustFooter(filerLabel) : ''}
    `;
    resultsEl.innerHTML = html;
  }

  async function loadFilers(state) {
    const { filerEl } = state;
    try {
      const r = await fetch(`${API}/backtest/list`);
      const data = await r.json();
      if (!data.filers) throw new Error('Liste vide');
      filerEl.innerHTML = '<option value="">Choisir un fonds...</option>' +
        data.filers.map(f => {
          const emoji = TAG_EMOJI[f.tag] || '🔹';
          return `<option value="${f.key}">${emoji} ${f.label} (${f.country})</option>`;
        }).join('');

      // Pre-select default filer
      if (state.opts.defaultFiler) {
        const found = Array.from(filerEl.options).find(o => o.value === state.opts.defaultFiler);
        if (found) filerEl.value = state.opts.defaultFiler;
      }

      // Hash override (filer=X dans URL)
      const hashMatch = window.location.hash.match(/filer=([^&]+)/);
      if (hashMatch) {
        const filerFromHash = decodeURIComponent(hashMatch[1]).toUpperCase();
        const found = Array.from(filerEl.options).find(o => o.value === filerFromHash);
        if (found) {
          filerEl.value = filerFromHash;
          state.opts.autoRun = true;
        }
      }

      // Auto-run si demande
      if (state.opts.autoRun && filerEl.value) {
        setTimeout(() => runBacktest(state), 200);
      }
    } catch (e) {
      filerEl.innerHTML = '<option value="">Erreur de chargement</option>';
      console.error(e);
    }
  }

  async function runBacktest(state) {
    const { filerEl, periodEl, btnEl, resultsEl } = state;
    const filer = filerEl.value;
    if (!filer) { alert('Sélectionne un fonds'); return; }
    const period = periodEl.value;
    btnEl.disabled = true;
    const originalText = btnEl.textContent;
    btnEl.textContent = '⏳ Calcul en cours...';
    resultsEl.innerHTML = '<div class="kbt-loading">📊 Récupération des positions et des cours historiques (10-30 sec)…</div>';
    try {
      const r = await fetch(`${API}/backtest/${encodeURIComponent(filer)}?period=${period}`);
      const data = await r.json();
      if (data.error) {
        resultsEl.innerHTML = `<div class="kbt-empty">❌ Erreur : ${data.error}</div>`;
        return;
      }
      state.data = data;
      renderResults(state);
    } catch (e) {
      resultsEl.innerHTML = `<div class="kbt-empty">❌ Erreur : ${e.message}</div>`;
    } finally {
      btnEl.disabled = false;
      btnEl.textContent = originalText;
    }
  }

  function mount(root, opts = {}) {
    if (!root) throw new Error('KairosBacktest.mount: root element requis');
    injectStyles();

    const defaultPeriod = opts.defaultPeriod || '3y';
    const defaultCapital = opts.defaultCapital || 5000;

    root.innerHTML = `
      <div class="kbt-form">
        <div class="kbt-row">
          <div>
            <label>Fonds smart money</label>
            <select class="kbt-filer"><option>Chargement...</option></select>
          </div>
          <div>
            <label>Période</label>
            <select class="kbt-period">
              <option value="1y" ${defaultPeriod==='1y'?'selected':''}>1 an</option>
              <option value="3y" ${defaultPeriod==='3y'?'selected':''}>3 ans</option>
              <option value="5y" ${defaultPeriod==='5y'?'selected':''}>5 ans</option>
              <option value="10y" ${defaultPeriod==='10y'?'selected':''}>10 ans</option>
              <option value="20y" ${defaultPeriod==='20y'?'selected':''}>20 ans</option>
            </select>
          </div>
          <button class="kbt-btn kbt-run">▶ Lancer le backtest</button>
        </div>
        <div class="kbt-capital">
          <label>Patrimoine de départ : <span class="kbt-capital-display">${defaultCapital.toLocaleString('fr-FR')} €</span></label>
          <input type="range" class="kbt-slider" min="5000" max="100000" step="1000" value="${defaultCapital}" />
          <div class="kbt-slider-marks"><span>5 000 €</span><span>50 000 €</span><span>100 000 €</span></div>
        </div>
      </div>
      <div class="kbt-results"></div>
    `;

    const state = {
      root,
      opts,
      filerEl: root.querySelector('.kbt-filer'),
      periodEl: root.querySelector('.kbt-period'),
      btnEl: root.querySelector('.kbt-run'),
      capitalEl: root.querySelector('.kbt-slider'),
      capitalDisplay: root.querySelector('.kbt-capital-display'),
      resultsEl: root.querySelector('.kbt-results'),
      data: null,
    };

    // Live update du display patrimoine + re-render results si data dispo
    state.capitalEl.addEventListener('input', () => {
      state.capitalDisplay.textContent = parseInt(state.capitalEl.value).toLocaleString('fr-FR') + ' €';
      if (state.data) renderResults(state);
    });

    // Re-run quand on change le filer ou la période (UX live)
    state.btnEl.addEventListener('click', () => runBacktest(state));
    state.periodEl.addEventListener('change', () => { if (state.filerEl.value) runBacktest(state); });
    state.filerEl.addEventListener('change', () => { if (state.filerEl.value) runBacktest(state); });

    loadFilers(state);

    return state;
  }

  window.KairosBacktest = { mount };
})();
