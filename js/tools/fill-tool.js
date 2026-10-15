/**
 * Заливка (flood fill) и «волшебная палочка».
 *
 * Заливка работает по итоговому изображению (или по текущему слою),
 * но всегда пишет результат в активный слой и ограничивается выделением.
 */

import { floodFillMask, maskToImageData, maskCount } from '../core/flood-fill.js';
import { PixelCommand } from '../core/history.js';
import { createLayerCanvas } from '../core/layer.js';

export function fillTool(app) {
  return {
    id: 'fill',
    cursor: 'crosshair',
    label: 'Заливка',

    /** Настройки панели инструмента */
    settings: {
      tolerance: 32,
      sampleAllLayers: true,
      contiguous: true,
    },

    onPointerDown(c) {
      const { tolerance, sampleAllLayers, contiguous } = this.settings;
      const layer = app.doc.activeLayer;
      if (!layer) return;
      if (layer.locked) {
        app.emit('toast', { text: 'Слой заблокирован', kind: 'error' });
        return;
      }

      const region = app.selection.clipRect();
      const px = Math.floor(c.x) - region.x;
      const py = Math.floor(c.y) - region.y;
      if (px < 0 || py < 0 || px >= region.w || py >= region.h) return;

      // Источник цвета: весь «композит» или только активный слой
      let source;
      if (sampleAllLayers) {
        const flat = app.flattenCanvas();
        const fctx = flat.getContext('2d', { willReadFrequently: true });
        source = fctx.getImageData(region.x, region.y, region.w, region.h);
      } else {
        source = layer.getImageData(region);
      }

      const mask = floodFillMask(source, region.w, region.h, px, py, tolerance, { contiguous });
      const count = maskCount(mask);
      if (count === 0) return;

      // Shift — заливка фоновым цветом (как в Photoshop)
      const color = c.shift ? app.color.bg : app.color.fg;
      const patch = maskToImageData(mask, region.w, region.h, color);

      // Рисуем через временный canvas, чтобы работали клип и режим наложения
      const tmp = createLayerCanvas(region.w, region.h);
      tmp.getContext('2d').putImageData(patch, 0, 0);

      const cmd = new PixelCommand(layer, region, 'Заливка');
      const ctx = layer.ctx;
      ctx.save();
      try {
        if (app.selection.active) app.selection.clipContext(ctx);
        ctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(tmp, region.x, region.y);
      } finally {
        ctx.restore();
      }
      layer.markDirty(region);

      app.history.execute(cmd.capture());
      app.renderer.addDirty(region);
      app.markChanged();
    },

    onPointerMove(c) {
      app.renderer.cursor = { x: c.x, y: c.y };
    },

    drawOverlay() {},
  };
}