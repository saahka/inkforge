/**
 * Кисть. Преобразует события указателя в штрих через StrokeEngine.
 *
 * Поддерживается всё, что нужно для графического планшета:
 *  • Pointer Events (работает и с мышью, и с пером);
 *  • getCoalescedEvents() — все промежуточные точки, а не одна на кадр;
 *  • pressure (давление), tiltX/tiltY (наклон), pointerType;
 *  • setPointerCapture — штрих не теряется при выходе за пределы холста.
 */

import { clamp, dist } from '../utils/math.js';
import { dynamicSize } from '../core/brush.js';

/** Точка в мировых координатах с параметрами пера */
export function toStrokePoint(src) {
  const tilt = clamp(
    Math.hypot(src.tiltX || 0, src.tiltY || 0) / 90,
    0, 1,
  );
  // У мыши давление всегда 0.5 — приводим к полному, иначе штрих вырождается
  const pressure = src.pointerType === 'mouse'
    ? 1
    : clamp(src.pressure || 0, 0.02, 1);

  return {
    x: src.x,
    y: src.y,
    pressure,
    tilt,
    t: src.timeStamp,
    pointerType: src.pointerType,
  };
}

export function brushTool(app) {
  let drawing = false;

  return {
    id: 'brush',
    cursor: 'crosshair',
    label: 'Кисть',

    onPointerDown(c) {
      if (!app.doc.activeLayer) return;
      if (app.doc.activeLayer.locked) {
        app.emit('toast', { text: 'Слой заблокирован', kind: 'error' });
        return;
      }
      drawing = app.beginStroke(toStrokePoint(c), { composite: 'source-over', tool: 'brush' });
    },

    onPointerMove(c) {
      app.renderer.cursor = { x: c.x, y: c.y };
      if (!drawing) return;
      // c.points — все точки кадра (coalesced), рисуем каждую
      app.extendStroke(c.points.map(toStrokePoint));
    },

    onPointerUp() {
      if (!drawing) return;
      drawing = false;
      app.commitStroke('Кисть');
    },

    onPointerCancel() {
      if (!drawing) return;
      drawing = false;
      app.cancelStroke();
    },

    drawOverlay(ctx, renderer) {
      const brush = app.brush;
      // Кольцо показывает размер при текущем давлении, если динамика включена
      const size = dynamicSize(brush, {
        pressure: renderer.cursorPressure ?? 1,
        tilt: renderer.cursorTilt ?? 0,
      });
      renderer.drawBrushCursor(ctx, size / 2);

      // «Призрак» предсказанного продолжения штриха
      if (app.stroke.active && app.stroke.prediction) {
        renderer.drawPrediction(ctx, app.stroke.prediction, brush);
      }
    },

    onDeactivate() {
      if (drawing) { drawing = false; app.commitStroke('Кисть'); }
    },
  };
}

/** Расстояние между двумя мировыми точками — используется инструментом Move */
export const pointDistance = (a, b) => dist(a.x, a.y, b.x, b.y);