/**
 * Пипетка. Берёт цвет из итогового изображения (с учётом видимости,
 * прозрачности и режимов наложения всех слоёв).
 *
 * Alt+клик по кистью временно переключает её на пипетку —
 * так удобнее всего выбирать цвет из уже нарисованного.
 */

import { toStrokePoint } from './brush-tool.js';

export function eyedropperTool(app) {
  let sampling = false;

  const pick = (x, y, target) => {
    const px = app.sampleComposite(x, y);
    if (!px) return;
    if (px.a < 0.02) {
      app.setColor({ r: 0, g: 0, b: 0 }, target);
      return;
    }
    // Пипетка возвращает цвет с учётом альфы (как в Photoshop)
    app.setColor({
      r: Math.round(px.r / px.a),
      g: Math.round(px.g / px.a),
      b: Math.round(px.b / px.a),
    }, target);
  };

  return {
    id: 'eyedropper',
    cursor: 'crosshair',
    label: 'Пипетка',

    settings: { target: 'fg', sampleAllLayers: true },

    onPointerDown(c) {
      sampling = true;
      pick(c.x, c.y, c.alt ? 'bg' : this.settings.target);
    },

    onPointerMove(c) {
      app.renderer.cursor = { x: c.x, y: c.y };
      if (!sampling) {
        // При Alt показываем цвет под курсором в подсказке панели
        const px = app.sampleComposite(c.x, c.y);
        app.emit('hoverColor', px);
        return;
      }
      pick(c.x, c.y, c.alt ? 'bg' : this.settings.target);
    },

    onPointerUp() { sampling = false; },
    onPointerCancel() { sampling = false; },

    /** Превью цвета под курсором (маленький квадрат) */
    drawOverlay(ctx, renderer) {
      if (!renderer.cursor) return;
      const px = app.sampleComposite(renderer.cursor.x, renderer.cursor.y);
      if (!px) return;
      const p = renderer.viewport.worldToScreen(renderer.cursor.x, renderer.cursor.y);
      ctx.save();
      ctx.fillStyle = `rgb(${px.r},${px.g},${px.b})`;
      ctx.strokeStyle = 'rgba(0,0,0,.7)';
      ctx.lineWidth = 1;
      ctx.fillRect(p.x + 10, p.y + 10, 18, 18);
      ctx.strokeRect(p.x + 10.5, p.y + 10.5, 18, 18);
      ctx.restore();
    },

    onDeactivate() { sampling = false; },
  };
}

/** Утилита для горячих клавиш: пипетка с Alt работает поверх кисти */
export const altEyedropperEnabled = () => typeof PointerEvent !== 'undefined';

export { toStrokePoint };