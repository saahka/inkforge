/**
 * Ввод: Pointer Events (мышь + перо + тач), колесо, клавиатура-модификаторы.
 *
 * Что здесь важно для планшета:
 *  • setPointerCapture — штрих продолжается за пределами холста;
 *  • getCoalescedEvents() — браузер отдаёт все точки, накопленные между
 *    кадрами (до 100+ на кадр при 240 Гц), иначе линии становятся «ломаными»;
 *  • pressure/tiltX/tiltY пробрасываются инструменту без преобразований;
 *  • Alt превращает кисть в пипетку на время нажатия.
 */

import { setShiftHeld } from '../tools/marquee-tool.js';
import { clamp } from '../utils/math.js';

export class InputHandler {
  constructor(app) {
    this.app = app;
    this.spaceHeld = false;
    this.tempTool = null;      // временный инструмент (пипетка по Alt)
    this.activePointer = null;
    this.panning = false;
    this._panLast = null;
    this._bound = [];
  }

  attach(node) {
    const on = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      this._bound.push([target, type, fn, opts]);
    };

    on(node, 'pointerdown', this.#onDown);
    on(node, 'pointermove', this.#onMove);
    on(node, 'pointerup', this.#onUp);
    on(node, 'pointercancel', this.#onCancel);
    on(node, 'pointerleave', this.#onLeave);
    on(node, 'dblclick', this.#onDoubleClick);
    on(node, 'wheel', this.#onWheel, { passive: false });
    on(node, 'contextmenu', (e) => e.preventDefault());
    on(window, 'keydown', this.#onKeyDown);
    on(window, 'keyup', this.#onKeyUp);
    on(window, 'blur', this.#onBlur);
    return this;
  }

  destroy() {
    for (const [t, type, fn, opts] of this._bound) t.removeEventListener(type, fn, opts);
    this._bound.length = 0;
  }

  /* ─── Координаты ─────────────────────────────────────────────── */

  /** Экранные координаты относительно области холста */
  #screen(e) {
    const rect = this.app.stage.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  /** Мировые координаты события */
  #world(e) {
    const s = this.#screen(e);
    return this.app.viewport.screenToWorld(s.x, s.y);
  }

  #baseContext(e, s, w) {
    return {
      x: w.x,
      y: w.y,
      sx: s.x,
      sy: s.y,
      pressure: e.pressure,
      tiltX: e.tiltX || 0,
      tiltY: e.tiltY || 0,
      pointerType: e.pointerType,
      buttons: e.buttons,
      alt: e.altKey,
      shift: e.shiftKey,
      ctrl: e.ctrlKey || e.metaKey,
      meta: e.metaKey,
      event: e,
      points: [],
    };
  }

  /** Все точки кадра (coalesced) в мировых координатах */
  #points(e) {
    const vp = this.app.viewport;
    const rect = this.app.stage.getBoundingClientRect();
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const list = events.length ? events : [e];
    return list.map((ev) => {
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      const w = vp.screenToWorld(x, y);
      return {
        ...w,
        pressure: ev.pressure,
        tiltX: ev.tiltX || 0,
        tiltY: ev.tiltY || 0,
        pointerType: ev.pointerType,
        timeStamp: ev.timeStamp,
      };
    });
  }

  get tool() { return this.tempTool || this.app.tool; }

  /* ─── Обработчики ────────────────────────────────────────────── */

  #onDown = (e) => {
    const app = this.app;
    if (this.activePointer !== null) return;      // игнорируем вторую кнопку

    const s = this.#screen(e);
    const w = this.#world(e);
    app.renderer.cursor = { x: w.x, y: w.y };

    // Средняя кнопка или пробел — панорамирование
    if (e.button === 1 || (this.spaceHeld && e.button === 0)) {
      this.#startPan(e, s);
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;

    this.activePointer = e.pointerId;
    try { app.stage.setPointerCapture(e.pointerId); } catch { /* уже захвачен */ }

    // Alt + кисть/ластик → пипетка на время нажатия
    if (e.altKey && ['brush', 'eraser'].includes(app.toolId)) {
      this.tempTool = app.tools.get('eyedropper');
    }

    const ctx = this.#baseContext(e, s, w);
    ctx.points = [{ ...w, pressure: e.pressure, tiltX: e.tiltX, tiltY: e.tiltY, timeStamp: e.timeStamp }];
    this.tool.onPointerDown?.(ctx);
    e.preventDefault();
  };

  #onMove = (e) => {
    const app = this.app;
    const s = this.#screen(e);
    const w = this.#world(e);
    app.renderer.cursor = { x: w.x, y: w.y };
    // Давление пера нужно кольцу курсора: при включённой динамике
    // оно показывает «текущий» размер кисти, а не максимальный
    app.renderer.cursorPressure = e.pointerType === 'mouse'
      ? 1
      : clamp(e.pressure || 0, 0, 1);
    app.renderer.cursorTilt = clamp(Math.hypot(e.tiltX || 0, e.tiltY || 0) / 90, 0, 1);
    app.emit('cursor', { world: w, screen: s, pointerType: e.pointerType, pressure: e.pressure });

    if (this.panning) {
      app.viewport.panBy(e.clientX - this._panLast.x, e.clientY - this._panLast.y);
      this._panLast = { x: e.clientX, y: e.clientY };
      return;
    }

    if (this.activePointer !== e.pointerId) return;

    const ctx = this.#baseContext(e, s, w);
    ctx.points = this.#points(e);
    this.tool.onPointerMove?.(ctx);
  };

  #onUp = (e) => {
    if (this.panning && (e.button === 1 || this.spaceHeld)) {
      this.#endPan();
      return;
    }
    if (this.activePointer !== e.pointerId) return;

    const s = this.#screen(e);
    const w = this.#world(e);
    const ctx = this.#baseContext(e, s, w);
    ctx.points = [{ ...w, pressure: e.pressure, timeStamp: e.timeStamp }];

    this.tool.onPointerUp?.(ctx);
    this.tempTool = null;
    this.activePointer = null;
    try { app.stage.releasePointerCapture(e.pointerId); } catch { /* нечего отпускать */ }
  };

  #onCancel = (e) => {
    if (this.panning) { this.#endPan(); return; }
    if (this.activePointer !== e.pointerId) return;
    this.tool.onPointerCancel?.();
    this.tempTool = null;
    this.activePointer = null;
  };

  #onLeave = () => {
    if (this.activePointer === null && !this.panning) {
      this.app.renderer.cursor = null;
    }
  };

  #onDoubleClick = (e) => {
    const w = this.#world(e);
    const s = this.#screen(e);
    this.app.tool.onDoubleClick?.(this.#baseContext(e, s, w));
  };

  #onWheel = (e) => {
    e.preventDefault();
    const s = this.#screen(e);

    // Ctrl/⌘ + колесо (и пинч-жест трекпада) — зум
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.exp(-e.deltaY * 0.0022);
      this.app.viewport.zoomAt(s.x, s.y, factor);
      this.app.emit('zoom', this.app.viewport.zoomPercent);
      return;
    }

    // Обычное колесо — панорамирование (как в Photoshop)
    const dx = e.shiftKey ? (e.deltaY || e.deltaX) : (e.deltaX || 0);
    const dy = e.shiftKey ? 0 : e.deltaY;
    this.app.viewport.panBy(-dx, -dy);
  };

  /* ─── Панорамирование ────────────────────────────────────────── */

  #startPan(e, s) {
    this.panning = true;
    this._panLast = { x: e.clientX, y: e.clientY };
    this._panPointer = e.pointerId;
    this.app.stage.dataset.cursor = 'grabbing';
    try { this.app.stage.setPointerCapture(e.pointerId); } catch { /* игнор */ }
  }

  #endPan() {
    this.panning = false;
    this._panLast = null;
    // Освобождаем захват пера: иначе события продолжают идти в холст
    if (this._panPointer !== null && this._panPointer !== undefined) {
      try { this.app.stage.releasePointerCapture(this._panPointer); } catch { /* нечего отпускать */ }
      this._panPointer = null;
    }
    this.app.stage.dataset.cursor = this.app.tool.cursor || 'crosshair';
  }

  /* ─── Клавиатура ─────────────────────────────────────────────── */

  #onKeyDown = (e) => {
    if (e.code === 'Space' && !this.spaceHeld) {
      this.spaceHeld = true;
      this.app.stage.dataset.cursor = 'grab';
    }
    setShiftHeld(e.shiftKey);
  };

  #onKeyUp = (e) => {
    if (e.code === 'Space') {
      this.spaceHeld = false;
      if (!this.panning) this.app.stage.dataset.cursor = this.app.tool.cursor || 'crosshair';
    }
    setShiftHeld(e.shiftKey);
  };

  #onBlur = () => {
    this.spaceHeld = false;
    setShiftHeld(false);
  };
}