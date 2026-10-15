/**
 * Рендерер: собирает слои в экранный холст и рисует оверлей.
 *
 * Оптимизации, которые уже работают:
 *  • перерисовывается только «грязный» прямоугольник (dirty rect);
 *  • для каждого слоя рисуется только пересечение с грязной областью (culling);
 *  • пустые слои (нет изменённых пикселей) пропускаются;
 *  • слои с клиппинг-маской и «неразделимыми» режимами смешивания
 *    считаются через временные canvas'ы, тоже только в области перерисовки;
 *  • активный штрих показывается из буфера, поэтому отклик мгновенный,
 *    а в историю он попадает один раз в конце.
 */

import { Emitter } from './emitter.js';
import { clamp, intersectRect, unionRect, rectsIntersect } from '../utils/math.js';
import { blendPixels } from './blend.js';
import { NATIVE_BLENDS, createLayerCanvas } from './layer.js';
import { drawMarchingAnts } from './selection.js';
import { stampDab, dabRadius } from './brush.js';

const NATIVE = new Set([...NATIVE_BLENDS, 'source-over']);

export class Renderer extends Emitter {
  /**
   * @param {object} app
   * @param {HTMLCanvasElement} app.viewCanvas
   * @param {HTMLCanvasElement} app.overlayCanvas
   * @param {import('./viewport.js').Viewport} app.viewport
   */
  constructor(app, { viewCanvas, overlayCanvas, viewport }) {
    super();
    this.app = app;
    this.view = viewCanvas;
    this.overlay = overlayCanvas;
    this.viewport = viewport;

    this.vctx = viewCanvas.getContext('2d', { alpha: false });
    this.octx = overlayCanvas.getContext('2d');

    this.dpr = 1;
    this.cssW = 1;
    this.cssH = 1;
    /** Прямоугольник в мировых координатах, который нужно перерисовать (null = весь холст) */
    this.dirty = null;
    /** Есть ли что перерисовывать (dirty === null сам по себе ещё не сигнал) */
    this.needsRender = true;
    /** Активный штрих: {buffer, composite} */
    this.liveStroke = null;
    /** Позиция курсора в мировых координатах */
    this.cursor = null;
    /** Текущий инструмент для отрисовки кольца кисти */
    this.cursorRadius = 0;

    /**@type {Array<(ctx: CanvasRenderingContext2D) => void>} поставщики оверлея */
    this.overlayProviders = [];

    this._scratchA = null;
    this._scratchB = null;
    this._antsPhase = 0;

    this.resize();
  }

  /* ─── Размеры ────────────────────────────────────────────────── */

  resize() {
    const rect = this.view.getBoundingClientRect();
    this.cssW = Math.max(1, rect.width);
    this.cssH = Math.max(1, rect.height);
    this.dpr = clamp(globalThis.devicePixelRatio || 1, 1, 3);

    const w = Math.round(this.cssW * this.dpr);
    const h = Math.round(this.cssH * this.dpr);
    for (const c of [this.view, this.overlay]) {
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
    }
    this.viewport.setSize(this.cssW, this.cssH);
    this._ensureScratch(w, h);
    this.invalidate();
  }

  _ensureScratch(w, h) {
    const need = !this._scratchA
      || this._scratchA.width !== w || this._scratchA.height !== h;
    if (!need) return;
    this._scratchA = createLayerCanvas(w, h);
    this._scratchB = createLayerCanvas(w, h);
    this._scratchA.ctx = this._scratchA.getContext('2d', { willReadFrequently: true });
    this._scratchB.ctx = this._scratchB.getContext('2d', { willReadFrequently: true });
  }

  /* ─── Инвалидация ────────────────────────────────────────────── */

  /** Перерисовать весь холст */
  invalidate() {
    this.dirty = null;
    this.needsRender = true;
    this.emit('invalidate');
  }

  /** Добавить область к перерисовке (мировые координаты) */
  addDirty(rect) {
    if (!rect) { this.invalidate(); return; }
    this.dirty = unionRect(this.dirty, rect);
    this.needsRender = true;
  }

  /** Область, которую нужно перерисовать в этом кадре */
  _region() {
    const doc = this.app.doc;
    if (this.dirty) return this.dirty;
    // Во время штриха перерисовываем только то, что уже нарисовано
    if (this.liveStroke?.dirty) {
      const r = intersectRect(this.liveStroke.dirty, doc.bounds);
      if (r) return r;
    }
    return { x: 0, y: 0, w: doc.width, h: doc.height };
  }

  /* ─── Основной кадр ──────────────────────────────────────────── */

  /** @returns {boolean} было ли что-то нарисовано */
  render() {
    if (!this.needsRender && !this.liveStroke) return false;
    const doc = this.app.doc;
    const vp = this.viewport;
    const ctx = this.vctx;

    const region = this._region();
    const docBounds = doc.bounds;

    // Экранный прямоугольник с запасом в 1 CSS-пиксель против щелей
    const sr = vp.worldRectToScreen(region);
    const srect = {
      x: Math.floor(sr.x) - 1,
      y: Math.floor(sr.y) - 1,
      w: Math.ceil(sr.w) + 2,
      h: Math.ceil(sr.h) + 2,
    };

    // 1. Фон рабочей области
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.beginPath();
    ctx.rect(srect.x, srect.y, srect.w, srect.h);
    ctx.clip();
    ctx.fillStyle = this.#canvasBg();
    ctx.fillRect(srect.x, srect.y, srect.w, srect.h);

    // 2. «Шахматка» прозрачности — только по документу
    const docScreen = vp.worldRectToScreen(docBounds);
    const checkerArea = intersectRect(docScreen, srect);
    if (checkerArea) {
      ctx.fillStyle = this.#checkerPattern();
      ctx.fillRect(checkerArea.x, checkerArea.y, checkerArea.w, checkerArea.h);
    }
    ctx.restore();

    // 3. Слои: ограничиваем область перерисовки (в экранных координатах),
    //    а трансформацию вида применяем уже после clip — иначе прямоугольник
    //    будет интерпретирован в координатах документа
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.beginPath();
    ctx.rect(srect.x, srect.y, srect.w, srect.h);
    ctx.clip();
    this.#applyViewport(ctx);

    for (const layer of doc.layers) {
      if (!layer.visible || layer.opacity <= 0) continue;
      if (layer.contentRect && !rectsIntersect(layer.contentRect, docBounds)) continue;
      if (layer.contentRect && !rectsIntersect(layer.contentRect, region)) continue;
      this._drawLayer(ctx, layer, region);
    }

    // 4. Живой штрих из буфера
    if (this.liveStroke) this._drawLiveStroke(ctx, region);
    ctx.restore();

    this.dirty = null;
    this.needsRender = false;
    return true;
  }

  #applyViewport(ctx) {
    const vp = this.viewport;
    const s = this.dpr;
    ctx.setTransform(vp.scale * s, 0, 0, vp.scale * s, vp.x * s, vp.y * s);
  }

  /** Рисует один слой с учётом прозрачности, режима наложения и клиппинг-масок */
  _drawLayer(ctx, layer, region) {
    const vp = this.viewport;
    const masks = this.app.doc.clipTarget(layer);
    const nativeBlend = NATIVE.has(layer.blendMode);

    const src = intersectRect(layer.contentRect || layer.bounds, region);
    if (!src) return;

    // Быстрый путь: нативный режим без масок
    if (nativeBlend && masks.length === 0) {
      ctx.save();
      ctx.globalAlpha = layer.opacity;
      ctx.globalCompositeOperation = layer.blendMode;
      ctx.drawImage(layer.canvas, src.x, src.y, src.w, src.h, src.x, src.y, src.w, src.h);
      ctx.restore();
      return;
    }

    // Медленный путь: собираем слой во временный canvas
    const A = this._scratchA;
    const actx = A.ctx;
    actx.setTransform(1, 0, 0, 1, 0, 0);
    actx.clearRect(0, 0, A.width, A.height);
    this.#applyViewport(actx);
    actx.drawImage(layer.canvas, src.x, src.y, src.w, src.h, src.x, src.y, src.w, src.h);

    // Клиппинг-маски: оставляем только то, что попало в альфу маски
    for (const mask of masks) {
      const msrc = intersectRect(mask.contentRect || mask.bounds, region);
      if (!msrc) continue;
      actx.save();
      actx.globalCompositeOperation = 'destination-in';
      actx.drawImage(mask.canvas, msrc.x, msrc.y, msrc.w, msrc.h, msrc.x, msrc.y, msrc.w, msrc.h);
      actx.restore();
    }

    if (nativeBlend) {
      ctx.save();
      ctx.globalAlpha = layer.opacity;
      ctx.globalCompositeOperation = layer.blendMode;
      ctx.drawImage(A, src.x, src.y, src.w, src.h, src.x, src.y, src.w, src.h);
      ctx.restore();
      return;
    }

    // Неразделимый режим (Оттенок/Насыщенность/Цвет/Светлота) — попиксельно
    const devRect = this._deviceRect(src);
    if (devRect.w < 1 || devRect.h < 1) return;

    const B = this._scratchB;
    const backdrop = ctx.getImageData(devRect.x, devRect.y, devRect.w, devRect.h);
    const source = actx.getImageData(devRect.x, devRect.y, devRect.w, devRect.h);
    const result = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
    blendPixels(backdrop, source, result, layer.blendMode);

    // Непрозрачность слоя применяем к альфе результата
    if (layer.opacity < 1) {
      const d = result.data;
      for (let i = 3; i < d.length; i += 4) d[i] *= layer.opacity;
    }
    ctx.putImageData(result, devRect.x, devRect.y);
  }

  _deviceRect(worldRect) {
    const vp = this.viewport;
    const x = Math.floor((worldRect.x * vp.scale + vp.x) * this.dpr);
    const y = Math.floor((worldRect.y * vp.scale + vp.y) * this.dpr);
    const r = Math.ceil(((worldRect.x + worldRect.w) * vp.scale + vp.x) * this.dpr);
    const b = Math.ceil(((worldRect.y + worldRect.h) * vp.scale + vp.y) * this.dpr);
    const w = clamp(r - x, 0, this.view.width - x);
    const h = clamp(b - y, 0, this.view.height - y);
    return { x: Math.max(0, x), y: Math.max(0, y), w, h };
  }

  /** Наложение буфера активного штриха поверх композита */
  _drawLiveStroke(ctx, region) {
    const { buffer, composite, dirty } = this.liveStroke;
    if (!buffer) return;
    const src = dirty ? intersectRect(dirty, region) : region;
    if (!src) return;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = composite || 'source-over';
    ctx.drawImage(buffer.canvas, src.x, src.y, src.w, src.h, src.x, src.y, src.w, src.h);
    ctx.restore();
  }

  /** Цвет фона рабочей области (кэшируем: getComputedStyle каждый кадр дорог) */
  #canvasBg() {
    if (!this._bg) {
      this._bg = getComputedStyle(document.documentElement)
        .getPropertyValue('--bg-canvas').trim() || '#0e1013';
    }
    return this._bg;
  }

  #checkerPattern() {
    if (this._pattern) return this._pattern;
    const size = 12;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const theme = getComputedStyle(document.documentElement);
    g.fillStyle = theme.getPropertyValue('--bg-sunken').trim() || '#171a20';
    g.fillRect(0, 0, size, size);
    g.fillStyle = theme.getPropertyValue('--bg-hover').trim() || '#2a2f39';
    g.fillRect(0, 0, size / 2, size / 2);
    g.fillRect(size / 2, size / 2, size / 2, size / 2);
    const ctx = this.vctx;
    this._pattern = ctx.createPattern(c, 'repeat');
    this._patternCanvas = c;
    return this._pattern;
  }

  /** Пересоздаёт паттерн после смены темы */
  invalidateTheme() {
    this._pattern = null;
    this._bg = null;
    this.invalidate();
  }

  /* ─── Оверлей: курсор, выделение, предсказание ───────────────── */

  /** Подписка на отрисовку оверлея: fn(ctx, renderer) */
  onOverlay(fn) {
    this.overlayProviders.push(fn);
    return () => {
      const i = this.overlayProviders.indexOf(fn);
      if (i >= 0) this.overlayProviders.splice(i, 1);
    };
  }

  renderOverlay(dt = 16) {
    const ctx = this.octx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    // Рамка документа
    this._drawCanvasFrame(ctx);

    // Выделение «муравьиными» линиями
    const sel = this.app.selection;
    if (sel.active && sel.rect) {
      this._antsPhase = (this._antsPhase + dt * 0.02) % 8;
      drawMarchingAnts(ctx, sel.rect, this.viewport.scale, this.viewport.x, this.viewport.y, this._antsPhase);
    }

    // Поставщики (инструменты: кольцо кисти, marquee, градиент…)
    for (const fn of this.overlayProviders) {
      try { fn(ctx, this); } catch (err) { console.error('[overlay]', err); }
    }
  }

  _drawCanvasFrame(ctx) {
    const vp = this.viewport;
    const r = vp.worldRectToScreen(this.app.doc.bounds);
    if (r.x > this.cssW || r.y > this.cssH || r.x + r.w < 0 || r.y + r.h < 0) return;
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,.55)';
    ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w), Math.round(r.h));
    ctx.strokeStyle = 'rgba(255,255,255,.14)';
    ctx.strokeRect(Math.round(r.x) - 0.5, Math.round(r.y) - 0.5, Math.round(r.w) + 1, Math.round(r.h) + 1);
    ctx.restore();
  }

  /** Кольцо курсора кисти */
  drawBrushCursor(ctx, radiusWorld) {
    if (!this.cursor || radiusWorld <= 0) return;
    const vp = this.viewport;
    const c = vp.worldToScreen(this.cursor.x, this.cursor.y);
    const r = Math.max(2.5, radiusWorld * vp.scale);
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,.7)';
    ctx.beginPath();
    ctx.arc(c.x, c.y, r + 0.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.95)';
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /** «Призрак» предсказанного продолжения штриха */
  drawPrediction(ctx, prediction, brush) {
    if (!prediction) return;
    const vp = this.viewport;
    const from = vp.worldToScreen(prediction.from.x, prediction.from.y);
    const to = vp.worldToScreen(prediction.to.x, prediction.to.y);
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = brush?.color ? rgbCss(brush.color) : '#fff';
    ctx.lineWidth = Math.max(1, (brush?.size || 4) * 0.35 * vp.scale);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.restore();
  }
}

const rgbCss = ({ r, g, b }) => `rgb(${r},${g},${b})`;

export { stampDab, dabRadius };