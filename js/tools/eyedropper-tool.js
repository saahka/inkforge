/**
 * Пипетка. Берёт цвет из итогового изображения (с учётом видимости,
 * прозрачности и режимов наложения всех слоёв).
 *
 * Alt+клик по кисти временно переключает её на пипетку —
 * так удобнее всего выбирать цвет из уже нарисованного.
 *
 * Важно: цвет под курсором НЕ читается из экранного canvas на каждом кадре.
 * Он кэшируется в app.hoverColor и обновляется только при движении мыши —
 * иначе мы делали бы getImageData() 60 раз в секунду.
 */

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
      app.hoverColor = app.sampleComposite(c.x, c.y);
      pick(c.x, c.y, c.alt ? 'bg' : this.settings.target);
    },

    onPointerMove(c) {
      app.renderer.cursor = { x: c.x, y: c.y };
      app.hoverColor = app.sampleComposite(c.x, c.y);
      if (sampling) pick(c.x, c.y, c.alt ? 'bg' : this.settings.target);
    },

    onPointerUp() { sampling = false; },
    onPointerCancel() { sampling = false; },
    onDeactivate() { sampling = false; },

    /** Превью цвета под курсором — рисуем кэш, без чтения пикселей */
    drawOverlay(ctx, renderer) {
      const px = app.hoverColor;
      if (!px || !renderer.cursor) return;
      const p = renderer.viewport.worldToScreen(renderer.cursor.x, renderer.cursor.y);
      ctx.save();
      ctx.fillStyle = `rgba(${px.r},${px.g},${px.b},${Math.max(0.15, px.a)})`;
      ctx.strokeStyle = 'rgba(0,0,0,.7)';
      ctx.lineWidth = 1;
      ctx.fillRect(p.x + 10, p.y + 10, 18, 18);
      ctx.strokeRect(p.x + 10.5, p.y + 10.5, 18, 18);
      ctx.restore();
    },
  };
}