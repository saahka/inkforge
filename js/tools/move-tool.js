/**
 * Перемещение содержимого.
 *  • без выделения — двигает весь активный слой;
 *  • с выделением — двигает только пиксели внутри выделения,
 *    и само выделение едет вместе с содержимым;
 *  • Ctrl+тяга — копирует содержимое вместо перемещения.
 *
 * Отмена: история получает НЕИЗМЕНЯЕМЫЙ снимок операции (прямоугольник,
 * пиксели, смещение). Инструмент после `onPointerUp` своё состояние
 * обнуляет, поэтому держаться за него в команде нельзя — так отмена
 * падала бы с «Cannot read properties of null».
 */

import { intersectRect, unionRect } from '../utils/math.js';
import { createLayerCanvas } from '../core/layer.js';

export function moveTool(app) {
  /** Состояние перетаскивания (живёт только пока тянут мышью) */
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
  const computeAffected = (op) => {
    const l = app.doc.activeLayer;
    if (!l || !op.sourceRect) return null;
    const target = {
      x: op.sourceRect.x + op.dx, y: op.sourceRect.y + op.dy,
      w: op.sourceRect.w, h: op.sourceRect.h,
    };
    return intersectRect(
      op.duplicate ? unionRect(op.sourceRect, target) : op.sourceRect,
      l.bounds,
    );
  };

  /**
   * Очищает затронутую область и рисует снимок со смещением (ox, oy).
   * @param {object} op неизменяемый снимок операции
   */
  const blit = (op, ox, oy) => {
    const l = app.doc.activeLayer;
    if (!l || !op.snapshot) return;
    const affected = computeAffected(op);
    if (!affected) return;
    op.affected = affected;

    const tmp = ensureScratch(op.sourceRect.w, op.sourceRect.h);
    tmp.getContext('2d').putImageData(op.snapshot, 0, 0);

    const ctx = l.ctx;
    ctx.save();
    try {
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(affected.x, affected.y, affected.w, affected.h);
      ctx.drawImage(tmp, op.sourceRect.x + ox, op.sourceRect.y + oy);
    } finally {
      ctx.restore();
    }

    l.markDirty(affected);
    app.renderer.addDirty(affected);
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
      S.moved = true;

      // Во время перетаскивания состояние живёт в S
      blit({ sourceRect: S.sourceRect, snapshot: S.snapshot, dx: S.dx, dy: S.dy, duplicate: S.duplicate },
        S.dx, S.dy);
    },

    onPointerUp() {
      if (!S.dragging) return;
      if (!S.moved || !S.snapshot) { reset(); return; }

      // Замораживаем операцию: история больше не зависит от S
      const op = {
        sourceRect: { ...S.sourceRect },
        snapshot: S.snapshot,
        dx: S.dx,
        dy: S.dy,
        duplicate: S.duplicate,
        affected: null,
      };
      const selBefore = app.selection.rect ? { ...app.selection.rect } : null;
      const selAfter = selBefore
        ? { ...selBefore, x: selBefore.x + op.dx, y: selBefore.y + op.dy }
        : null;

      const apply = (ox, oy, sel) => {
        blit(op, ox, oy);
        if (tool.settings.moveSelection && sel && app.selection.active) {
          app.selection.rect = { ...sel };
          app.selection.emit('change');
        }
      };

      const command = {
        type: 'callback',
        label: 'Перемещение',
        bytes: op.sourceRect.w * op.sourceRect.h * 4,
        do: () => apply(op.dx, op.dy, selAfter),
        undo: () => apply(0, 0, selBefore),
      };

      app.history.execute(command);
      app.markChanged();
      reset();
    },

    onPointerCancel() { reset(); },
    drawOverlay() {},
    onDeactivate() { reset(); },
  };

  return tool;
}