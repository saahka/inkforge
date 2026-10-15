/**
 * Выделение. В Фазе 1 — прямоугольное (marquee).
 * Поле `mask` зарезервировано под произвольную форму (лассо/перо) в Фазе 2:
 * инструменты всегда спрашивают clipRect(), поэтому добавление маски
 * не потребует правок в инструментах.
 */

import { Emitter } from './emitter.js';
import { intersectRect, rectContainsRect } from '../utils/math.js';

export class Selection extends Emitter {
  constructor(doc) {
    super();
    this.doc = doc;
    /** @type {{x,y,w,h}|null} прямоугольник выделения в координатах документа */
    this.rect = null;
    /** @type {HTMLCanvasElement|OffscreenCanvas|null} альфа-маска произвольной формы */
    this.mask = null;
  }

  get active() { return !!this.rect || !!this.mask; }
  get isEmpty() { return !this.active; }

  setRect(rect, { record = false } = {}) {
    this.rect = rect && rect.w >= 1 && rect.h >= 1 ? { ...rect } : null;
    this.emit('change', { record });
  }

  clear() {
    if (!this.active) return;
    this.rect = null;
    this.mask = null;
    this.emit('change');
  }

  /** Прямоугольник, в который нужно ограничить операцию (или весь документ) */
  clipRect() {
    if (!this.rect) return { x: 0, y: 0, w: this.doc.width, h: this.doc.height };
    return intersectRect(this.rect, { x: 0, y: 0, w: this.doc.width, h: this.doc.height })
      || { x: 0, y: 0, w: 0, h: 0 };
  }

  /** Применяет выделение как clip к контексту слоя */
  clipContext(ctx) {
    if (!this.active) return;
    ctx.beginPath();
    if (this.mask) ctx.rect(0, 0, this.doc.width, this.doc.height);
    else ctx.rect(this.rect.x, this.rect.y, this.rect.w, this.rect.h);
    ctx.clip();
    if (this.mask) ctx.clip(this.mask, 'destination-in');
  }

  /** Полностью ли выделение покрывает слой — тогда clip избыточен */
  coversAll() {
    return !this.rect || rectContainsRect({ x: 0, y: 0, w: this.doc.width, h: this.doc.height }, this.rect);
  }

  /* ─── Трансформации выделения ────────────────────────────────── */

  selectAll() {
    this.setRect({ x: 0, y: 0, w: this.doc.width, h: this.doc.height });
  }

  /** Растушевка краёв (в Фазе 1 — обрезка по расширенному прямоугольнику) */
  feather(px) {
    if (!this.rect) return;
    this.setRect({
      x: this.rect.x - px, y: this.rect.y - px,
      w: this.rect.w + px * 2, h: this.rect.h + px * 2,
    });
  }

  /** Сдвиг выделения вместе с содержимым (инструмент «Перемещение») */
  translate(dx, dy) {
    if (!this.rect) return;
    this.setRect({ ...this.rect, x: this.rect.x + dx, y: this.rect.y + dy });
  }

  serialize() {
    return this.rect ? { rect: { ...this.rect } } : null;
  }

  restore(state) {
    this.rect = state?.rect ? { ...state.rect } : null;
    this.emit('change');
  }
}

/**
 * Рисует «муравьи» по границе выделения.
 * Вызывается overlay-рендерером каждый кадр.
 */
export function drawMarchingAnts(ctx, rect, scale, offsetX, offsetY, phase = 0) {
  const x = rect.x * scale + offsetX;
  const y = rect.y * scale + offsetY;
  const w = rect.w * scale;
  const h = rect.h * scale;

  ctx.save();
  ctx.lineWidth = 1;

  // Затемняющая подложка — чтобы «муравьи» читались на любом фоне
  ctx.strokeStyle = 'rgba(0,0,0,.75)';
  ctx.setLineDash([]);
  ctx.strokeRect(x + 0.5, y + 0.5, w, h);

  ctx.strokeStyle = '#fff';
  ctx.setLineDash([4, 4]);
  ctx.lineDashOffset = -phase;
  ctx.strokeRect(x + 0.5, y + 0.5, w, h);

  ctx.restore();
}