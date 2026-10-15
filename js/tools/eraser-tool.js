/**
 * Ластик. Рисует по слою режимом destination-out — то есть стирает
 * до прозрачности (как «кисть по маске»).
 * Настройки живут отдельно от кисти (app.eraserBrush).
 */

import { toStrokePoint } from './brush-tool.js';
import { dynamicSize } from '../core/brush.js';

export function eraserTool(app) {
  let drawing = false;

  return {
    id: 'eraser',
    cursor: 'crosshair',
    label: 'Ластик',

    onPointerDown(c) {
      const layer = app.doc.activeLayer;
      if (!layer) return;
      if (layer.locked) {
        app.emit('toast', { text: 'Слой заблокирован', kind: 'error' });
        return;
      }
      if (layer.alphaLocked) {
        app.emit('toast', { text: 'Прозрачность слоя заблокирована', kind: 'error' });
        return;
      }
      drawing = app.beginStroke(toStrokePoint(c), { composite: 'destination-out', tool: 'eraser' });
    },

    onPointerMove(c) {
      app.renderer.cursor = { x: c.x, y: c.y };
      if (drawing) app.extendStroke(c.points.map(toStrokePoint));
    },

    onPointerUp() {
      if (!drawing) return;
      drawing = false;
      app.commitStroke('Ластик');
    },

    onPointerCancel() {
      if (!drawing) return;
      drawing = false;
      app.cancelStroke();
    },

    drawOverlay(ctx, renderer) {
      const brush = app.eraserBrush;
      const size = dynamicSize(brush, { pressure: 1 });
      renderer.drawBrushCursor(ctx, size / 2);
      if (app.stroke.active && app.stroke.prediction) {
        renderer.drawPrediction(ctx, app.stroke.prediction, brush);
      }
    },

    onDeactivate() {
      if (drawing) { drawing = false; app.commitStroke('Ластик'); }
    },
  };
}