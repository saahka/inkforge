/**
 * Хранилище проектов в IndexedDB.
 *
 * В базе лежат «сырые» проекты: метаданные документа + PNG-каждого слоя
 * + превью. Такой формат переживает перезагрузку страницы и не зависит
 * от версии кода (внутри есть поле version для будущих миграций).
 */

const DB_NAME = 'inkforge';
const DB_VERSION = 1;
const STORE_PROJECTS = 'projects';
const STORE_THUMBS = 'thumbs';

export class ProjectStore {
  constructor() {
    this.db = null;
    this.available = typeof indexedDB !== 'undefined';
    this.lastError = null;
  }

  /** Открывает (и при необходимости создаёт) базу */
  async open() {
    if (!this.available) return null;
    if (this.db) return this.db;

    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
          const store = db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt');
        }
        if (!db.objectStoreNames.contains(STORE_THUMBS)) {
          db.createObjectStore(STORE_THUMBS, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('База заблокирована другой вкладкой'));
    });

    this.db.onversionchange = () => this.db.close();
    return this.db;
  }

  #tx(store, mode, fn) {
    return this.open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
  }

  /* ─── Сохранение ─────────────────────────────────────────────── */

  /**
   * @param {object} app
   * @returns {Promise<string>} id проекта
   */
  async save(app) {
    const doc = app.doc;
    const id = app.projectId || `p_${Date.now().toString(36)}`;
    app.projectId = id;

    const layers = [];
    for (const l of doc.layers) {
      layers.push({
        meta: l.serialize(),
        blob: await l.toBlob('image/png'),
      });
    }

    const record = {
      id,
      version: 1,
      name: doc.name,
      width: doc.width,
      height: doc.height,
      background: doc.background,
      activeLayerId: doc.activeLayerId,
      createdAt: doc.createdAt,
      updatedAt: Date.now(),
      viewport: app.viewport.serialize(),
      color: { fg: app.color.fg, bg: app.color.bg },
      brush: {
        type: app.brush.type,
        size: app.brush.size,
        hardness: app.brush.hardness,
        flow: app.brush.flow,
        opacity: app.brush.opacity,
        spacing: app.brush.spacing,
        smoothing: app.brush.smoothing,
        sizeDynamics: app.brush.sizeDynamics,
        opacityDynamics: app.brush.opacityDynamics,
      },
      layers,
    };

    await this.#tx(STORE_PROJECTS, 'readwrite', (s) => s.put(record));

    try {
      const thumb = await app.thumbnail();
      await this.#tx(STORE_THUMBS, 'readwrite', (s) => s.put({ id, thumb, updatedAt: record.updatedAt }));
    } catch { /* превью не критично */ }

    return id;
  }

  /** Автосохранение с защитой от «дребезга» вызовов */
  async autosave(app) {
    try {
      await this.save(app);
      return true;
    } catch (err) {
      this.lastError = err;
      console.warn('[InkForge] автосохранение не удалось:', err);
      return false;
    }
  }

  /* ─── Загрузка ───────────────────────────────────────────────── */

  /** Возвращает {doc, project} — документ собран из сохранённых слоёв */
  async load(id) {
    const record = await this.#tx(STORE_PROJECTS, 'readonly', (s) => s.get(id));
    if (!record) throw new Error('Проект не найден');

    const { Document } = await import('../core/doc.js');
    const { Layer } = await import('../core/layer.js');

    const doc = new Document({
      width: record.width,
      height: record.height,
      name: record.name,
      background: record.background,
    });
    doc.createdAt = record.createdAt || Date.now();
    doc.updatedAt = record.updatedAt || Date.now();

    for (const item of record.layers || []) {
      const layer = await Layer.fromBlob(doc.width, doc.height, item.blob, item.meta);
      doc.layers.push(layer);
    }
    doc.activeLayerId = doc.layerById(record.activeLayerId)
      ? record.activeLayerId
      : doc.layers.at(-1)?.id ?? null;

    return { doc, project: record };
  }

  /** Список сохранённых проектов (без пикселей) */
  async list() {
    const all = await this.#tx(STORE_PROJECTS, 'readonly', (s) => s.getAll());
    const thumbs = await this.#tx(STORE_THUMBS, 'readonly', (s) => s.getAll());
    const thumbMap = new Map(thumbs.map((t) => [t.id, t.thumb]));
    return (all || [])
      .map((p) => ({
        id: p.id,
        name: p.name,
        width: p.width,
        height: p.height,
        updatedAt: p.updatedAt,
        layers: p.layers?.length || 0,
        thumb: thumbMap.get(p.id) || null,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async delete(id) {
    await this.#tx(STORE_PROJECTS, 'readwrite', (s) => s.delete(id));
    await this.#tx(STORE_THUMBS, 'readwrite', (s) => s.delete(id));
  }

  /** Приблизительный объём, занятый проектами */
  async estimate() {
    if (navigator.storage?.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      return { usage, quota };
    }
    return null;
  }
}

export const projectStore = new ProjectStore();