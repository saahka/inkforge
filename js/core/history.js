/**
 * История отмены/повтора.
 *
 * Два типа команд:
 *   • PixelCommand  — меняет пиксели слоя внутри прямоугольника (кисть, заливка).
 *     Хранит «до» и «после» только для затронутой области, поэтому дешёвый.
 *   • SnapshotCommand — меняет стек слоёв (добавление, удаление, порядок, свойства).
 *     Хранит снимок метаданных; сами canvas'ы переиспользуются, не копируются.
 */

import { Emitter } from './emitter.js';

export class PixelCommand {
  /**
   * @param {import('./layer.js').Layer} layer
   * @param {{x,y,w,h}} rect область изменения в координатах документа
   * @param {string} label подпись для панели истории
   */
  constructor(layer, rect, label = 'Рисование') {
    this.type = 'pixel';
    this.label = label;
    this.layerId = layer.id;
    this.layer = layer;
    this.rect = { x: Math.floor(rect.x), y: Math.floor(rect.y), w: Math.ceil(rect.w), h: Math.ceil(rect.h) };
    this.before = layer.getImageData(this.rect);
    this.after = null;
  }

  /** Снимок «после» делается один раз — в конце штриха */
  capture() {
    this.after = this.layer.getImageData(this.rect);
    this.layer.markDirty(this.rect);
    return this;
  }

  do() {
    if (this.after) this.layer.putImageData(this.after, this.rect.x, this.rect.y);
    this.layer.markDirty(this.rect);
  }

  undo() {
    this.layer.putImageData(this.before, this.rect.x, this.rect.y);
  }

  get bytes() { return this.rect.w * this.rect.h * 4 * 2; }
}

export class CallbackCommand {
  /**
   * @param {string} label
   * @param {() => void} doFn
   * @param {() => void} undoFn
   */
  constructor(label, doFn, undoFn, bytes = 0) {
    this.type = 'callback';
    this.label = label;
    this._do = doFn;
    this._undo = undoFn;
    this._bytes = bytes;
  }

  do() { this._do(); }
  undo() { this._undo(); }
  get bytes() { return this._bytes; }
}

/**
 * Стек истории. Хранит и выполненные, и отменённые команды:
 * текущая позиция — cursor.
 */
export class History extends Emitter {
  constructor(limit = 100, byteLimit = 192 * 1024 * 1024) {
    super();
    this.limit = limit;
    this.byteLimit = byteLimit;
    /** @type {(PixelCommand|CallbackCommand)[]} */
    this.entries = [];
    this.cursor = 0;      // число выполненных команд
    this.dirtyIndex = -1; // индекс команды, начиная с которой история «обрезана»
  }

  /** Выполнить команду и записать её в стек */
  execute(command) {
    command.do();
    this.push(command);
    return command;
  }

  /** Записать уже выполненную команду (используется инструментами после штриха) */
  push(command) {
    this.entries.length = this.cursor;   // отбрасываем отменённый «хвост»
    this.entries.push(command);
    this.cursor = this.entries.length;
    this.#trim();
    this.emit('change', this.state());
    return command;
  }

  /** Метка операции без выполнения — для UI (например, «Отменить кисть») */
  peekLabel() {
    return this.cursor > 0 ? this.entries[this.cursor - 1].label : null;
  }

  canUndo() { return this.cursor > 0; }
  canRedo() { return this.cursor < this.entries.length; }

  undo() {
    if (!this.canUndo()) return null;
    const cmd = this.entries[--this.cursor];
    cmd.undo();
    this.dirtyIndex = -1;
    this.emit('change', this.state());
    this.emit('undo', cmd);
    return cmd;
  }

  redo() {
    if (!this.canRedo()) return null;
    const cmd = this.entries[this.cursor++];
    cmd.do();
    this.dirtyIndex = -1;
    this.emit('change', this.state());
    this.emit('redo', cmd);
    return cmd;
  }

  /** Переход к произвольному шагу (клик по панели истории) */
  goto(index) {
    if (index < 0 || index > this.entries.length) return;
    while (this.cursor > index) { this.entries[--this.cursor].undo(); }
    while (this.cursor < index) { this.entries[this.cursor++].do(); }
    this.dirtyIndex = -1;
    this.emit('change', this.state());
  }

  clear() {
    this.entries.length = 0;
    this.cursor = 0;
    this.dirtyIndex = -1;
    this.emit('change', this.state());
  }

  get bytes() {
    let sum = 0;
    for (const e of this.entries) sum += e.bytes || 0;
    return sum;
  }

  state() {
    return {
      entries: this.entries.map((e) => e.label),
      cursor: this.cursor,
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
      bytes: this.bytes,
    };
  }

  /** Обрезает историю по числу шагов и по памяти */
  #trim() {
    while (this.entries.length > this.limit) this.entries.shift();
    while (this.entries.length > 1 && this.bytes > this.byteLimit) this.entries.shift();
    this.cursor = this.entries.length;
  }
}