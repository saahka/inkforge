/**
 * Вид (viewport): масштаб + смещение. Преобразование:
 *   screen = world * scale + offset
 * Здесь нет ничего отрисовочного — только математика и события,
 * чтобы renderer и input-handler читали одно и то же состояние.
 */

import { Emitter } from './emitter.js';
import { clamp } from '../utils/math.js';
import { config } from './config.js';

const MIN_SCALE = 0.02;
const MAX_SCALE = 32;

export class Viewport extends Emitter {
  constructor() {
    super();
    this.scale = 1;
    this.x = 0;      // смещение по X в экранных пикселях
    this.y = 0;
    this.viewW = 1;  // размер области просмотра в CSS-пикселях
    this.viewH = 1;
  }

  setSize(w, h) {
    if (w === this.viewW && h === this.viewH) return;
    this.viewW = Math.max(1, w);
    this.viewH = Math.max(1, h);
    this.emit('resize');
  }

  /** Масштаб с центрированием в точке экранных координат */
  zoomAt(screenX, screenY, factor) {
    const next = clamp(this.scale * factor, MIN_SCALE, MAX_SCALE);
    if (next === this.scale) return;
    // Точка под курсором остаётся на месте
    const wx = (screenX - this.x) / this.scale;
    const wy = (screenY - this.y) / this.scale;
    this.scale = next;
    this.x = screenX - wx * this.scale;
    this.y = screenY - wy * this.scale;
    this.emit('change');
  }

  setScale(scale, anchorX = this.viewW / 2, anchorY = this.viewH / 2) {
    this.zoomAt(anchorX, anchorY, clamp(scale, MIN_SCALE, MAX_SCALE) / this.scale);
  }

  /** Панорамирование мышью (в экранных пикселях) */
  panBy(dx, dy) {
    this.x += dx;
    this.y += dy;
    this.emit('change');
  }

  /** Прямоугольник документа вписывается в область просмотра */
  fit(docW, docH, padding = 48) {
    const s = Math.min(
      (this.viewW - padding) / docW,
      (this.viewH - padding) / docH,
    );
    this.scale = clamp(s, MIN_SCALE, MAX_SCALE);
    this.x = (this.viewW - docW * this.scale) / 2;
    this.y = (this.viewH - docH * this.scale) / 2;
    this.emit('change');
  }

  /** Масштаб 1:1, документ в левом верхнем углу с отступом */
  actualSize(docW, docH, padding = 32) {
    this.scale = 1;
    this.x = padding;
    this.y = padding;
    this.emit('change');
  }

  /* ─── Преобразования координат ───────────────────────────────── */

  screenToWorld(sx, sy) {
    return { x: (sx - this.x) / this.scale, y: (sy - this.y) / this.scale };
  }

  worldToScreen(wx, wy) {
    return { x: wx * this.scale + this.x, y: wy * this.scale + this.y };
  }

  /** Экранный прямоугольник → мировой (с расширением на 1px против щелей) */
  screenRectToWorld(r, pad = 1) {
    const a = this.screenToWorld(r.x - pad, r.y - pad);
    const b = this.screenToWorld(r.x + r.w + pad, r.y + r.h + pad);
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  }

  worldRectToScreen(r) {
    return {
      x: r.x * this.scale + this.x,
      y: r.y * this.scale + this.y,
      w: r.w * this.scale,
      h: r.h * this.scale,
    };
  }

  /** Видимый мировой прямоугольник (с запасом) */
  visibleWorldRect(padding = 0) {
    const a = this.screenToWorld(-padding, -padding);
    const b = this.screenToWorld(this.viewW + padding, this.viewH + padding);
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  }

  get zoomPercent() { return Math.round(this.scale * 100); }

  get isDefaultZoom() { return Math.abs(this.scale - 1) < 0.005; }

  serialize() { return { scale: this.scale, x: this.x, y: this.y }; }

  restore(state) {
    if (!state) return;
    this.scale = clamp(state.scale || 1, MIN_SCALE, MAX_SCALE);
    this.x = state.x || 0;
    this.y = state.y || 0;
    this.emit('change');
  }
}

export { MIN_SCALE, MAX_SCALE, config };