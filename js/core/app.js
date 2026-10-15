/**
 * Ядро приложения: собирает все подсистемы, хранит состояние,
 * и предоставляет инструменты. Основной «сервис-локатор» — всё остальное
 * общается с ним.
 */

import { Emitter } from './emitter.js';
import { createDocument } from './doc.js';
import { Viewport } from './viewport.js';
import { Renderer } from './renderer.js';
import { History, PixelCommand } from './history.js';
import { Layer, createLayerCanvas } from './layer.js';
import { LayerManager } from './layer-manager.js';
import { Selection } from './selection.js';
import { StrokeEngine, createStrokeBufferStore } from './stroke-engine.js';
import { makeBrush, setDefaultBrushColor, cloneBrush, PRESETS } from './brush.js';
import { config } from './config.js';
import { intersectRect, clamp } from '../utils/math.js';
import { rgbToHex, parseColor, pushRecent, loadRecent } from '../utils/color.js';
import { debounce } from '../utils/dom.js';
import { brushTool } from '../tools/brush-tool.js';
import { eraserTool } from '../tools/eraser-tool.js';
import { fillTool } from '../tools/fill-tool.js';
import { gradientTool } from '../tools/gradient-tool.js';
import { eyedropperTool } from '../tools/eyedropper-tool.js';
import { marqueeTool } from '../tools/marquee-tool.js';
import { moveTool } from '../tools/move-tool.js';
import { panTool } from '../tools/pan-tool.js';

export class App extends Emitter {
  constructor({ stage, viewCanvas, overlayCanvas }) {
    super();

    this.stage = stage;
    this.viewport = new Viewport();
    this.doc = createDocument({ width: 1600, height: 1000, name: 'Без имени' });
    this.history = new History(config.HISTORY_LIMIT);
    this.layers = new LayerManager(this.doc, this.history);
    this.selection = new Selection(this.doc);
    this.renderer = new Renderer(this, { viewCanvas, overlayCanvas, viewport: this.viewport });

    this.strokeBuffers = createStrokeBufferStore();
    this.stroke = new StrokeEngine({
      getBuffer: () => this.strokeBuffers.getBuffer(this.doc.width, this.doc.height),
    });

    /* Состояние инструментов и цвета */
    this.color = { fg: { r: 24, g: 26, b: 32 }, bg: { r: 255, g: 255, b: 255 } };
    this.brush = makeBrush({ ...PRESETS[5], size: 34, hardness: 0.75 });
    this.eraserBrush = makeBrush({ type: 'eraser', size: 60, hardness: 0.6, composite: 'destination-out' });
    this.tools = new Map();
    this.toolId = 'brush';
    this.tool = null;

    this.dirtySinceSave = false;
    this.projectId = null;
    this.saving = false;
    /** Цвет под курсором для пипетки (кэш — не читаем пиксели каждый кадр) */
    this.hoverColor = null;
    /** Кэш «недавних» цветов для панели */
    this.recentColors = loadRecent();

    this._raf = 0;
    this._lastFrame = performance.now();

    this.autosave = debounce(() => this.emit('autosave'), config.AUTOSAVE_DEBOUNCE);
  }

  /* ─── Запуск ─────────────────────────────────────────────────── */

  init() {
    this.#registerTools();
    this.setTool('brush');
    this.#wireCoreEvents();
    this.#loop();

    // Первое отображение
    this.viewport.fit(this.doc.width, this.doc.height);
    this.renderer.invalidate();
    this.emit('ready');
    return this;
  }

  #registerTools() {
    this.tools.set('brush', brushTool(this));
    this.tools.set('eraser', eraserTool(this));
    this.tools.set('fill', fillTool(this));
    this.tools.set('gradient', gradientTool(this));
    this.tools.set('eyedropper', eyedropperTool(this));
    this.tools.set('marquee', marqueeTool(this));
    this.tools.set('move', moveTool(this));
    this.tools.set('pan', panTool(this));
  }

  #wireCoreEvents() {
    // Изменение вида → полная перерисовка
    this.viewport.on('change', () => this.renderer.invalidate());

    // Стек слоёв и выделение пересоздаются при смене документа,
    // поэтому внешний код подписывается на события App, а не на сами объекты
    this.#subscribeLayers(this.layers);
    this.#subscribeSelection(this.selection);

    this.history.on('change', (state) => {
      this.renderer.invalidate();
      this.emit('history', state);
      this.markChanged();
    });

    // Отмена штриха правой кнопкой мыши
    this.stage.addEventListener('contextmenu', (e) => {
      if (this.stroke.active) { this.cancelStroke(); e.preventDefault(); }
    });

    this.#bindDoc(this.doc);
  }

  /** Подписка App на конкретный менеджер слоёв (он пересоздаётся) */
  #subscribeLayers(manager) {
    manager.on('change', ({ structural, layer } = {}) => {
      this.renderer.invalidate();
      if (structural) manager.invalidateAllThumbs();
      this.emit('layers', { structural, layer });
      this.markChanged();
    });
  }

  /** Подписка App на конкретный объект выделения (он пересоздаётся) */
  #subscribeSelection(selection) {
    selection.on('change', () => this.emit('selection'));
  }

  /** Подписка на события документа (он пересоздаётся при открытии файла) */
  #bindDoc(doc) {
    doc.on('resize', () => {
      this.renderer.invalidate();
      this.viewport.fit(doc.width, doc.height);
      this.emit('doc');
    });
  }

  /** Главный цикл: композитинг + оверлей */
  #loop = () => {
    this._raf = requestAnimationFrame(this.#loop);
    const now = performance.now();
    const dt = now - this._lastFrame;
    this._lastFrame = now;

    if (this.renderer.render()) this.emit('painted');
    this.renderer.renderOverlay(dt);
  };

  destroy() {
    cancelAnimationFrame(this._raf);
    this.renderer.clear();
    this.viewport.clear();
  }

  /* ─── Документ ──────────────────────────────────────────────── */

  /** Заменяет документ (новая картинка, открытие файла) */
  setDocument(doc, { keepView = false } = {}) {
    this.cancelStroke();
    this.doc = doc;
    this.projectId = null;
    this.history.clear();

    this.layers = new LayerManager(doc, this.history);
    this.#subscribeLayers(this.layers);
    this.selection = new Selection(doc);
    this.#subscribeSelection(this.selection);
    this.#bindDoc(doc);

    if (!keepView) this.viewport.fit(doc.width, doc.height);
    this.renderer.invalidate();
    this.emit('doc');
    this.emit('layers', { structural: true });
    this.emit('selection');
  }

  resizeDocument(width, height, anchor = 'center') {
    this.doc.resize(width, height, { anchor });
    this.emit('doc');
  }

  /* ─── Инструменты ────────────────────────────────────────────── */

  setTool(id) {
    if (!this.tools.has(id)) return;
    if (this.tool?.onDeactivate) this.tool.onDeactivate();
    if (this.stroke.active) this.commitStroke();

    this.toolId = id;
    this.tool = this.tools.get(id);
    this.renderer.cursorRadius = this.cursorRadius;
    this.stage.dataset.cursor = this.tool.cursor || 'crosshair';
    if (this.tool.onActivate) this.tool.onActivate();
    this.emit('tool', id);
  }

  get activeBrush() {
    return this.toolId === 'eraser' ? this.eraserBrush : this.brush;
  }

  /** Радиус кисти для курсора (мировые единицы) */
  get cursorRadius() {
    if (['brush', 'eraser'].includes(this.toolId)) {
      return Math.max(1, this.activeBrush.size) / 2;
    }
    return 0;
  }

  setBrush(patch) {
    Object.assign(this.brush, patch);
    if (patch.color) setDefaultBrushColor(patch.color);
    this.renderer.cursorRadius = this.cursorRadius;
    this.emit('brush');
  }

  setEraserBrush(patch) {
    Object.assign(this.eraserBrush, patch);
    this.emit('brush');
  }

  resetBrushToPreset(preset) {
    const { name, ...rest } = preset;
    this.brush = makeBrush({ ...rest, color: { ...this.color.fg } });
    setDefaultBrushColor(this.color.fg);
    this.renderer.cursorRadius = this.cursorRadius;
    this.emit('brush');
  }

  /* ─── Цвет ───────────────────────────────────────────────────── */

  setColor(rgb, which = 'fg') {
    this.color[which] = { ...rgb };
    if (which === 'fg') {
      this.brush.color = { ...rgb };
      setDefaultBrushColor(rgb);
      this._recent = pushRecent(rgbToHex(rgb));
      this.recentColors = this._recent;
      this.emit('recent', this._recent);
    }
    this.emit('color');
  }

  swapColors() {
    const { fg, bg } = this.color;
    this.setColor(bg, 'fg');
    this.setColor(fg, 'bg');
  }

  get fgHex() { return rgbToHex(this.color.fg); }
  get bgHex() { return rgbToHex(this.color.bg); }

  setFgHex(hex) {
    const rgb = parseColor(hex);
    if (rgb) this.setColor(rgb, 'fg');
    return rgb;
  }

  /* ─── Штрих ──────────────────────────────────────────────────── */

  beginStroke(point, { composite = 'source-over', tool = 'brush' } = {}) {
    const layer = this.doc.activeLayer;
    if (!layer) return false;
    if (layer.locked && tool === 'brush') return false;
    // Страховка от «залипшего» предыдущего штриха (он держит ctx.save())
    if (this.stroke.active) this.cancelStroke();
    const brush = tool === 'eraser' ? this.eraserBrush : this.brush;

    this.stroke.begin({
      layer,
      brush: cloneBrush(brush),
      point,
      composite,
      selection: this.selection,
    });
    this.renderer.liveStroke = this.stroke.buffer
      ? { buffer: this.stroke.buffer, composite, dirty: this.stroke.getDirtyRect() }
      : null;   // прямой режим: пиксели уже в слое
    this.renderer.invalidate();
    return true;
  }

  extendStroke(points) {
    if (!this.stroke.active) return;
    this.stroke.extend(points);
    if (this.renderer.liveStroke) this.renderer.liveStroke.dirty = this.stroke.getDirtyRect();
  }

  /** Финализирует штрих: записывает буфер в слой и создаёт шаг истории */
  commitStroke(label = 'Рисование') {
    if (!this.stroke.active) return null;
    const result = this.stroke.finish();
    this.renderer.liveStroke = null;
    if (!result?.dirty) { this.renderer.invalidate(); return null; }

    const layer = this.doc.activeLayer;
    if (!layer) return null;

    // Область изменения: пересечение с документом и выделением
    let rect = intersectRect(result.dirty, this.selection.clipRect());
    if (!rect || rect.w < 1 || rect.h < 1) { this.renderer.invalidate(); return null; }
    rect = { x: Math.floor(rect.x), y: Math.floor(rect.y), w: Math.ceil(rect.w), h: Math.ceil(rect.h) };

    // Прямой режим (холст больше 4096²): пиксели уже записаны в слой,
    // история для таких штрихов не пишется — см. Фазу 4 (тайлы)
    if (result.direct) {
      this.renderer.addDirty(rect);
      this.emit('stroke');
      this.markChanged();
      return null;
    }

    const cmd = new PixelCommand(layer, rect, label);

    // Произвольная форма выделения обрезается альфа-маской, прямоугольная — clip'ом.
    // ВАЖНО: applyMask() возвращает патч РАЗМЕРОМ rect (начало координат — 0,0),
    // а буфер штриха — размером с документ. Поэтому координаты источника
    // в drawImage разные: у патча 0, у буфера — как у документа.
    const masked = !!this.selection.mask;
    const source = masked
      ? this.selection.applyMask(result.buffer.canvas, rect)
      : result.buffer.canvas;
    const srcX = masked ? 0 : rect.x;
    const srcY = masked ? 0 : rect.y;

    const ctx = layer.ctx;
    ctx.save();
    try {
      if (this.selection.active && !masked) this.selection.clipContext(ctx);
      ctx.globalCompositeOperation = result.composite;
      ctx.drawImage(source, srcX, srcY, rect.w, rect.h, rect.x, rect.y, rect.w, rect.h);
    } finally {
      ctx.restore();
    }
    layer.markDirty(rect);

    // capture() снимает состояние «после» — без него повтор не сработает
    this.history.execute(cmd.capture());
    this.renderer.addDirty(rect);
    this.emit('stroke');
    this.markChanged();
    return cmd;
  }

  cancelStroke() {
    this.stroke.cancel();
    this.renderer.liveStroke = null;
    this.renderer.invalidate();
  }

  /* ─── Прочее ─────────────────────────────────────────────────── */

  markChanged() {
    this.dirtySinceSave = true;
    this.invalidateSampler();
    document.getElementById('app')?.classList.add('is-dirty');
    this.emit('changed');
    this.autosave();
  }

  markSaved() {
    this.dirtySinceSave = false;
    document.getElementById('app')?.classList.remove('is-dirty');
    this.emit('saved');
  }

  /**
   * Пиксель итогового изображения под точкой (для пипетки).
   *
   * Экранный canvas не годится: он непрозрачный (залит фоном и «шахматкой»),
   * поэтому альфы в нём нет. Держим отдельный «сэмплер» того же размера,
   * что и документ: он перерисовывается только когда композит изменился,
   * а читать из него — O(1).
   */
  sampleComposite(wx, wy) {
    const doc = this.doc;
    const x = Math.floor(wx);
    const y = Math.floor(wy);
    if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return null;

    const s = this.#sampler(doc);
    if (!s) return null;
    if (this._samplerDirty) {
      s.clearRect(0, 0, doc.width, doc.height);
      for (const layer of doc.layers) {
        if (!layer.visible || layer.opacity <= 0) continue;
        s.save();
        try {
          s.globalAlpha = layer.opacity;
          s.globalCompositeOperation = layer.blendMode;
          s.drawImage(layer.canvas, 0, 0);
        } finally {
          s.restore();
        }
      }
      this._samplerDirty = false;
    }

    const d = s.getImageData(x, y, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
  }

  /** Контекст «сэмплера» того же размера, что и документ */
  #sampler(doc) {
    if (!this._sampler || this._sampler.width !== doc.width || this._sampler.height !== doc.height) {
      this._sampler = createLayerCanvas(doc.width, doc.height);
      this._samplerCtx = this._sampler.getContext('2d', { willReadFrequently: true });
      this._samplerDirty = true;
    }
    return this._samplerCtx;
  }

  /** Пометить композит изменившимся (вызывается после любой правки) */
  invalidateSampler() {
    this._samplerDirty = true;
  }

  /** Экспорт итогового изображения в canvas (для сохранения/экспорта) */
  flattenCanvas() {
    const doc = this.doc;
    const c = document.createElement('canvas');
    c.width = doc.width;
    c.height = doc.height;
    const ctx = c.getContext('2d');
    if (doc.background && doc.background !== 'transparent') {
      ctx.fillStyle = doc.background;
      ctx.fillRect(0, 0, doc.width, doc.height);
    }
    for (const layer of doc.layers) {
      if (!layer.visible || layer.opacity <= 0) continue;
      ctx.save();
      ctx.globalAlpha = layer.opacity;
      ctx.globalCompositeOperation = layer.blendMode;
      ctx.drawImage(layer.canvas, 0, 0);
      ctx.restore();
    }
    return c;
  }

  /** Превью документа для галереи */
  async thumbnail(size = config.THUMB_SIZE) {
    const src = this.flattenCanvas();
    const k = Math.min(size / src.width, size / src.height);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(src.width * k));
    c.height = Math.max(1, Math.round(src.height * k));
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL('image/webp', 0.72);
  }

  get zoom() { return this.viewport.scale; }
  set zoom(v) { this.viewport.setScale(clamp(v, 0.02, 32)); }
}