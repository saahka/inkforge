/**
 * Менеджер слоёв: создание, удаление, порядок, свойства, слияние.
 * Каждая операция, меняющая стек или метаданные, оборачивается в
 * SnapshotCommand — поэтому всё отменяется одной кнопкой.
 */

import { Emitter } from './emitter.js';
import { Layer, createLayerCanvas } from './layer.js';
import { CallbackCommand, PixelCommand } from './history.js';

export class LayerManager extends Emitter {
  /** @param {import('./doc.js').Document} doc */
  constructor(doc, history) {
    super();
    this.doc = doc;
    this.history = history;
    /** Кэш превью: id слоя → data URL */
    this.thumbs = new Map();
    /** Счётчик для имён «Слой 2» */
    this.#nameCounter = 1;
  }

  #nameCounter = 1;

  /* ─── Снимки стека для истории ──────────────────────────────── */

  snapshot() {
    return this.doc.layers.map((l) => ({ ref: l, meta: l.serialize() }));
  }

  restore(snap) {
    for (const s of snap) s.ref.applyMeta(s.meta);
    this.doc.layers = snap.map((s) => s.ref);
    if (!this.doc.layerById(this.doc.activeLayerId)) {
      this.doc.activeLayerId = this.doc.layers.at(-1)?.id ?? null;
    }
    this.emit('change', { structural: true });
    this.doc.emit('activeLayer', this.doc.activeLayer);
  }

  /** Оборачивает изменение стела в команду истории */
  structural(label, fn) {
    const before = this.snapshot();
    const result = fn();
    const after = this.snapshot();
    this.history.execute(new CallbackCommand(label,
      () => this.restore(after),
      () => this.restore(before)));
    return result;
  }

  /** То же, но без записи в историю (загрузка файла, новая сессия) */
  structuralSilent(label, fn) {
    const result = fn();
    this.emit('change', { structural: true });
    return result;
  }

  /* ─── Имена ─────────────────────────────────────────────────── */

  nextName(base = 'Слой') {
    const names = new Set(this.doc.layers.map((l) => l.name));
    let n = this.#nameCounter++;
    while (names.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
  }

  /* ─── Создание / удаление ───────────────────────────────────── */

  /**
   * @param {object} [opts]
   * @param {string} [opts.name]
   * @param {string} [opts.aboveId] вставить над этим слоем
   * @param {string} [opts.belowId] вставить под этим слоем
   * @param {Layer}  [opts.copy] содержимое для копирования
   * @param {string} [opts.fill] залить цветом
   * @param {boolean}[opts.record] писать в историю
   */
  addLayer(opts = {}) {
    const { name, aboveId, belowId, copy, fill, record = true, activate = true } = opts;
    const doc = this.doc;

    const create = () => {
      const layer = new Layer(doc.width, doc.height, { name: name || this.nextName() });
      if (copy) layer.copyFrom(copy);
      if (fill) {
        layer.ctx.fillStyle = fill;
        layer.ctx.fillRect(0, 0, doc.width, doc.height);
        layer.markDirty();
      }
      let idx = doc.layers.length;
      if (aboveId) {
        const i = doc.indexOf(aboveId);
        if (i >= 0) idx = i + 1;
      } else if (belowId) {
        const i = doc.indexOf(belowId);
        if (i >= 0) idx = i;
      }
      doc.layers.splice(idx, 0, layer);
      if (activate) doc.activeLayerId = layer.id;
      return layer;
    };

    const layer = record ? this.structural('Новый слой', create) : create();
    this.thumbs.delete(layer.id);
    this.emit('change', { structural: true });
    doc.touch();
    return layer;
  }

  deleteLayer(id, { record = true } = {}) {
    const doc = this.doc;
    const idx = doc.indexOf(id);
    if (idx < 0) return null;
    const doDelete = () => {
      const [removed] = doc.layers.splice(idx, 1);
      // Перенаправляем клиппинг-маски с удаляемого слоя на его основу
      for (const l of doc.layers) if (l.clipTo === removed.id) l.clipTo = removed.clipTo;
      if (doc.activeLayerId === removed.id) {
        doc.activeLayerId = doc.layers[Math.min(idx, doc.layers.length - 1)]?.id ?? null;
      }
      this.thumbs.delete(removed.id);
      this.emit('change', { structural: true });
      doc.touch();
      return removed;
    };
    return record ? this.structural('Удалить слой', doDelete) : doDelete();
  }

  duplicateLayer(id, { record = true } = {}) {
    const layer = this.doc.layerById(id);
    if (!layer) return null;
    return this.addLayer({ name: `${layer.name} копия`, copy: layer, aboveId: id, record });
  }

  /** Перемещение слоя в стеке: delta > 0 — вверх по экрану (к началу массива) */
  moveLayer(id, delta, { record = true } = {}) {
    const doc = this.doc;
    const from = doc.indexOf(id);
    const to = from + (delta > 0 ? -Math.abs(delta) : Math.abs(delta));
    if (from < 0 || to < 0 || to >= doc.layers.length) return false;
    if (from === to) return false;
    const fn = () => {
      const [l] = doc.layers.splice(from, 1);
      doc.layers.splice(to, 0, l);
      this.emit('change', { structural: true });
      doc.touch();
    };
    if (record) this.structural('Порядок слоёв', fn); else fn();
    return true;
  }

  /** Перестановка слоя на конкретную позицию (drag & drop в списке) */
  reorderLayer(id, toIndex, { record = true } = {}) {
    const doc = this.doc;
    const from = doc.indexOf(id);
    if (from < 0) return false;
    const fn = () => {
      const [l] = doc.layers.splice(from, 1);
      doc.layers.splice(Math.max(0, Math.min(toIndex, doc.layers.length)), 0, l);
      this.emit('change', { structural: true });
      doc.touch();
    };
    if (record) this.structural('Порядок слоёв', fn); else fn();
    return true;
  }

  /* ─── Свойства ──────────────────────────────────────────────── */

  /**
   * Меняет набор свойств слоя одним шагом истории.
   * @param {string} label
   * @param {string} id
   * @param {object} patch { name, visible, opacity, blendMode, clipTo, locked }
   * @param {object} [opts] { record = false } — для перетаскивания слайдера
   */
  setProps(label, id, patch, { record = false } = {}) {
    const layer = this.doc.layerById(id);
    if (!layer) return null;
    const apply = () => {
      Object.assign(layer, patch);
      layer.markDirty();
      this.emit('change', { structural: false, layer });
      this.doc.touch();
    };
    if (record) this.structural(label, apply); else apply();
    return layer;
  }

  setOpacity(id, v, opts) { return this.setProps('Непрозрачность', id, { opacity: v }, opts); }
  setVisible(id, v, opts) { return this.setProps(v ? 'Показать слой' : 'Скрыть слой', id, { visible: v }, opts); }
  setBlendMode(id, v, opts) { return this.setProps('Режим наложения', id, { blendMode: v }, opts); }
  setClipTo(id, v, opts) { return this.setProps('Маска слоя', id, { clipTo: v }, opts); }
  setLocked(id, v, opts) { return this.setProps('Блокировка', id, { locked: v }, opts); }
  setAlphaLocked(id, v, opts) { return this.setProps('Блокировка прозрачности', id, { alphaLocked: v }, opts); }
  rename(id, name, opts) { return this.setProps('Переименование', id, { name }, opts); }

  select(id) {
    if (!this.doc.layerById(id)) return;
    this.doc.setActiveLayer(id);
    this.emit('select', id);
  }

  /* ─── Очистка ───────────────────────────────────────────────── */

  /** Очищает слой, записывая изменение в историю (использует PixelCommand) */
  clearLayer(layer, { record = true } = {}) {
    const rect = { x: 0, y: 0, w: this.doc.width, h: this.doc.height };
    if (!record) {
      layer.clear();
      this.emit('change', { structural: false, layer });
      this.doc.touch();
      return;
    }
    const cmd = new PixelCommand(layer, rect, 'Очистить слой');
    layer.clear();
    this.history.execute(cmd);
    this.emit('change', { structural: false, layer });
    this.doc.touch();
  }

  /* ─── Слияние ───────────────────────────────────────────────── */

  /** Объединить слой со слоем под ним */
  mergeDown(id, { record = true } = {}) {
    const doc = this.doc;
    const idx = doc.indexOf(id);
    if (idx <= 0) return false;   // нижний слой объединять не с чем

    const top = doc.layers[idx];
    const bottom = doc.layers[idx - 1];

    const run = () => {
      const ctx = bottom.ctx;
      ctx.save();
      ctx.globalAlpha = top.opacity;
      ctx.globalCompositeOperation = top.blendMode in NATIVE ? top.blendMode : 'source-over';
      ctx.drawImage(top.canvas, 0, 0);
      ctx.restore();
      bottom.markDirty();
      this.thumbs.delete(bottom.id);
    };

    const remove = () => {
      doc.layers.splice(doc.indexOf(top.id), 1);
      for (const l of doc.layers) if (l.clipTo === top.id) l.clipTo = bottom.id;
      if (doc.activeLayerId === top.id) doc.activeLayerId = bottom.id;
      this.thumbs.delete(top.id);
    };

    if (record) {
      const before = this.snapshot();
      run();
      remove();
      const after = this.snapshot();
      this.history.execute(new CallbackCommand('Объединить вниз',
        () => this.restore(after), () => this.restore(before)));
    } else {
      run();
      remove();
    }
    this.emit('change', { structural: true });
    doc.touch();
    return true;
  }

  /** Сплющить видимые слои в один (alpha заменяется фоном документа) */
  flatten({ record = true } = {}) {
    const doc = this.doc;
    const visible = doc.layers.filter((l) => l.visible);
    if (visible.length < 1) return false;

    const run = () => {
      const merged = new Layer(doc.width, doc.height, { name: 'Фон' });
      const mctx = merged.ctx;
      if (doc.background && doc.background !== 'transparent') {
        mctx.fillStyle = doc.background;
        mctx.fillRect(0, 0, doc.width, doc.height);
      }
      for (const l of visible) {
        mctx.save();
        mctx.globalAlpha = l.opacity;
        mctx.globalCompositeOperation = l.blendMode in NATIVE ? l.blendMode : 'source-over';
        mctx.drawImage(l.canvas, 0, 0);
        mctx.restore();
      }
      doc.layers = [merged];
      doc.activeLayerId = merged.id;
      merged.markDirty();
      return merged;
    };

    if (record) {
      const before = this.snapshot();
      run();
      const after = this.snapshot();
      this.history.execute(new CallbackCommand('Сплющить',
        () => this.restore(after), () => this.restore(before)));
    } else {
      run();
    }
    this.emit('change', { structural: true });
    doc.touch();
    return true;
  }

  /* ─── Превью ────────────────────────────────────────────────── */

  async getThumb(layer, size = 64) {
    if (this.thumbs.has(layer.id)) return this.thumbs.get(layer.id);
    const url = await layer.thumb(size);
    if (this.thumbs.has(layer.id)) return this.thumbs.get(layer.id);
    this.thumbs.set(layer.id, url);
    return url;
  }

  invalidateThumb(layerId) {
    this.thumbs.delete(layerId);
  }

  invalidateAllThumbs() {
    this.thumbs.clear();
  }
}

// Список режимов, поддерживаемых Canvas2D без ручного смешивания
const NATIVE = new Set([
  'source-over', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion',
]);