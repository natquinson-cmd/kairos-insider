/* Chart.js extension restricted to the company price chart. */
(function () {
  if (!window.Chart) return;
  const relevant = chart => chart.canvas?.id === 'stockPriceChart';
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  Chart.register({
    id: 'kairosCoreNavigation',
    afterInit(chart) {
      if (!relevant(chart)) return;
      chart.options.plugins.tooltip.mode = 'nearest';
      chart.options.plugins.tooltip.intersect = true;
      chart.options.plugins.tooltip.filter = item => !!item.dataset._meta?.[item.dataIndex];
      chart.options.hover.mode = 'nearest'; chart.options.hover.intersect = true;
      const canvas = chart.canvas;
      chart.$coreWheel = event => {
        const rect = canvas.getBoundingClientRect(), area = chart.chartArea;
        const x = (event.clientX - rect.left) * chart.width / rect.width;
        const y = (event.clientY - rect.top) * chart.height / rect.height;
        if (!area || x < area.left || x > area.right || y < area.top || y > area.bottom) return;
        event.preventDefault();
        const count = chart.data.labels?.length || 0;
        if (count < 3) return;
        const oldMin = Number(chart.scales.x.min), oldMax = Number(chart.scales.x.max);
        const oldSpan = oldMax - oldMin;
        const span = clamp(Math.round(oldSpan * (event.deltaY > 0 ? 1.22 : .82)), Math.min(5, count - 1), count - 1);
        const ratio = clamp((x - area.left) / (area.right - area.left), 0, 1);
        const min = clamp(Math.round(oldMin + oldSpan * ratio - span * ratio), 0, count - 1 - span);
        chart.options.scales.x.min = min; chart.options.scales.x.max = min + span;
        chart.$corePoint = null; chart.update('none');
        document.querySelectorAll('#chartPeriodSelector button').forEach(button => button.classList.remove('active'));
        const reset = document.getElementById('core-chart-reset'); if (reset) reset.hidden = false;
      };
      canvas.addEventListener('wheel', chart.$coreWheel, { passive:false });
      let reset = document.getElementById('core-chart-reset');
      if (!reset) {
        reset = document.createElement('button'); reset.id = 'core-chart-reset'; reset.type = 'button'; reset.className = 'chart-range-btn';
        document.getElementById('chartPeriodSelector')?.after(reset);
      }
      const en = window.KairosI18n?.getLang() === 'en';
      reset.textContent = en ? 'Reset zoom' : 'Réinitialiser le zoom'; reset.hidden = true;
      reset.onclick = () => {
        delete chart.options.scales.x.min; delete chart.options.scales.x.max;
        chart.update('none'); reset.hidden = true;
      };
    },
    afterEvent(chart, args) {
      if (!relevant(chart)) return;
      const e = args.event, area = chart.chartArea;
      chart.$corePoint = e.type !== 'mouseout' && e.x >= area.left && e.x <= area.right && e.y >= area.top && e.y <= area.bottom ? { x:e.x, y:e.y } : null;
      args.changed = true;
    },
    afterDraw(chart) {
      if (!relevant(chart) || !chart.$corePoint) return;
      const {x,y} = chart.$corePoint, area = chart.chartArea, ctx = chart.ctx;
      const index = clamp(Math.round(chart.scales.x.getValueForPixel(x)), 0, chart.data.labels.length - 1);
      const label = chart.data.labels[index];
      const en = window.KairosI18n?.getLang() === 'en';
      const date = new Date(label);
      const dateText = Number.isNaN(+date) ? String(label) : date.toLocaleDateString(en ? 'en-US' : 'fr-FR', {day:'numeric',month:'short',year:'2-digit'});
      const value = chart.scales.y.getValueForPixel(y);
      const priceText = value.toLocaleString(en ? 'en-US' : 'fr-FR', {maximumFractionDigits:2});
      ctx.save(); ctx.strokeStyle = '#8dabc0'; ctx.lineWidth = 1; ctx.setLineDash([4,4]);
      ctx.beginPath(); ctx.moveTo(x,area.top); ctx.lineTo(x,area.bottom); ctx.moveTo(area.left,y); ctx.lineTo(area.right,y); ctx.stroke();
      ctx.setLineDash([]); ctx.font = '11px Inter, sans-serif';
      function badge(text, bx, by) {
        const width = ctx.measureText(text).width + 14;
        bx = clamp(bx, 0, chart.width - width); by = clamp(by, 0, chart.height - 22);
        ctx.fillStyle = '#365379'; ctx.fillRect(bx,by,width,22); ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(text,bx+7,by+11);
      }
      badge(dateText,x - ctx.measureText(dateText).width / 2,area.bottom+2);
      badge(priceText,chart.scales.y.position === 'left' ? 0 : area.right+2,y-11);
      ctx.restore();
    },
    afterDestroy(chart) { if (chart.$coreWheel) chart.canvas?.removeEventListener('wheel', chart.$coreWheel); },
  });
})();
