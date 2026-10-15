/**
 * Слой документа.
 *
 * Каждый слой — отдельный canvas размером с документ. Это простой и быстрый
 * для Фазы 1 способ: композитинг делает renderer, а инструменты пишут прямо
 * в ctx слоя. Для холстов 16000+ понадобится разбиение на тайлы (Фаза 4).
 */

import { uid } from '../utils/math.js';
import { canvasToBlob, loadImageBitmap } from '../utils/dom.js';

/**
 * Режимы наложения. `native: true` — поддерживается Canvas2D напрямую,
 * остальные renderer считает попиксельно (см. blend.js).
 */
export const BLEND_MODES = [
  { id: 'source-over', label: 'Обычный', native: true },
  { id: 'multiply', label: 'Умножение', native: true },
  { id: 'screen', label: 'Экран', native: true },
  { id: 'overlay', label: 'Наложение', native: true },
  { id: 'darken', label: 'Затемнение', native: true },
  { id: 'lighten', label: 'Осветление', native: true },
  { id: 'color-dodge', label: 'Осветление ( dodge)', native: true },
  { id: 'color-burn', label: 'Затемнение (burn)', native: true },
  { id: 'hard-light', label: 'Жёсткий свет', native: true },
  { id: 'soft-light', label: 'Мягкий свет', native: true },
  { id: 'difference', label: 'Разность', native: true },
  { id: 'exclusion', label: 'Исключение', native: true },
  { id: 'hue', label: 'Оттенок', native: false },
  { id: 'saturation', label: 'Насыщенность', native: false },
  { id: 'color', label: 'Цвет', native: false },
  { id: 'luminosity', label: 'Светлота', native: false },
];

export const NATIVE_BLENDS = new Set(BLEND_MODES.filter((b) => b.native).map((b) => b.id));

/** Создаёт offscreen-подобный canvas (OffscreenCanvas, если доступен) */
export function createLayerCanvas(width, height) {
  const Canvas = globalThis.OffscreenCanvas || HTMLCanvasElement;
  return new Canvas(width, height);
}

export class Layer {
  /**
   * @param {number} width  ширина документа
   * @param {number} height высота документа
   * @param {object} [props] начальные свойства слоя
   */
  constructor(width, height, props = {}) {
    this.id = props.id || uid('layer');
    this.name = props.name || 'Слой';
    this.visible = props.visible !== false;
    this.opacity = props.opacity ?? 1;          // 0..1
    this.blendMode = props.blendMode || 'source-over';
    this.clipTo = props.clipTo || null;        // id слоя-маски (clipping mask)
    this.locked = !!props.locked;
    this.alphaLocked = !!props.alphaLocked;

    this.width = width;
    this.height = height;
    this.canvas = props.canvas || createLayerCanvas(width, height);
    this.ctx = this.canvas.getContext('2d', { alpha: true, willReadFrequently: false });

    // Прямоугольник, который реально закрашен — для ускорения композитинга.
    // Обновляется инструментами через markDirty().
    this.contentRect = props.contentRect || null;
  }

  get bounds() { return { x: 0, y: 0, w: this.width, h: this.height }; }

  /** Отмечает, что в слое изменились пиксели внутри rect (null — весь слой) */
  markDirty(rect = null) {
    this.contentRect = rect ? this._growRect(rect) : null;
  }

  _growRect(rect) {
    if (!this.contentRect) {
      return { x: Math.floor(rect.x), y: Math.floor(rect.y), w: Math.ceil(rect.w), h: Math.ceil(rect.h) };
    }
    const x = Math.min(this.contentRect.x, Math.floor(rect.x));
    const y = Math.min(this.contentRect.y, Math.floor(rect.y));
    const r = Math.max(this.contentRect.x + this.contentRect.w, Math.ceil(rect.x + rect.w));
    const b = Math.max(this.contentRect.y + this.contentRect.h, Math.ceil(rect.y + rect.h));
    this.contentRect = { x, y, w: r - x, h: b - y };
  }

  /* ─── Пиксельные операции ─────────────────────────────────────── */

  clear(rect = null) {
    if (!rect) {
      this.ctx.clearRect(0, 0, this.width, this.height);
      this.contentRect = null;
      return;
    }
    this.ctx.clearRect(rect.x, rect.y, rect.w, rect.h);
    this.markDirty(rect);
  }

  getImageData(rect) {
    return this.ctx.getImageData(rect.x, rect.y, Math.max(1, rect.w), Math.max(1, rect.h));
  }

  putImageData(data, x = 0, y = 0) {
    this.ctx.putImageData(data, x, y);
    this.markDirty({ x, y, w: data.width, h: data.height });
  }

  /** Рисование «поверх» содержимого слоя (кисть, заливка, фигуры) */
  draw(drawFn, rect = null) {
    const ctx = this.ctx;
    ctx.save();
    if (rect) {
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.w, rect.h);
      ctx.clip();
    }
    drawFn(ctx);
    ctx.restore();
    if (rect) this.markDirty(rect);
    else this.markDirty();
  }

  /** Копирует пиксели из другого слоя */
  copyFrom(other) {
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.ctx.drawImage(other.canvas, 0, 0);
    this.contentRect = other.contentRect ? { ...other.contentRect } : null;
    return this;
  }

  /** Маска непрозрачности: оставляет пиксели только там, где маска непрозрачна */
  applyAlphaMask(maskCanvas) {
    this.ctx.save();
    this.ctx.globalCompositeOperation = 'destination-in';
    this.ctx.drawImage(maskCanvas, 0, 0);
    this.ctx.restore();
    this.markDirty();
  }

  /** Содержимое слоя, применённое к непрозрачному фону (для превью) */
  toDataURL(type = 'image/png') {
    if (this.canvas.convertToBlob) {
      return this.canvas.convertToBlob({ type }).then(toDataURL);
    }
    return this.canvas.toDataURL(type);
  }

  async toBlob(type = 'image/png', quality) {
    // OffscreenCanvas умеет только convertToBlob, обычный canvas — toBlob
    if (this.canvas.convertToBlob) return this.canvas.convertToBlob({ type, quality });
    return canvasToBlob(this.canvas, type, quality);
  }

  /* ─── Сериализация ───────────────────────────────────────────── */

  /** Только метаданные (для истории и сохранения) */
  serialize() {
    return {
      id: this.id,
      name: this.name,
      visible: this.visible,
      opacity: this.opacity,
      blendMode: this.blendMode,
      clipTo: this.clipTo,
      locked: this.locked,
      alphaLocked: this.alphaLocked,
    };
  }

  /** Применяет метаданные (объект слоя при этом сохраняется) */
  applyMeta(meta) {
    Object.assign(this, {
      name: meta.name,
      visible: meta.visible,
      opacity: meta.opacity,
      blendMode: meta.blendMode,
      clipTo: meta.clipTo,
      locked: meta.locked,
      alphaLocked: meta.alphaLocked,
    });
    return this;
  }

  static async fromBlob(width, height, blob, props = {}) {
    const layer = new Layer(width, height, props);
    const bmp = await loadImageBitmap(blob);
    layer.ctx.drawImage(bmp, 0, 0);
    bmp.close?.();
    layer.markDirty();
    return layer;
  }

  /** Мини-превью для панели слоёв (data URL) */
  async thumb(size = 64) {
    const w = this.width, h = this.height;
    const k = Math.min(size / w, size / h);
    const tw = Math.max(1, Math.round(w * k));
    const th = Math.max(1, Math.round(h * k));
    const c = createLayerCanvas(tw, th);
    c.getContext('2d').drawImage(this.canvas, 0, 0, tw, th);
    return c.convertToBlob
      ? c.convertToBlob({ type: 'image/webp', quality: 0.7 }).then(toDataUrl)
      : Promise.resolve(c.toDataURL('image/webp', 0.7));
  }
}

function toDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}