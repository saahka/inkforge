/**
 * Модальные диалоги: новый документ, размер, галерея, экспорт,
 * сохранение/открытие проекта, справка.
 */

import { el, qs, debounce } from '../utils/dom.js';
import { formatDate, formatBytes, clamp } from '../utils/math.js';
import { createDocument } from '../core/doc.js';
import { projectStore } from '../storage/project-store.js';
import {
  exportImage, saveBlobAs, openFile, serializeProject,
  openAny, imageToLayer, imageToDocument, supportsFsAccess, FILE_FORMAT,
} from '../utils/file.js';
import { notify } from './notify.js';
import { library } from '../storage/library.js';

const PRESET_SIZES = [
  { label: 'A4 150 dpi', w: 1240, h: 1754 },
  { label: 'A4 300 dpi', w: 2480, h: 3508 },
  { label: 'Постер 2:3', w: 2000, h: 3000 },
  { label: 'Квадрат 2048', w: 2048, h: 2048 },
  { label: 'Full HD', w: 1920, h: 1080 },
  { label: '4K', w: 3840, h: 2160 },
];

/** Обновляет поле имени документа в шапке */
const syncDocName = (app, name) => {
  if (app.docNameInput) app.docNameInput.value = name;
};

/* ─── Базовый модальный каркас ────────────────────────────────────── */

let openModal = null;

export function modal({ title, body, buttons = [], onClose }) {
  closeModal();
  const host = qs('#modalLayer');
  const node = el('div.modal', null, [
    el('div.modal__head', null, [
      el('span', { text: title }),
      el('button.icon-btn', { text: '✕', type: 'button', onclick: () => closeModal() }),
    ]),
    el('div.modal__body', null, [].concat(body)),
    el('div.modal__foot', null, buttons.map((b) => {
      // Модификатор дописываем к базовому классу, а не заменяем его
      const btn = el('button', {
        type: 'button',
        text: b.label,
        onclick: () => b.action?.(closeModal),
      });
      btn.className = ['btn', b.primary ? 'btn--primary' : '', b.danger ? 'btn--danger' : '']
        .filter(Boolean).join(' ');
      return btn;
    })),
  ]);

  host.replaceChildren(node);
  host.hidden = false;
  host.onclick = (e) => { if (e.target === host) closeModal(); };
  openModal = { onClose };
  return closeModal;
}

export function closeModal() {
  const host = qs('#modalLayer');
  if (!host || host.hidden) return;
  host.hidden = true;
  host.replaceChildren();
  openModal?.onClose?.();
  openModal = null;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openModal) closeModal();
});

/* ─── Подтверждение ───────────────────────────────────────────────── */

export function confirmDialog(title, message, { danger = false, okLabel = 'ОК' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    modal({
      title,
      body: el('p', { text: message }),
      buttons: [
        { label: 'Отмена', action: (close) => { done = true; close(); resolve(false); } },
        { label: okLabel, primary: !danger, danger, action: (close) => { done = true; close(); resolve(true); } },
      ],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

/* ─── Новый документ ──────────────────────────────────────────────── */

export function openDialogNew(app) {
  const w = el('input.field__text', { type: 'number', value: 1600, min: 1, max: 8192 });
  const h = el('input.field__text', { type: 'number', value: 1000, min: 1, max: 8192 });
  const name = el('input.field__text', { type: 'text', value: 'Без имени' });
  const bg = el('input.field__text', { type: 'color', value: '#ffffff', style: { height: '30px' } });
  const transparent = el('input', { type: 'checkbox' });

  const preset = el('select.field__select', null, [
    el('option', { value: '', text: '— пресеты —' }),
    ...PRESET_SIZES.map((p) => el('option', { value: `${p.w}x${p.h}`, text: `${p.label} · ${p.w}×${p.h}` })),
  ]);
  preset.addEventListener('change', () => {
    if (!preset.value) return;
    const [pw, ph] = preset.value.split('x').map(Number);
    w.value = pw;
    h.value = ph;
  });

  const ratioLock = el('input', { type: 'checkbox', checked: true });
  // Пропорции берём из стартовых значений, а не из текущих (иначе «уплывают»)
  const base = { w: +w.value, h: +h.value };
  const applyRatio = (changed) => {
    if (!ratioLock.checked) return;
    if (changed === 'w') h.value = Math.max(1, Math.round(base.h * (w.value / base.w)));
    else w.value = Math.max(1, Math.round(base.w * (h.value / base.h)));
  };
  w.addEventListener('input', () => applyRatio('w'));
  h.addEventListener('input', () => applyRatio('h'));
  preset.addEventListener('change', () => {
    base.w = +w.value;
    base.h = +h.value;
  });

  const create = (close) => {
    const doc = createDocument({
      width: clamp(+w.value, 1, 8192),
      height: clamp(+h.value, 1, 8192),
      name: name.value.trim() || 'Без имени',
      background: transparent.checked ? 'transparent' : bg.value,
    });
    app.setDocument(doc);
    close();
    notify('Создан новый документ', 'ok');
  };

  modal({
    title: 'Новый документ',
    body: [
      el('div.row-2', null, [
        el('div.field', null, [el('span.field__label', { text: 'Ширина, px' }), w]),
        el('div.field', null, [el('span.field__label', { text: 'Высота, px' }), h]),
      ]),
      el('div.field', null, [el('span.field__label', { text: 'Пресет размера' }), preset]),
      el('div.field', null, [el('span.field__label', { text: 'Имя документа' }), name]),
      el('div.row-2', null, [
        el('div.field', null, [el('span.field__label', { text: 'Фон' }), bg]),
        el('label.checkbox', { style: { alignSelf: 'end', paddingBottom: '6px' } },
          [transparent, 'Прозрачный фон']),
      ]),
      el('label.checkbox', null, [ratioLock, 'Держать пропорции']),
    ],
    buttons: [
      { label: 'Отмена', action: (close) => close() },
      { label: 'Создать', primary: true, action: create },
    ],
  });

  w.focus();
  w.select();
}

/* ─── Размер изображения ──────────────────────────────────────────── */

export function openDialogResize(app) {
  const doc = app.doc;
  const w = el('input.field__text', { type: 'number', value: doc.width, min: 1, max: 8192 });
  const h = el('input.field__text', { type: 'number', value: doc.height, min: 1, max: 8192 });
  const percent = el('input.field__text', { type: 'number', value: 100, min: 1, max: 1600 });
  const anchor = el('select.field__select', null, [
    el('option', { value: 'top-left', text: 'Верхний левый угол' }),
    el('option', { value: 'center', text: 'Центр', selected: true }),
  ]);

  percent.addEventListener('input', () => {
    const k = clamp(percent.value / 100, 0.01, 16);
    w.value = Math.max(1, Math.round(doc.width * k));
    h.value = Math.max(1, Math.round(doc.height * k));
  });

  modal({
    title: 'Размер изображения',
    body: [
      el('div.row-3', null, [
        el('div.field', null, [el('span.field__label', { text: 'Ширина, px' }), w]),
        el('div.field', null, [el('span.field__label', { text: 'Высота, px' }), h]),
        el('div.field', null, [el('span.field__label', { text: '%' }), percent]),
      ]),
      el('div.field', null, [el('span.field__label', { text: 'Привязка' }), anchor]),
      el('p.field__label', { text: 'Холст до 8192×8192 в этой фазе. Более крупные холсты — после включения тайлового рендеринга.' }),
    ],
    buttons: [
      { label: 'Отмена', action: (close) => close() },
      {
        label: 'Применить',
        primary: true,
        action: (close) => {
          app.resizeDocument(+w.value, +h.value, anchor.value);
          close();
          notify('Размер изменён', 'ok');
        },
      },
    ],
  });
}

/* ─── Галерея проектов ────────────────────────────────────────────── */

export async function openDialogGallery(app) {
  const grid = el('div.gallery-grid');
  modal({
    title: 'Галерея проектов',
    body: [
      el('p.field__label', { text: 'Проекты хранятся в IndexedDB этого браузера.' }),
      grid,
    ],
    buttons: [
      { label: 'Закрыть', action: (close) => close() },
    ],
  });

  const items = await projectStore.list().catch(() => []);
  if (!items.length) {
    grid.replaceChildren(el('p.field__label', { text: 'Пока пусто. Нажмите Ctrl+S, чтобы сохранить текущий документ.' }));
    return;
  }

  grid.replaceChildren(...items.map((p) => {
    const card = el('div.gallery-card', {
      onclick: async () => {
        closeModal();
        try {
          const { doc, project } = await projectStore.load(p.id);
          app.setDocument(doc);
          app.projectId = project.id;
          app.viewport.restore(project.viewport);
          if (project.color) app.setColor(project.color.fg || app.color.fg, 'fg');
          if (project.color) app.setColor(project.color.bg || app.color.bg, 'bg');
          if (project.brush) app.setBrush({ ...app.brush, ...project.brush });
          syncDocName(app, doc.name);
          app.markSaved();
          notify(`Открыт проект «${doc.name}»`, 'ok');
        } catch (err) {
          notify(err.message, 'error');
        }
      },
    }, [
      p.thumb
        ? el('img.gallery-card__thumb', { src: p.thumb, alt: '' })
        : el('div.gallery-card__thumb'),
      el('div.gallery-card__meta', null, [
        el('div.gallery-card__name', { text: p.name }),
        el('div.gallery-card__date', { text: `${p.width}×${p.height} · ${p.layers} сл. · ${formatDate(p.updatedAt)}` }),
      ]),
    ]);

    const del = el('button.btn.btn--danger.btn--ghost', {
      text: 'Удалить',
      onclick: async (e) => {
        e.stopPropagation();
        if (!(await confirmDialog('Удалить проект?', `«${p.name}» будет удалён без возможности восстановления.`, { danger: true, okLabel: 'Удалить' }))) return;
        await projectStore.delete(p.id);
        card.remove();
      },
    });
    card.append(del);
    return card;
  }));

  const est = await projectStore.estimate();
  if (est) {
    grid.after(el('p.field__label', {
      text: `Занято в хранилище: ${formatBytes(est.usage)} из ${formatBytes(est.quota)}`,
    }));
  }
}

/* ─── Сохранение и открытие ───────────────────────────────────────── */

export async function openDialogSaveProject(app, { silent = false } = {}) {
  try {
    if (silent) {
      await projectStore.autosave(app);
      app.markSaved();
      notify('Сохранено в браузере', 'ok');
      return;
    }
    const json = await serializeProject(app);
    const blob = new Blob([JSON.stringify(json)], { type: 'application/json' });
    const safe = (app.doc.name || 'project').replace(/[^\wа-яё\- ]/gi, '');
    const { saved, aborted } = await saveBlobAs(blob, `${safe || 'project'}.inkforge.json`, 'project');
    if (!saved && !aborted) notify('Отменено', 'info');
    if (saved) {
      app.markSaved();
      notify(supportsFsAccess() ? 'Проект сохранён в файл' : 'Файл скачан', 'ok');
    }
  } catch (err) {
    notify(err.message, 'error');
  }
}

export async function openDialogOpenProject(app) {
  try {
    const file = await openFile('all');
    if (!file) return;
    const result = await openAny(app, file);
    if (result.kind === 'project') {
      app.setDocument(result.doc);
      if (result.color?.fg) app.setColor(result.color.fg, 'fg');
      if (result.color?.bg) app.setColor(result.color.bg, 'bg');
      if (result.viewport) app.viewport.restore(result.viewport);
      if (result.brush) app.setBrush({ ...app.brush, ...result.brush });
      app.projectId = null;
      syncDocName(app, result.doc.name);
      app.markSaved();
      notify(`Открыт проект «${result.doc.name}»`, 'ok');
    } else {
      app.setDocument(result.doc);
      app.projectId = null;
      notify(`Открыто изображение ${result.doc.width}×${result.doc.height}`, 'ok');
    }
  } catch (err) {
    notify(err.message, 'error');
  }
}

/** Диалог открытия изображения: в новый документ или новым слоем */
export async function promptOpenImage(app) {
  try {
    const file = await openFile('image');
    if (!file) return;

    // Пустой холст (один слой без пикселей) — открываем картинку как документ
    const empty = app.doc.layers.length <= 1 && !app.doc.layers[0].contentRect;
    if (empty) {
      const doc = await imageToDocument(file);   // размер берём из самой картинки
      app.setDocument(doc);
      app.markSaved();
      notify(`Открыто ${doc.width}×${doc.height}`, 'ok');
      return;
    }

    await imageToLayer(app, file);
    app.markChanged();
    notify(`Слой «${file.name}» добавлен`, 'ok');
  } catch (err) {
    notify(err.message, 'error');
  }
}

/* ─── Экспорт ─────────────────────────────────────────────────────── */

export async function openDialogExport(app) {
  const scaleRow = el('div.field', null, [
    el('span.field__label', { text: 'Масштаб' }),
    (() => {
      const s = el('select.field__select', null, [
        el('option', { value: '1', text: '100% (оригинал)' }),
        el('option', { value: '0.5', text: '50%' }),
        el('option', { value: '2', text: '200%' }),
        el('option', { value: '4', text: '400%' }),
      ]);
      return s;
    })(),
  ]);

  const format = el('select.field__select', null, [
    el('option', { value: 'png', text: 'PNG (с альфой)' }),
    el('option', { value: 'jpeg', text: 'JPEG (без альфы)' }),
    el('option', { value: 'webp', text: 'WebP' }),
  ]);

  const quality = el('input', { type: 'range', min: 50, max: 100, value: 92 });
  const bgRow = el('div.field', null, [
    el('span.field__label', { text: 'Фон для JPEG' }),
    el('input.field__text', { type: 'color', value: '#ffffff', style: { height: '30px' } }),
  ]);

  const doExport = async (close) => {
    const k = +scaleRow.querySelector('select').value;
    close();
    const src = app.flattenCanvas();
    let out = src;
    if (k !== 1) {
      out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(src.width * k));
      out.height = Math.max(1, Math.round(src.height * k));
      const ctx = out.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, 0, 0, out.width, out.height);
    }
    try {
      const blob = await exportImage(out, format.value, {
        quality: +quality.value / 100,
        background: bgRow.querySelector('input').value,
      });
      const name = (app.doc.name || 'image').replace(/[^\wа-яё\- ]/gi, '');
      const { aborted } = await saveBlobAs(blob, `${name || 'image'}.${format.value}`, 'image');
      if (!aborted) notify(`Экспортировано: ${formatBytes(blob.size)}`, 'ok');

      // Если включено автосохранение — кладём результат в библиотеку,
      // чтобы работа не потерялась после закрытия вкладки
      if (!aborted && library.autoSave && projectStore.available) {
        try {
          if (!app.projectId) await projectStore.save(app);
          await library.capture(app, { title: app.doc.name });
          notify('Работа добавлена в библиотеку', 'ok');
        } catch (err) {
          notify(`Не удалось сохранить в библиотеку: ${err.message}`, 'error');
        }
      }
    } catch (err) {
      notify(err.message, 'error');
    }
  };

  modal({
    title: 'Экспорт изображения',
    body: [
      el('div.row-2', null, [
        el('div.field', null, [el('span.field__label', { text: 'Формат' }), format]),
        scaleRow,
      ]),
      el('div.field', null, [el('span.field__label', { text: 'Качество' }), quality]),
      bgRow,
      el('p.field__label', { text: 'Экспортируется видимый композит всех слоёв.' }),
    ],
    buttons: [
      { label: 'Отмена', action: (close) => close() },
      { label: 'Экспортировать', primary: true, action: doExport },
    ],
  });
}

/* ─── Библиотека готовых работ ──────────────────────────────────── */

/**
 * Диалог сохранения текущей работы в библиотеку.
 * Вызывается из меню, панели и по Ctrl+Shift+L.
 */
export async function openArtworkDialog(app) {
  if (!projectStore.available) {
    notify('Библиотея недоступна: браузер не даёт доступ к IndexedDB', 'error');
    return null;
  }
  const suggested = `${app.doc.name || 'Без имени'}`.trim() || 'Без имени';
  const title = el('input.field__text', { type: 'text', value: suggested });
  const note = el('input.field__text', { type: 'text', placeholder: 'Заметка (необязательно)' });
  const size = `${app.doc.width} × ${app.doc.height} px · ${app.doc.layers.length} сл.`;

  const doSave = async (close) => {
    try {
      // Сначала сохраняем проект — тогда работу можно будет открыть со слоями
      if (!app.projectId) await projectStore.save(app);
      const item = await library.capture(app, { title: title.value, note: note.value });
      close();
      notify(`Работа «${item.title}» сохранена в библиотеку`, 'ok');
      return item;
    } catch (err) {
      notify(err.message, 'error');
      return null;
    }
  };

  modal({
    title: 'Сохранить в библиотеку',
    body: [
      el('p.field__label', { text: size }),
      el('div.field', null, [el('span.field__label', { text: 'Название работы' }), title]),
      el('div.field', null, [el('span.field__label', { text: 'Заметка' }), note]),
      el('p.field__label', {
        text: 'Проект тоже будет сохранён — работу можно будет открыть вместе со слоями.',
      }),
    ],
    buttons: [
      { label: 'Отмена', action: (close) => close() },
      { label: 'Сохранить', primary: true, action: doSave },
    ],
  });

  title.focus();
  title.select();
}

/** Большая библиотека: поиск, сортировка, действия над карточками */
export async function openLibraryDialog(app) {
  await library.ensureLoaded();

  const search = el('input.field__text', { type: 'search', placeholder: 'Поиск по названию или заметке' });
  const sort = el('select.field__select', null, [
    el('option', { value: 'date', text: 'Сначала новые' }),
    el('option', { value: 'name', text: 'По названию' }),
    el('option', { value: 'size', text: 'По размеру' }),
  ]);
  const grid = el('div.gallery-grid');

  const render = () => {
    const list = library.query({ search: search.value, sort: sort.value });
    grid.replaceChildren();

    if (!list.length) {
      grid.append(el('p.field__label', {
        style: { gridColumn: '1 / -1', textAlign: 'center', padding: '16px' },
        text: library.items.length
          ? 'Ничего не найдено'
          : 'Библиотека пуста. Сохраните работу через Ctrl+Shift+L.',
      }));
      return;
    }

    for (const item of list) {
      const card = el('div.gallery-card', { title: item.note || item.title }, [
        el('img.gallery-card__thumb', { src: item.thumb, alt: item.title }),
        el('div.gallery-card__meta', null, [
          el('div.gallery-card__name', {
            text: (item.starred ? '★ ' : '') + item.title,
            ondblclick: (e) => {
              const v = prompt('Название работы', item.title);
              if (v && v.trim() && v !== item.title) library.setTitle(item.id, v);
              void e;
            },
          }),
          el('div.gallery-card__date', {
            text: `${item.width}×${item.height} · ${formatDate(item.updatedAt)}`
              + (item.projectId ? ' · проект' : ''),
          }),
        ]),
      ]);

      const actions = el('div', { style: { display: 'flex', gap: '4px', padding: '0 8px 8px' } }, [
        el('button.btn.btn--ghost', { text: 'Открыть', onclick: async () => {
          try {
            const how = await library.open(item.id, app);
            closeModal();
            notify(how === 'project' ? 'Открыт проект' : 'Открыто изображение', 'ok');
          } catch (err) { notify(err.message, 'error'); }
        } }),
        el('button.btn.btn--ghost', { text: 'PNG', onclick: async () => {
          await library.downloadDirect(item.id);
        } }),
        el('button.btn.btn--ghost', { text: item.starred ? '★' : '☆', onclick: () => library.toggleStar(item.id) }),
        el('button.btn.btn--ghost.btn--danger', { text: '🗑', onclick: async () => {
          if (!(await confirmDialog('Удалить работу?', `«${item.title}» будет удалена.`, { danger: true, okLabel: 'Удалить' }))) return;
          await library.remove(item.id);
        } }),
      ]);
      card.append(actions);
      grid.append(card);
    }
  };

  search.addEventListener('input', debounce(render, 150));
  sort.addEventListener('change', render);

  modal({
    title: 'Библиотека работ',
    body: [
      el('div.row-2', null, [search, sort]),
      el('p.field__label', { id: 'libraryStats' }),
      grid,
    ],
    buttons: [
      { label: 'Закрыть', primary: true, action: (close) => close() },
      { label: 'Очистить библиотеку', danger: true, action: async (close) => {
        if (!library.items.length) return;
        if (!(await confirmDialog('Очистить библиотеку?',
          `Будет удалено работ: ${library.items.length}. Действие необратимо.`,
          { danger: true, okLabel: 'Очистить' }))) return;
        await library.clear();
        close();
        notify('Библиотека очищена', 'ok');
      } },
    ],
  });

  library.on('change', render);
  render();
}

/** Скачивание работы в выбранном формате */
export async function openArtworkExportDialog(app, item) {
  const format = el('select.field__select', null, [
    el('option', { value: 'png', text: 'PNG (с альфой)' }),
    el('option', { value: 'jpeg', text: 'JPEG' }),
    el('option', { value: 'webp', text: 'WebP' }),
  ]);
  const scale = el('select.field__select', null, [
    el('option', { value: '1', text: 'Оригинал' }),
    el('option', { value: '0.5', text: '50%' }),
    el('option', { value: '2', text: '200%' }),
  ]);

  modal({
    title: `Скачать «${item.title}»`,
    body: [
      el('p.field__label', { text: `${item.width} × ${item.height} px` }),
      el('div.row-2', null, [
        el('div.field', null, [el('span.field__label', { text: 'Формат' }), format]),
        el('div.field', null, [el('span.field__label', { text: 'Размер' }), scale]),
      ]),
    ],
    buttons: [
      { label: 'Отмена', action: (close) => close() },
      { label: 'Скачать', primary: true, action: async (close) => {
        close();
        try {
          if (scale.value === '1') {
            const ok = await library.download(item.id, format.value);
            if (ok) notify('Файл сохранён', 'ok');
            return;
          }
          // Масштабирование: перерисовываем картинку работы
          const src = await library.canvasOf(item.id);
          const k = +scale.value;
          const out = document.createElement('canvas');
          out.width = Math.max(1, Math.round(src.width * k));
          out.height = Math.max(1, Math.round(src.height * k));
          const ctx = out.getContext('2d');
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(src, 0, 0, out.width, out.height);
          const blob = await exportImage(out, format.value, { background: '#ffffff' });
          const safe = item.title.replace(/[^\wа-яё\- ]/gi, '') || 'artwork';
          const { aborted } = await saveBlobAs(blob, `${safe}.${format.value}`, 'image');
          if (!aborted) notify('Файл сохранён', 'ok');
        } catch (err) {
          notify(err.message, 'error');
        }
      } },
    ],
  });
  void app;
}

/* ─── О программе / горячие клавиши ───────────────────────────────── */

const KEYS = [
  ['Инструменты', ''],
  ['B', 'Кисть'], ['E', 'Ластик'], ['G', 'Заливка'], ['Shift+G', 'Градиент'],
  ['I', 'Пипетка'], ['M', 'Выделение'], ['V', 'Перемещение'], ['H / Space', 'Панорамирование'],
  ['[ / ]', 'Размер кисти меньше / больше'], ['Shift+[ / ]', 'Жёсткость кисти'],
  ['D', 'Цвет по умолчанию'], ['X', 'Поменять цвета местами'],
  ['Правка', ''],
  ['Ctrl+Z / Ctrl+Y', 'Отменить / повторить'], ['Ctrl+Shift+Z', 'Повторить'],
  ['Ctrl+A / Ctrl+D', 'Выделить всё / снять'], ['Alt+Ctrl+Z', 'Заливка фоновым цветом'],
  ['Файл', ''],
  ['Ctrl+S', 'Сохранить в браузере'], ['Ctrl+Shift+S', 'Сохранить как файл'],
  ['Ctrl+N / Ctrl+O', 'Новый / открыть'], ['Ctrl+E', 'Объединить слои / экспорт'],
  ['Слои', ''],
  ['Ctrl+Shift+N', 'Новый слой'], ['Ctrl+J', 'Дублировать слой'], ['Delete', 'Удалить слой'],
  ['Вид', ''],
  ['Space + тяга', 'Панорамирование'], ['Ctrl + колесо', 'Масштаб'], ['Ctrl+0 / Ctrl+1', '100% / вписать'],
  ['Tab', 'Скрыть панели'], ['F3', 'Счётчик памяти'],
];

export function openDialogAbout(app, tab = 'about') {
  const about = el('div', null, [
    el('p', { text: 'InkForge — программа для цифрового рисования в браузере. Чистый JavaScript, Canvas2D и Pointer Events; поддержка графического планшета с давлением.' }),
    el('p.field__label', { text: `Формат проекта: ${FILE_FORMAT}. Всё хранится локально: IndexedDB для проектов, localStorage для палитры.` }),
    el('p.field__label', { text: `Планшет: ${matchMedia('(pointer: fine)').matches ? 'мышь доступна' : 'только тач'}. Аппаратное ускорение: ${hasGPU() ? 'да' : 'нет'}.` }),
  ]);

  const keys = el('div', { style: { display: 'grid', gridTemplateColumns: '130px 1fr', gap: '4px 12px' } },
    KEYS.flatMap((row) => row[1]
      ? [el('kbd', { text: row[0], style: { color: 'var(--fg-muted)' } }), el('span', { text: row[1] })]
      : [el('div', { text: row[0], style: { gridColumn: '1 / -1', color: 'var(--accent)', marginTop: '8px' } })]));

  const body = tab === 'keys' ? keys : about;
  modal({ title: tab === 'keys' ? 'Горячие клавиши' : 'О программе', body, buttons: [{ label: 'Закрыть', primary: true, action: (close) => close() }] });
  void app;
}

function hasGPU() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}