/**
 * Библиотека готовых работ.
 *
 * Это «папка с результатами»: каждый раз, когда картинка доведена до ума,
 * её можно закинуть сюда одним действием (Ctrl+Shift+L) — и потом вернуться
 * к любой работе: открыть связанный проект и продолжить, скачать картинку
 * в другом формате или просто посмотреть.
 *
 * Где что лежит:
 *   artworks      — метаданные + превью (легко тянуть весь список)
 *   artworkImages — полноразмерный PNG по id (тяжёлый, нужен по запросу)
 *
 * Автосохранение: capture() можно вызывать после каждого экспорта —
 * тогда библиотека пополняется сама (переключатель в меню и панели).
 */

import { Emitter } from '../core/emitter.js';
import { uid } from '../utils/math.js';
import { canvasToBlob, downloadBlob, loadImageBitmap } from '../utils/dom.js';
import { exportImage, supportsFsAccess, saveBlobAs } from '../utils/file.js';
import { createDocument } from '../core/doc.js';
import { Layer } from '../core/layer.js';
import { projectStore } from './project-store.js';

const STORE_ARTWORKS = 'artworks';
const STORE_ART_IMAGES = 'artworkImages';
const THUMB_WIDTH = 360;
const AUTOSAVE_KEY = 'inkforge.library.autosave';

/** Снимок холста в data URL для превью */
async function makeThumb(canvas, width = THUMB_WIDTH) {
  const k = Math.min(width / canvas.width, width / canvas.height, 1);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(canvas.width * k));
  c.height = Math.max(1, Math.round(canvas.height * k));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  // Прозрачность показываем «шахматкой» — так превью читается на любом фоне
  ctx.fillStyle = '#20242c';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL('image/webp', 0.75);
}

export class Library extends Emitter {
  /** @param {import('./project-store.js').ProjectStore} store */
  constructor(store) {
    super();
    this.store = store;
    /** @type {Array<object>} метаданные работ, отсортированные по дате */
    this.items = [];
    this.autoSave = (() => {
      try { return localStorage.getItem(AUTOSAVE_KEY) === '1'; } catch { return false; }
    })();
    this.loaded = false;
    /** Счётчик изменений: защищает от гонки «load() поверх правки» */
    this._rev = 0;
    this._loading = null;
  }

  /** Любое изменение списка увеличивает счётчик */
  #touch() { this._rev++; }

  /* ─── Загрузка списка ──────────────────────────────────────── */

  /**
   * Перечитывает список из базы.
   * Параллельные вызовы схлопываются в один, а результат не применяется,
   * если во время чтения список успели изменить (иначе load() «воскресил»
   * только что удалённые работы).
   */
  async load() {
    if (this._loading) { await this._loading; return this.items; }
    const rev = this._rev;
    this._loading = (async () => {
      const all = this.store.available
        ? await this.store.tx(STORE_ARTWORKS, 'readonly', (s) => s.getAll()).catch(() => [])
        : [];
      if (this._rev !== rev) return;          // пока читали — список изменился
      this.items = (all || []).sort((a, b) => b.updatedAt - a.updatedAt);
      this.loaded = true;
      this.emit('change', { items: this.items });
    })();

    try {
      await this._loading;
    } finally {
      this._loading = null;
      this.loaded = true;
    }
    return this.items;
  }

  async ensureLoaded() {
    if (!this.loaded) await this.load();
    return this.items;
  }

  get(id) { return this.items.find((a) => a.id === id) || null; }

  /* ─── Сохранение работы ────────────────────────────────────── */

  /**
   * Кладёт текущее изображение в библиотеку.
   * @param {object} app
   * @param {object} [opts] { title, note, tags, projectId }
   * @returns {Promise<object>} запись библиотеки
   */
  async capture(app, opts = {}) {
    if (!this.store.available) throw new Error('Библиотека недоступна: IndexedDB заблокирована');

    const flat = app.flattenCanvas();
    const blob = await canvasToBlob(flat, 'image/png');
    const thumb = await makeThumb(flat);

    const record = {
      id: uid('art'),
      title: (opts.title || app.doc.name || 'Без имени').trim() || 'Без имени',
      note: opts.note || '',
      tags: opts.tags || [],
      width: flat.width,
      height: flat.height,
      thumb,
      // Ссылка на проект: если он есть, работу можно открыть со слоями
      projectId: opts.projectId !== undefined ? opts.projectId : (app.projectId || null),
      starred: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await this.store.bulk(STORE_ARTWORKS, 'readwrite', [record]);
    await this.store.bulk(STORE_ART_IMAGES, 'readwrite', [{ id: record.id, blob }]);

    this.items.unshift(record);
    this.#touch();
    this.emit('change', { added: record });
    return record;
  }

  /** Заменяет изображение уже существующей работы (пересохранение) */
  async recapture(app, id) {
    const record = this.get(id);
    if (!record) throw new Error('Работа не найдена');
    const flat = app.flattenCanvas();
    const blob = await canvasToBlob(flat, 'image/png');
    const thumb = await makeThumb(flat);
    const next = {
      ...record,
      width: flat.width,
      height: flat.height,
      thumb,
      updatedAt: Date.now(),
    };
    await this.store.bulk(STORE_ARTWORKS, 'readwrite', [next]);
    await this.store.bulk(STORE_ART_IMAGES, 'readwrite', [{ id, blob }]);
    this.items = this.items.map((a) => (a.id === id ? next : a));
    this.emit('change', { updated: next });
    return next;
  }

  /* ─── Изменение метаданных ─────────────────────────────────── */

  async update(id, patch) {
    const record = this.get(id);
    if (!record) return null;
    const next = { ...record, ...patch, updatedAt: Date.now() };
    await this.store.bulk(STORE_ARTWORKS, 'readwrite', [next]);
    this.items = this.items.map((a) => (a.id === id ? next : a));
    this.#touch();
    this.emit('change', { updated: next });
    return next;
  }

  setTitle(id, title) { return this.update(id, { title: title.trim() || 'Без имени' }); }
  setNote(id, note) { return this.update(id, { note }); }
  toggleStar(id) {
    const record = this.get(id);
    if (!record) return null;
    return this.update(id, { starred: !record.starred });
  }

  setAutoSave(value) {
    this.autoSave = !!value;
    try { localStorage.setItem(AUTOSAVE_KEY, this.autoSave ? '1' : '0'); } catch { /* приватный режим */ }
    this.emit('change', {});
    return this.autoSave;
  }

  /* ─── Удаление ─────────────────────────────────────────────── */

  async remove(id) {
    await this.store.tx(STORE_ARTWORKS, 'readwrite', (s) => s.delete(id));
    await this.store.tx(STORE_ART_IMAGES, 'readwrite', (s) => s.delete(id));
    this.items = this.items.filter((a) => a.id !== id);
    this.#touch();
    this.emit('change', { removed: id });
  }

  async clear() {
    for (const a of this.items) {
      await this.store.tx(STORE_ART_IMAGES, 'readwrite', (s) => s.delete(a.id));
    }
    await this.store.tx(STORE_ARTWORKS, 'readwrite', (s) => s.clear());
    this.items = [];
    this.#touch();
    this.emit('change', { cleared: true });
  }

  /* ─── Доступ к картинке ────────────────────────────────────── */

  async imageBlob(id) {
    const row = await this.store.tx(STORE_ART_IMAGES, 'readonly', (s) => s.get(id));
    if (!row?.blob) throw new Error('Картинка не найдена — возможно, хранилище очищено');
    return row.blob;
  }

  async canvasOf(id) {
    const blob = await this.imageBlob(id);
    const bmp = await loadImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close?.();
    return c;
  }

  /* ─── Действия ─────────────────────────────────────────────── */

  /**
   * Открывает работу: если сохранился проект — со слоями,
   * иначе — как готовое изображение.
   * @returns {Promise<'project'|'image'>}
   */
  async open(id, app) {
    const record = this.get(id);
    if (!record) throw new Error('Работа не найдена');

    if (record.projectId) {
      try {
        const { doc, project } = await this.store.load(record.projectId);
        app.setDocument(doc);
        app.projectId = project.id;
        if (project.viewport) app.viewport.restore(project.viewport);
        return 'project';
      } catch { /* проект удалён или повреждён — открываем картинку */ }
    }

    const blob = await this.imageBlob(id);
    const bmp = await loadImageBitmap(blob);
    const doc = createDocument({
      width: bmp.width,
      height: bmp.height,
      name: record.title,
      background: record.width === bmp.width ? 'transparent' : 'transparent',
    });
    const layer = await Layer.fromBlob(doc.width, doc.height, blob, { name: 'Фон' });
    doc.layers = [layer];
    doc.activeLayerId = layer.id;
    bmp.close?.();
    app.setDocument(doc);
    return 'image';
  }

  /** Скачивает (или сохраняет через File System Access) картинку работы */
  async download(id, format = 'png', { quality = 0.92 } = {}) {
    const record = this.get(id);
    if (!record) throw new Error('Работа не найдена');
    const blob = await this.imageBlob(id);

    if (format === 'png') {
      const safe = record.title.replace(/[^\wа-яё\- ]/gi, '') || 'artwork';
      const { aborted } = await saveBlobAs(blob, `${safe}.png`, 'image');
      return aborted ? false : blob;
    }

    const bmp = await loadImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close?.();

    const out = await exportImage(c, format, { quality });
    const safe = record.title.replace(/[^\wа-яё\- ]/gi, '') || 'artwork';
    const { aborted } = await saveBlobAs(out, `${safe}.${format}`, 'image');
    return aborted ? false : out;
  }

  /** Быстрое сохранение без диалога (для автосохранения и хоткея) */
  async downloadDirect(id) {
    const blob = await this.imageBlob(id);
    const record = this.get(id);
    const safe = record.title.replace(/[^\wа-яё\- ]/gi, '') || 'artwork';
    if (supportsFsAccess()) {
      const { aborted } = await saveBlobAs(blob, `${safe}.png`, 'image');
      return !aborted;
    }
    downloadBlob(blob, `${safe}.png`);
    return true;
  }

  /* ─── Фильтры ──────────────────────────────────────────────── */

  /** Список с поиском и сортировкой (для панели и диалога) */
  query({ search = '', sort = 'date', starredOnly = false } = {}) {
    const needle = search.trim().toLowerCase();
    let list = this.items.filter((a) => {
      if (starredOnly && !a.starred) return false;
      if (!needle) return true;
      return a.title.toLowerCase().includes(needle)
        || (a.note || '').toLowerCase().includes(needle)
        || (a.tags || []).some((t) => t.toLowerCase().includes(needle));
    });
    if (sort === 'name') list = [...list].sort((a, b) => a.title.localeCompare(b.title, 'ru'));
    else if (sort === 'size') list = [...list].sort((a, b) => (b.width * b.height) - (a.width * a.height));
    else list = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
    return list;
  }

  /** Сводка для меню и статус-строки */
  stats() {
    const total = this.items.length;
    const starred = this.items.filter((a) => a.starred).length;
    return { total, starred };
  }
}

export { THUMB_WIDTH };

/** Единственный экземпляр на приложение — им пользуются панель, меню и диалоги */
export const library = new Library(projectStore);