/**
 * Движок штрихов: превращает поток сырых событий указателя в ряд штампов кисти.
 *
 * Как это работает
 * ────────────────
 * 1. Точки сглаживаются демпфированным фильтром (убирает дрожание руки/планшета).
 * 2. Соседние точки соединяются сплайном Catmull-Rom.
 * 3. По сплайну «шагами» ставятся штампы кисти (spacing = доля от размера).
 * 4. Давление пера управляет размером и прозрачностью (динамика кисти).
 *
 * Штрих рисуется не сразу в слой, а в буфер: в конце штриха известна
 * точная область изменений — этого достаточно для дешёвой записи в историю
 * (хранится только ImageData этой области).
 *
 * Для отзывчивости буфер композитится в экранный холст каждый кадр,
 * а поверх рисуется «предсказание» — экстраполяция траектории пера.
 */

import { catmullRom, clamp, dist, extrapolate, unionRect } from '../utils/math.js';
import { stampDab, dabRadius, dynamicSize, dynamicAlpha } from './brush.js';
import { config } from './config.js';

/** Максимальная площадь, для которой допустим буфер штриха (4096²) */
const MAX_BUFFER_AREA = 4096 * 4096;

export class StrokeEngine {
  /** @param {{getBuffer: () => {canvas: HTMLCanvasElement|OffscreenCanvas, ctx: CanvasRenderingContext2D}}} deps */
  constructor(deps) {
    this.getBuffer = deps.getBuffer;
    this.active = false;
    /** Превью-предсказание для оверлея */
    this.prediction = null;
    this._reset();
  }

  _reset() {
    this.layer = null;
    this.brush = null;
    this.composite = 'source-over';
    this.path = [];         // сглаженные точки
    this.raw = null;        // последняя сырая точка
    this.prevRaw = null;
    this.tip = null;        // куда поставили последний штамп
    this.carry = 0;         // остаток пути до следующего штампа
    this.dirty = null;      // накопленная область изменения
    this.selection = null;
    this.strokeCount = 0;
    this.buffer = null;
    this.direct = false;
  }

  /* ─── Начало штриха ──────────────────────────────────────────── */

  /**
   * @param {object} o
   * @param {import('./layer.js').Layer} o.layer
   * @param {object} o.brush
   * @param {object} o.point {x,y,pressure,tilt,t}
   * @param {string} [o.composite] режим наложения внутри слоя
   * @param {import('./selection.js').Selection} [o.selection]
   */
  begin({ layer, brush, point, composite = 'source-over', selection = null }) {
    this._reset();
    this.layer = layer;
    this.brush = brush;
    this.composite = composite;
    this.selection = selection;
    this.active = true;

    const buf = this.getBuffer();
    if (buf) {
      buf.ctx.setTransform(1, 0, 0, 1, 0, 0);
      buf.ctx.globalCompositeOperation = 'source-over';
      buf.ctx.globalAlpha = 1;
      buf.ctx.clearRect(0, 0, buf.canvas.width, buf.canvas.height);
      this.buffer = buf;
    } else {
      // Холст слишком большой для буфера — рисуем сразу в слой
      // (см. ограничение MAX_BUFFER_AREA; история для таких штрихов упрощается)
      this.direct = true;
      const ctx = layer.ctx;
      ctx.save();
      ctx.globalCompositeOperation = composite;
      if (selection?.active) selection.clipContext(ctx);
    }

    this.raw = { ...point };
    this.prevRaw = { ...point };
    this.path = [{ ...point }];
    this.tip = { x: point.x, y: point.y };

    // Первый dab — всегда в точке нажатия
    this.#stampAt(point, point);
  }

  /* ─── Продолжение штриха ─────────────────────────────────────── */

  /**
   * @param {Array} points сырые точки (мировые координаты)
   */
  extend(points) {
    if (!this.active) return;
    for (const raw of points) this.#addPoint(raw);
    this.#updatePrediction();
  }

  #addPoint(raw) {
    const smoothed = this.#filter(raw);
    this.prevRaw = this.raw;
    this.raw = { ...raw };

    const path = this.path;
    path.push(smoothed);
    if (path.length > 8) path.shift();

    const n = path.length;
    if (n >= 3) {
      const p0 = path[n - 3];
      const p1 = path[n - 2];
      const p2 = path[n - 1];
      this.#walkCurve(p0, p1, p2, smoothed);
    } else if (n === 2) {
      this.#walkLine(path[0], smoothed);
    }
  }

  /** Демпфирование координат, давления и наклона */
  #filter(p) {
    const k = 1 - this.brush.smoothing * 0.85;   // 1 — без сглаживания
    const prev = this.path[this.path.length - 1];
    if (!prev) return { ...p };
    return {
      x: prev.x + (p.x - prev.x) * k,
      y: prev.y + (p.y - prev.y) * k,
      pressure: prev.pressure + ((p.pressure ?? 1) - prev.pressure) * Math.min(1, k * 1.4),
      tilt: prev.tilt + ((p.tilt ?? 0) - prev.tilt) * k,
      t: p.t,
    };
  }

  /** Ставит штампы вдоль отрезка, соблюдая шаг spacing */
  #walkLine(from, to) {
    const step = Math.max(0.7, this.#stepFor(from));
    const d = dist(from.x, from.y, to.x, to.y);
    if (d < 1e-4) return;
    const steps = Math.max(1, Math.ceil(d / step));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      this.#stampAt({
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        pressure: from.pressure + ((to.pressure ?? 1) - from.pressure) * t,
        tilt: from.tilt + ((to.tilt ?? 0) - from.tilt) * t,
      }, to);
    }
  }

  /** Идёт по сплайну Catmull-Rom от p1 к p2 */
  #walkCurve(p0, p1, p2, pEnd) {
    const step = Math.max(0.7, this.#stepFor(p1));
    const d = dist(p1.x, p1.y, p2.x, p2.y);
    const steps = clamp(Math.ceil(d / step), 1, 64);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const pt = catmullRom(p0, p1, p2, pEnd, t);
      pt.pressure = p1.pressure + ((p2.pressure ?? 1) - p1.pressure) * t;
      pt.tilt = p1.tilt + ((p2.tilt ?? 0) - p1.tilt) * t;
      this.#stampAt(pt, pEnd);
    }
  }

  #stepFor(point) {
    const size = dynamicSize(this.brush, point);
    return Math.max(0.7, size * this.brush.spacing);
  }

  /**
   * Ставит dab в точку p, предварительно «добивая» расстояние от прошлого
   * штампа, чтобы не было пробелов при быстром движении.
   */
  #stampAt(p, ref) {
    if (!this.tip) { this.tip = { x: p.x, y: p.y }; }
    const step = this.#stepFor(p);
    const dx = p.x - this.tip.x;
    const dy = p.y - this.tip.y;
    const d = Math.hypot(dx, dy);

    if (d >= step) {
      const count = Math.min(Math.floor(d / step), 256);
      for (let i = 1; i <= count; i++) {
        const t = i * step / d;
        this.#putDab({
          x: this.tip.x + dx * t,
          y: this.tip.y + dy * t,
          pressure: p.pressure,
          tilt: p.tilt,
        }, ref);
      }
      const left = d - count * step;
      this.carry = left;
    } else {
      this.carry += d;
    }

    // Всё равно ставим dab в конечную точку сегмента с накопленной плотностью
    this.#putDab(p, ref);
  }

  #putDab(p, ref) {
    const ctx = this.buffer
      ? this.buffer.ctx
      : (this.direct ? this.layer?.ctx : null);
    if (!ctx) return;
    const size = dynamicSize(this.brush, p);
    const radius = dabRadius(this.brush) * (size / this.brush.size);
    const alpha = dynamicAlpha(this.brush, p);

    // Наклон пера поворачивает овал каллиграфии
    const rotation = this.brush.aspect < 1 && ref
      ? Math.atan2((ref.y ?? p.y) - p.y, (ref.x ?? p.x) - p.x)
      : 0;

    stampDab(ctx, this.brush, p.x, p.y, {
      alpha,
      scale: size / this.brush.size,
      rotation: rotation || undefined,
    });

    this.tip = { x: p.x, y: p.y };
    this.dirty = unionRect(this.dirty, { x: p.x - radius, y: p.y - radius, w: radius * 2, h: radius * 2 });
  }

  /* ─── Предсказание траектории ────────────────────────────────── */

  #updatePrediction() {
    if (!config.PREDICTION_MS || !this.raw || !this.prevRaw) { this.prediction = null; return; }
    const p = extrapolate(this.raw, this.prevRaw, config.PREDICTION_MS / 1000, 3);
    const moved = dist(p.x, p.y, this.raw.x, this.raw.y);
    this.prediction = moved > 2 ? { from: { ...this.tip }, to: p } : null;
  }

  /* ─── Завершение ─────────────────────────────────────────────── */

  /** Возвращает прямоугольник изменённой области (или null, если штриха не было) */
  getDirtyRect() {
    return this.dirty ? { ...this.dirty } : null;
  }

  /**
   * Финализирует штрих: дорисовывает конечную точку и возвращает
   * { canvas, rect, composite } — то, что нужно записать в слой.
   */
  finish() {
    if (!this.active) return null;
    // Гарантируем, что штрих дойдёт до точки отпускания
    if (this.raw && this.tip) {
      const d = dist(this.raw.x, this.raw.y, this.tip.x, this.tip.y);
      if (d > 0.4) this.#putDab(this.raw, this.raw);
    }

    if (this.direct) {
      // Прямой режим: пиксели уже в слое, осталось снять clip/composite
      this.layer?.ctx.restore();
      this.layer?.markDirty(this.dirty);
      this.active = false;
      this.prediction = null;
      return { buffer: null, dirty: this.getDirtyRect(), composite: this.composite, direct: true };
    }

    const result = {
      buffer: this.buffer,
      dirty: this.getDirtyRect(),
      composite: this.composite,
      direct: false,
    };
    this.active = false;
    this.prediction = null;
    return result;
  }

  /** Прерывание (Esc, смена инструмента) — буфер просто выбрасывается */
  cancel() {
    if (!this.active) return null;
    if (this.direct) this.layer?.ctx.restore();
    this.active = false;
    this.prediction = null;
    const result = this.buffer
      ? { buffer: this.buffer, dirty: this.dirty, composite: this.composite }
      : null;
    this._reset();
    return result;
  }
}

/**
 * Хранилище буфера штриха: один canvas на всё приложение.
 * Создаётся лениво и переиспользуется — нулевое давление на GC.
 */
export function createStrokeBufferStore() {
  let buffer = null;
  return {
    getBuffer(width, height) {
      if (width * height > MAX_BUFFER_AREA) return null;   // см. Фазу 4 (тайлы)
      if (!buffer || buffer.canvas.width !== width || buffer.canvas.height !== height) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        buffer = { canvas, ctx: canvas.getContext('2d', { alpha: true }) };
      }
      return buffer;
    },
    dispose() {
      buffer = null;
    },
  };
}