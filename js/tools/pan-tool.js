/**
 * Панорамирование. Также работает по пробелу и средней кнопке мыши
 * (это обрабатывает InputHandler — здесь только сам инструмент).
 */

export function panTool(app) {
  let last = null;

  return {
    id: 'pan',
    cursor: 'grab',
    label: 'Панорамирование',

    onPointerDown(c) {
      last = { x: c.sx, y: c.sy };
      app.stage.dataset.cursor = 'grabbing';
    },

    onPointerMove(c) {
      if (!last) return;
      app.viewport.panBy(c.sx - last.x, c.sy - last.y);
      last = { x: c.sx, y: c.sy };
    },

    onPointerUp() {
      last = null;
      app.stage.dataset.cursor = 'grab';
    },

    onPointerCancel() {
      last = null;
      app.stage.dataset.cursor = 'grab';
    },

    drawOverlay() {},
    onDeactivate() { last = null; },
  };
}