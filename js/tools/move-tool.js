/**
 * Перемещение содержимого.
 *  • без выделения — двигает весь активный слой;
 *  • с выделением — двигает только пиксели внутри выделения,
 *    и само выделение едет вместе с содержимым;
 *  • Ctrl+тяга — копирует содержимое вместо перемещения.
 *
 * Отмена реализована одной командой: снимок области возвращается
 * на исходное место, а область назначения очищается.
 */

import { intersectRect, unionRect } from '../utils/math.js';
import { createLayerCanvas } from '../core/layer.js';

export function moveTool(app) {
  /** Состояние перетаскивания (в замыкании, а не в this) */
  const S = {
    dragging: false,
    origin: null,
    sourceRect: null,   // откуда берём пиксели
    affected: null,     // что очищать при перерисовке
    snapshot: null,     // ImageData источника
    scratch: null,      // переиспользуемый canvas
    moved: false,
    duplicate: false,
    dx: 0,
    dy: 0,
  };

  const MAX_PIXELS = 64 * 1024 * 1024;   // предохранитель памяти

  const reset = () => {
    S.dragging = false;
    S.moved = false;
    S.snapshot = null;
    S.sourceRect = null;
    S.affected = null;
    S.origin = null;
  };

  const ensureScratch = (w, h) => {
    if (!S.scratch || S.scratch.width !== w || S.scratch.height !== h) {
      S.scratch = createLayerCanvas(w, h);
    }
    return S.scratch;
  };

  const prepare = () => {
    const l = app.doc.activeLayer;
    if (!l) return false;
    const sel = app.selection.active ? app.selection.clipRect() : null;
    const base = sel || l.bounds;
    S.sourceRect = intersectRect(base, l.contentRect || l.bounds) || base;
    if (!S.sourceRect || S.sourceRect.w * S.sourceRect.h > MAX_PIXELS) return false;
    S.snapshot = l.ctx.getImageData(S.sourceRect.x, S.sourceRect.y, S.sourceRect.w, S.sourceRect.h);
    return true;
  };

  /** Область, которую нужно очистить перед отрисовкой снимка со смещением */
  const computeAffected = () => {
    const l = app.doc.activeLayer;
    const target = {
      x: S.sourceRect.x + S.dx,
      y: S.sourceRect.y + S.dy,
      w: S.sourceRect.w,
      h: S.sourceRect.h,
    };
    return intersectRect(S.duplicate ? unionRect(S.sourceRect, target) : S.sourceRect, l.bounds);
  };

  /** Очищает затронутую область и рисует снимок со смещением (ox, oy) */
  const blit = (ox, oy) => {
    const l = app.doc.activeLayer;
    if (!l || !S.snapshot) return;
    const tmp = ensureScratch(S.sourceRect.w, S.sourceRect.h);
    tmp.getContext('2d').putImageData(S.snapshot, 0, 0);

    const ctx = l.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(S.affected.x, S.affected.y, S.affected.w, S.affected.h);
    ctx.drawImage(tmp, S.sourceRect.x + ox, S.sourceRect.y + oy);
    ctx.restore();

    l.markDirty(S.affected);
    app.renderer.addDirty(S.affected);
  };

  const tool = {
    id: 'move',
    cursor: 'move',
    label: 'Перемещение',

    settings: { moveSelection: true },

    onPointerDown(c) {
      const l = app.doc.activeLayer;
      if (!l) return;
      if (l.locked) {
        app.emit('toast', { text: 'Слой заблокирован', kind: 'error' });
        return;
      }
      S.origin = { x: c.x, y: c.y };
      S.dragging = true;
      S.moved = false;
      S.duplicate = !!c.ctrl;
      S.snapshot = null;
    },

    onPointerMove(c) {
      app.renderer.cursor = { x: c.x, y: c.y };
      if (!S.dragging) return;

      S.dx = Math.round(c.x - S.origin.x);
      S.dy = Math.round(c.y - S.origin.y);
      if (!S.moved && Math.hypot(S.dx, S.dy) < 1) return;

      if (!S.snapshot && !prepare()) { reset(); return; }
      if (!S.affected) S.affected = computeAffected();

      S.moved = true;
      blit(S.dx, S.dy);
    },

    onPointerUp() {
      if (!S.dragging) return;
      if (!S.moved || !S.snapshot) { reset(); return; }

      const selBefore = app.selection.rect ? { ...app.selection.rect } : null;
      const selAfter = selBefore
        ? { ...selBefore, x: selBefore.x + S.dx, y: selBefore.y + S.dy }
        : null;
      const { dx, dy } = S;

      const command = {
        type: 'callback',
        label: 'Перемещение',
        bytes: 0,
        do() {
          S.dx = dx; S.dy = dy;
          S.affected = computeAffected();
          blit(dx, dy);
          if (tool.settings.moveSelection && selAfter) {
            app.selection.rect = { ...selAfter };
            app.selection.emit('change');
          }
        },
        undo() {
          S.dx = dx; S.dy = dy;
          S.affected = computeAffected();
          blit(0, 0);
          if (tool.settings.moveSelection && selBefore) {
            app.selection.rect = { ...selBefore };
            app.selection.emit('change');
          }
        },
      };

      // Команда выполняется один раз (do), но она идемпотентна:
      // перед отрисовкой всегда очищается затронутая область
      command.do();
      app.history.push(command);
      app.markChanged();
      reset();
    },

    onPointerCancel() { reset(); },
    drawOverlay() {},
    onDeactivate() { reset(); },
  };

  return tool;
}