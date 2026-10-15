/**
 * Файлы: импорт изображений, экспорт (PNG/JPEG/WebP), сохранение
 * и открытие собственного формата проекта (.inkforge.json),
 * а также File System Access API там, где она есть.
 */

import { canvasToBlob, downloadBlob, loadImageBitmap } from './dom.js';
import { Document, createDocument } from '../core/doc.js';
import { Layer } from '../core/layer.js';
import { parseColor } from './color.js';

export const FILE_FORMAT = 'inkforge/1';

export const supportsFsAccess = () => typeof window.showSaveFilePicker === 'function';

/* ─── Экспорт изображения ────────────────────────────────────────── */

const MIME = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/**
 * @param {HTMLCanvasElement} canvas уже сплющенное изображение
 * @param {'png'|'jpeg'|'webp'} format
 */
export async function exportImage(canvas, format = 'png', { quality = 0.92, background = '#ffffff' } = {}) {
  let out = canvas;

  // JPEG не умеет альфу — подкладываем фон
  if (format === 'jpeg' && hasAlpha(canvas)) {
    out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    const ctx = out.getContext('2d');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, 0, 0);
  }

  const blob = await canvasToBlob(out, MIME[format], quality);
  return blob;
}

function hasAlpha(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
}

/* ─── Сохранение/открытие файлов ──────────────────────────────────── */

export const PICKER = {
  project: {
    description: 'Проект InkForge',
    accept: { 'application/json': ['.inkforge.json', '.json'] },
  },
  image: {
    description: 'Изображение',
    accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.gif'] },
  },
  all: {
    description: 'Проект или изображение',
    accept: { 'application/json': ['.inkforge.json'], 'image/*': ['.png', '.jpg', '.webp'] },
  },
};

/**
 * Диалог сохранения. Использует File System Access API, если доступен,
 * иначе — обычную загрузку файла.
 */
export async function saveBlobAs(blob, suggestedName, pickerType = 'project') {
  if (supportsFsAccess()) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [PICKER[pickerType] || PICKER.project],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { saved: true, handle };
    } catch (err) {
      if (err.name === 'AbortError') return { saved: false, aborted: true };
      console.warn('[InkForge] File System Access API недоступен, используем загрузку:', err);
    }
  }
  downloadBlob(blob, suggestedName);
  return { saved: true, handle: null };
}

export async function openFile(pickerType = 'all') {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [PICKER[pickerType] || PICKER.all],
        multiple: false,
      });
      return await handle.getFile();
    } catch (err) {
      if (err.name === 'AbortError') return null;
      console.warn('[InkForge] не удалось открыть диалог:', err);
    }
  }
  return await new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = pickerType === 'image'
      ? 'image/*'
      : 'application/json,.json,image/*';
    input.onchange = () => resolve(input.files?.[0] || null);
    input.click();
  });
}

/* ─── Собственный формат проекта ──────────────────────────────────── */

export async function serializeProject(app) {
  const doc = app.doc;
  const layers = [];
  for (const l of doc.layers) {
    layers.push({
      meta: l.serialize(),
      data: await canvasToDataURL(l.canvas, 'image/png'),
    });
  }
  return {
    format: FILE_FORMAT,
    app: 'InkForge',
    name: doc.name,
    width: doc.width,
    height: doc.height,
    background: doc.background,
    activeLayerId: doc.activeLayerId,
    createdAt: doc.createdAt,
    savedAt: Date.now(),
    color: app.color,
    viewport: app.viewport.serialize(),
    brush: {
      type: app.brush.type, size: app.brush.size, hardness: app.brush.hardness,
      flow: app.brush.flow, opacity: app.brush.opacity, spacing: app.brush.spacing,
      smoothing: app.brush.smoothing, sizeDynamics: app.brush.sizeDynamics,
      opacityDynamics: app.brush.opacityDynamics,
    },
    layers,
  };
}

export async function deserializeProject(json, { name } = {}) {
  if (json.format !== FILE_FORMAT) throw new Error('Это не файл проекта InkForge');

  const doc = new Document({
    width: json.width,
    height: json.height,
    name: name || json.name,
    background: json.background,
  });
  doc.createdAt = json.createdAt || Date.now();

  for (const item of json.layers || []) {
    const blob = dataURLToBlob(item.data);
    const layer = await Layer.fromBlob(doc.width, doc.height, blob, item.meta);
    doc.layers.push(layer);
  }
  doc.activeLayerId = doc.layerById(json.activeLayerId)
    ? json.activeLayerId
    : doc.layers.at(-1)?.id ?? null;

  return { doc, color: json.color, viewport: json.viewport, brush: json.brush };
}

function canvasToDataURL(canvas, type = 'image/png', quality) {
  if (canvas.convertToBlob) {
    return canvas.convertToBlob({ type, quality }).then(blobToDataURL);
  }
  return Promise.resolve(canvas.toDataURL(type, quality));
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

export const dataURLToBlob = (dataUrl) => {
  const [head, body] = dataUrl.split(',');
  const mime = head.match(/:(.*?);/)[1];
  const bin = atob(body);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
};

/* ─── Импорт изображений ──────────────────────────────────────────── */

/** Открывает картинку как новый документ */
export async function imageToDocument(file) {
  const bmp = await loadImageBitmap(file);
  const w = bmp.width, h = bmp.height;

  const doc = createDocument({ width: w, height: h, name: file.name.replace(/\.[^.]+$/, '') });
  // Первый слой уже создан — кладём в него изображение
  const layer = doc.layers[0];
  layer.ctx.drawImage(bmp, 0, 0);
  layer.markDirty();
  bmp.close?.();
  return doc;
}

/** Открывает картинку как новый слой текущего документа */
export async function imageToLayer(app, file) {
  const bmp = await loadImageBitmap(file);
  const doc = app.doc;
  const layer = app.layers.addLayer({
    name: file.name.replace(/\.[^.]+$/, ''),
    record: true,
  });
  // Масштабируем, если картинка больше документа
  const scale = Math.min(1, doc.width / bmp.width, doc.height / bmp.height);
  const w = bmp.width * scale;
  const h = bmp.height * scale;
  layer.ctx.drawImage(bmp, (doc.width - w) / 2, (doc.height - h) / 2, w, h);
  layer.markDirty();
  bmp.close?.();
  app.renderer.invalidate();
  return layer;
}

/** Определяет тип файла по расширению и содержимому */
export function detectFileKind(file) {
  if (/\.json$/i.test(file.name)) return 'project';
  if (/^image\//.test(file.type)) return 'image';
  if (/\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(file.name)) return 'image';
  return 'unknown';
}

/** Открывает файл: проект или изображение */
export async function openAny(app, file) {
  const kind = detectFileKind(file);
  if (kind === 'project') {
    const json = JSON.parse(await file.text());
    return { kind: 'project', ...(await deserializeProject(json)) };
  }
  if (kind === 'image') {
    const doc = await imageToDocument(file);
    return { kind: 'image', doc };
  }
  throw new Error(`Неподдерживаемый файл: ${file.name}`);
}

/** Читает цвет из файла палитры (.aco/.hex) — заготовка для Фазы 5 */
export async function readPaletteFile(file, parseColorFn = parseColor) {
  const text = await file.text();
  return text.split(/[\r\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseColorFn)
    .filter(Boolean);
}