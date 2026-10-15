/**
 * Документ: размеры, фон и стек слоёв.
 * Логику над слоями (добавление, порядок, слияние) держит LayerManager.
 */

import { Emitter } from './emitter.js';
import { Layer, createLayerCanvas } from './layer.js';
import { config } from './config.js';
import { uid } from '../utils/math.js';

const clampDim = (v) => Math.max(1, Math.min(Math.round(v), config.MAX_DIMENSION));

export class Document extends Emitter {
  constructor({ width = 1920, height = 1080, name = 'Без имени', background = '#ffffff' } = {}) {
    super();
    this.id = uid('doc');
    this.name = name;
    this.width = width;
    this.height = height;
    this.background = background;
    /** @type {Layer[]} снизу вверх: последний элемент — верхний слой */
    this.layers = [];
    this.activeLayerId = null;
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
  }

  /* ─── Слои ──────────────────────────────────────────────────── */

  get activeLayer() { return this.layers.find((l) => l.id === this.activeLayerId) || null; }

  get layer() { return this.activeLayer; }

  setActiveLayer(id) {
    if (this.activeLayerId === id) return;
    this.activeLayerId = id;
    this.emit('activeLayer', this.activeLayer);
    this.touch();
  }

  indexOf(id) { return this.layers.findIndex((l) => l.id === id); }

  layerById(id) { return this.layers.find((l) => l.id === id) || null; }

  /** Слой, на который ссылается клиппинг-маска (или null) */
  clipTarget(layer) {
    let guard = 0;
    const chain = [];
    let cur = layer;
    while (cur?.clipTo && guard++ < 32) {
      cur = this.layerById(cur.clipTo);
      if (!cur) break;
      chain.push(cur);
    }
    return chain;
  }

  get bounds() { return { x: 0, y: 0, w: this.width, h: this.height }; }

  /** Видимые слои снизу вверх, с учётом клиппинг-масок и видимости */
  visibleLayers() {
    return this.layers.filter((l) => l.visible);
  }

  /* ─── Размеры ───────────────────────────────────────────────── */

  resize(width, height, { anchor = 'top-left' } = {}) {
    width = Math.max(1, Math.min(Math.round(width), config.MAX_DIMENSION));
    height = Math.max(1, Math.min(Math.round(height), config.MAX_DIMENSION));
    const dx = anchor === 'center' ? Math.round((this.width - width) / 2) : 0;
    const dy = anchor === 'center' ? Math.round((this.height - height) / 2) : 0;

    for (const layer of this.layers) {
      const next = createLayerCanvas(width, height);
      const ctx = next.getContext('2d', { alpha: true });
      ctx.drawImage(layer.canvas, dx, dy);
      layer.canvas = next;
      layer.ctx = ctx;
      layer.width = width;
      layer.height = height;
      layer.markDirty();
    }
    this.width = width;
    this.height = height;
    this.emit('resize');
    this.touch();
  }

  /** Кадрирование по прямоугольнику: слои сдвигаются и обрезаются */
  crop(rect) {
    const w = clampDim(rect.w);
    const h = clampDim(rect.h);
    const dx = -Math.round(rect.x);
    const dy = -Math.round(rect.y);
    for (const layer of this.layers) {
      const next = createLayerCanvas(w, h);
      const ctx = next.getContext('2d', { alpha: true });
      ctx.drawImage(layer.canvas, dx, dy);
      layer.canvas = next;
      layer.ctx = ctx;
      layer.width = w;
      layer.height = h;
      layer.markDirty();
    }
    this.width = w;
    this.height = h;
    this.emit('resize');
    this.touch();
  }

  touch() {
    this.updatedAt = Date.now();
    this.emit('change');
  }

  /* ─── Сохранение метаданных ─────────────────────────────────── */

  serialize() {
    return {
      id: this.id,
      name: this.name,
      width: this.width,
      height: this.height,
      background: this.background,
      activeLayerId: this.activeLayerId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

/** Новый документ с одним фоновым слоем */
export function createDocument(opts = {}) {
  const doc = new Document(opts);
  const layer = new Layer(doc.width, doc.height, { name: 'Фон' });
  if (opts.background && opts.background !== 'transparent') {
    layer.ctx.fillStyle = opts.background;
    layer.ctx.fillRect(0, 0, doc.width, doc.height);
    layer.markDirty();
  }
  doc.layers.push(layer);
  doc.activeLayerId = layer.id;
  return doc;
}