/**
 * Выделение. В Фазе 1 — прямоугольное (marquee).
 * Поле `mask` зарезервировано под произвольную форму (лассо/перо) в Фазе 2:
 * инструменты всегда спрашивают clipRect(), поэтому добавление маски
 * не потребует правок в инструментах.
 */

import { Emitter } from './emitter.js';
import { intersectRect, rectContainsRect } from '../utils/math.js';
import { createLayerCanvas } from './layer.js';

export class Selection extends Emitter {
  constructor(doc) {
    super();
    this.doc = doc;
    /** @type {{x,y,w,h}|null} прямоугольник выделения в координатах документа */
    this.rect = null;
    /** @type {HTMLCanvasElement|OffscreenCanvas|null} альфа-маска произвольной формы */
    this.mask = null;
    /** Выделен весь документ (Ctrl+A): ни rect, ни mask */
    this.all = false;
  }

  get active() { return this.all || !!this.rect || !!this.mask; }
  get isEmpty() { return !this.active; }

  setRect(rect, { record = false } = {}) {
    this.mask = null;
    this.all = false;
    this.rect = rect && rect.w >= 1 && rect.h >= 1 ? { ...rect } : null;
    this.emit('change', { record });
  }

  clear() {
    if (!this.active) return;
    this.rect = null;
    this.mask = null;
    this.all = false;
    this.emit('change');
  }

  /** Прямоугольник, в который нужно ограничить операцию (или весь документ) */
  clipRect() {
    if (this.mask) {
      // Произвольная форма: считаем её габариты, точность пока достаточная
      return { x: 0, y: 0, w: this.doc.width, h: this.doc.height };
    }
    if (!this.rect) return { x: 0, y: 0, w: this.doc.width, h: this.doc.height };
    return intersectRect(this.rect, { x: 0, y: 0, w: this.doc.width, h: this.doc.height })
      || { x: 0, y: 0, w: 0, h: 0 };
  }

  /** Применяет выделение как clip к контексту слоя (только прямоугольник) */
  clipContext(ctx) {
    if (this.mask) {
      // Произвольную форму так не обрежешь — вызывающий код должен
      // использовать applyMask() (см. App.commitStroke)
      ctx.rect(0, 0, this.doc.width, this.doc.height);
      ctx.clip();
      return;
    }
    if (!this.rect) return;
    ctx.beginPath();
    ctx.rect(this.rect.x, this.rect.y, this.rect.w, this.rect.h);
    ctx.clip();
  }

  /**
   * Возвращает canvas с исходником, обрезанным по маске выделения.
   * Используется, когда выделение произвольной формы (или инвертировано):
   * обычный clip по Path2D недоступен, поэтому маску применяем альфой.
   */
  applyMask(source, region) {
    if (!this.mask) return source;
    const out = createLayerCanvas(region.w, region.h);
    const ctx = out.getContext('2d');
    ctx.drawImage(source, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(this.mask, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h);
    ctx.globalCompositeOperation = 'source-over';
    return out;
  }

  /** Полностью ли выделение покрывает слой — тогда clip избыточен */
  coversAll() {
    return !this.rect || rectContainsRect({ x: 0, y: 0, w: this.doc.width, h: this.doc.height }, this.rect);
  }

  /* ─── Трансформации выделения ────────────────────────────────── */

  selectAll() {
    this.rect = null;
    this.mask = null;
    this.all = true;
    this.emit('change');
  }

  /**
   * Инверсия выделения: было прямоугольное → становится «всё, кроме него».
   * Результат хранится альфа-маской (белым = выделено).
   */
  invert() {
    if (!this.active || this.all) {
      this.selectAll();       // нечего инвертировать — выделяем всё
      return;
    }
    if (this.mask) {
      // Инвертируем маску: белый ↔ прозрачный
      const inv = createLayerCanvas(this.doc.width, this.doc.height);
      const ctx = inv.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, inv.width, inv.height);
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(this.mask, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      this.mask = inv;
      this.rect = null;
    } else {
      const mask = createLayerCanvas(this.doc.width, this.doc.height);
      const ctx = mask.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, mask.width, mask.height);
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = '#000';
      ctx.fillRect(this.rect.x, this.rect.y, this.rect.w, this.rect.h);
      ctx.globalCompositeOperation = 'source-over';
      this.mask = mask;
      this.rect = null;
    }
    this.all = false;
    this.emit('change');
  }

  /** Растушевка краёв (Фаза 1: расширение прямоугольника на указанное число пикселей) */
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
    // Маску в файл не пишем (Фаза 2 — PNG в base64), но и не теряем молча:
    // прямоугольное выделение сохраняется как есть
    if (this.all) return { all: true };
    return this.rect ? { rect: { ...this.rect } } : (this.mask ? { masked: true } : null);
  }

  restore(state) {
    this.all = !!state?.all;
    this.rect = state?.rect ? { ...state.rect } : null;
    this.mask = null;
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