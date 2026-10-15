/**
 * Прямоугольное выделение (marquee).
 * Shift — добавить к выделению, Alt — вычесть (Фаза 2 уточнит поведение),
 * двойной клик — выделить весь слой, Ctrl+A — весь документ.
 */

import { rectFromPoints } from '../utils/math.js';

export function marqueeTool(app) {
  let start = null;
  let current = null;

  const rect = () => (start && current ? rectFromPoints(start.x, start.y, current.x, current.y) : null);

  return {
    id: 'marquee',
    cursor: 'crosshair',
    label: 'Выделение',

    settings: { feather: 0 },

    onPointerDown(c) {
      start = { x: c.x, y: c.y };
      current = { ...start };
    },

    onPointerMove(c) {
      app.renderer.cursor = { x: c.x, y: c.y };
      if (!start) return;
      if (c.shift) { current.x = start.x; current.y = c.y; }        // только по вертикали
      else if (c.alt) { current.y = start.y; current.x = c.x; }     // только по горизонтали
      else current = { x: c.x, y: c.y };
    },

    onPointerUp() {
      const r = rect();
      start = current = null;
      if (!r || r.w < 2 || r.h < 2) {
        // Клик без протяжки снимает выделение (Shift удерживает его)
        if (!shiftHeld) app.selection.clear();
        return;
      }
      app.selection.setRect(r);
      if (this.settings.feather > 0) app.selection.feather(this.settings.feather);
    },

    onDoubleClick() {
      app.selection.selectAll();
    },

    drawOverlay(ctx, renderer) {
      if (!start || !current) return;
      const vp = renderer.viewport;
      const a = vp.worldToScreen(start.x, start.y);
      const b = vp.worldToScreen(current.x, current.y);
      ctx.save();
      ctx.strokeStyle = 'rgba(0,0,0,.75)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(Math.min(a.x, b.x)) + 0.5, Math.round(Math.min(a.y, b.y)) + 0.5,
        Math.round(Math.abs(b.x - a.x)), Math.round(Math.abs(b.y - a.y)));
      ctx.restore();
    },

    onDeactivate() { start = current = null; },
  };
}

// Состояние клавиши Shift: InputHandler сообщает о нём один раз за нажатие
let shiftHeld = false;
export const setShiftHeld = (v) => { shiftHeld = v; };