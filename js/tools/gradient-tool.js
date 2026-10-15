/**
 * Градиент: линейный (перетаскивание) и радиальный (Shift).
 * Заливка всегда происходит внутри текущего выделения.
 */

import { PixelCommand } from '../core/history.js';

export function gradientTool(app) {
  let start = null;
  let end = null;

  const buildGradient = (ctx, x0, y0, x1, y1, radial) => {
    const g = radial
      ? ctx.createRadialGradient(x0, y0, 0, x0, y0, Math.max(1, Math.hypot(x1 - x0, y1 - y0)))
      : ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, app.fgHex);
    g.addColorStop(1, app.bgHex);
    return g;
  };

  return {
    id: 'gradient',
    cursor: 'crosshair',
    label: 'Градиент',

    settings: { radial: false, reverse: false },

    onPointerDown(c) {
      start = { x: c.x, y: c.y };
      end = { ...start };
    },

    onPointerMove(c) {
      app.renderer.cursor = { x: c.x, y: c.y };
      if (!start) return;
      // Shift — привязка к 45° и радиальный режим
      if (c.shift) {
        const dx = c.x - start.x;
        const dy = c.y - start.y;
        const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(dx, dy);
        end = { x: start.x + Math.cos(angle) * len, y: start.y + Math.sin(angle) * len };
      } else {
        end = { x: c.x, y: c.y };
      }
    },

    onPointerUp() {
      if (!start || !end) return;
      const region = app.selection.clipRect();
      const layer = app.doc.activeLayer;
      if (!layer) return;

      const radial = this.settings.radial;
      const s = this.settings.reverse ? end : start;
      const e = this.settings.reverse ? start : end;

      if (Math.abs(e.x - s.x) < 0.5 && Math.abs(e.y - s.y) < 0.5) {
        start = end = null;
        return;
      }

      const cmd = new PixelCommand(layer, region, 'Градиент');
      const ctx = layer.ctx;
      ctx.save();
      try {
        if (app.selection.active) app.selection.clipContext(ctx);
        ctx.beginPath();
        ctx.rect(region.x, region.y, region.w, region.h);
        ctx.clip();
        ctx.fillStyle = buildGradient(ctx, s.x, s.y, e.x, e.y, radial);
        ctx.fillRect(region.x, region.y, region.w, region.h);
      } finally {
        ctx.restore();
      }
      layer.markDirty(region);

      app.history.execute(cmd.capture());
      app.renderer.addDirty(region);
      app.markChanged();
      start = end = null;
    },

    onPointerCancel() { start = end = null; },

    drawOverlay(ctx, renderer) {
      if (!start || !end) return;
      const vp = renderer.viewport;
      const a = vp.worldToScreen(start.x, start.y);
      const b = vp.worldToScreen(end.x, end.y);
      const grad = this.settings.radial
        ? ctx.createRadialGradient(a.x, a.y, 0, a.x, a.y, Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)))
        : ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      grad.addColorStop(0, app.fgHex);
      grad.addColorStop(1, app.bgHex);

      ctx.save();
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      for (const p of [a, b]) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.strokeStyle = '#fff';
        ctx.strokeStyle = 'rgba(0,0,0,.6)';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.restore();
    },

    onDeactivate() { start = end = null; },
  };
}