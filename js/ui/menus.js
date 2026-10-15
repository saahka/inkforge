/**
 * Меню: верхняя строка и контекстные меню.
 * Один универсальный рендерер для выпадающих и контекстных меню —
 * отличается только точка раскрытия и набор пунктов.
 */

import { el, qs } from '../utils/dom.js';
import {
  openDialogNew, openDialogResize, openDialogGallery, openDialogAbout,
  openDialogExport, openDialogSaveProject, openDialogOpenProject,
} from './dialogs.js';

const layer = () => document.getElementById('menuLayer');

let closeCurrent = null;

/** Строит меню и возвращает функцию закрытия */
function renderMenu(items, x, y, { minWidth = 210 } = {}) {
  const host = layer();
  const menu = el('div.dropdown', { style: { minWidth: `${minWidth}px` } });

  for (const item of items) {
    if (item.sep) { menu.append(el('div.menu-sep')); continue; }

    const btn = el('button.menu-entry', {
      type: 'button',
      disabled: !!item.disabled,
    }, [
      el('span.menu-entry__icon', { text: item.checked ? '✓' : (item.icon || '') }),
      el('span', { text: item.label }),
      item.key ? el('span.menu-entry__key', { text: item.key }) : null,
    ]);
    if (item.danger) btn.style.color = 'var(--danger)';

    btn.addEventListener('click', () => {
      close();
      item.action?.();
    });
    menu.append(btn);
  }

  host.replaceChildren(menu);
  host.classList.add('is-open');

  // Держим меню в пределах окна
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = y + rect.height > window.innerHeight ? Math.max(8, y - rect.height) : y;
  menu.style.left = `${Math.max(4, left)}px`;
  menu.style.top = `${top}px`;

  const onDown = (e) => { if (!menu.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  // Регистрируем после отрисовки, иначе тот же клик, который открыл меню, его же закроет
  setTimeout(() => document.addEventListener('pointerdown', onDown, { capture: true }), 0);

  function close() {
    host.classList.remove('is-open');
    host.replaceChildren();
    document.removeEventListener('pointerdown', onDown, { capture: true });
    document.removeEventListener('keydown', onKey);
    closeCurrent = null;
  }

  closeCurrent = close;
  return close;
}

/** Контекстное меню (например, правый клик по слою) */
export function showContextMenu(x, y, items) {
  return renderMenu(items, x, y, { minWidth: 190 });
}

/** Выпадающее меню верхней панели */
export function showDropdown(anchor, items) {
  const rect = anchor.getBoundingClientRect();
  const open = anchor.classList.contains('is-open');
  closeCurrent?.();
  if (open) return null;
  anchor.classList.add('is-open');
  const close = renderMenu(items, rect.left, rect.bottom + 2, { minWidth: 230 });
  const originalClose = close;
  const wrapped = () => { anchor.classList.remove('is-open'); originalClose(); };
  closeCurrent = wrapped;
  return wrapped;
}

/* ─── Описание меню верхней строки ────────────────────────────────── */

export function buildMenuDefinition(app) {
  const L = () => app.doc.activeLayer;
  const layerItems = () => (L() ? [
    { label: 'Новый слой', key: 'Ctrl+Shift+N', action: () => app.layers.addLayer({ record: true }) },
    { label: 'Дублировать слой', key: 'Ctrl+J', action: () => app.layers.duplicateLayer(L().id) },
    { label: 'Очистить слой', action: () => app.layers.clearLayer(L()) },
    { sep: true },
    { label: 'Объединить вниз', key: 'Ctrl+E', action: () => app.layers.mergeDown(L().id) },
    { label: 'Сплющить изображение', action: () => app.layers.flatten() },
    { sep: true },
    { label: 'Маска слоя', checked: !!L().clipTo, action: () => {
      const below = app.doc.layers[app.doc.indexOf(L().id) - 1];
      app.layers.setClipTo(L().id, L().clipTo ? null : (below?.id || null), { record: true });
    } },
    { label: 'Блокировка', checked: L().locked, action: () => app.layers.setLocked(L().id, !L().locked, { record: true }) },
    { sep: true },
    { label: 'Удалить слой', key: 'Del', danger: true, action: () => app.layers.deleteLayer(L().id) },
  ] : [{ label: 'Нет активного слоя', disabled: true }]);

  return [
    {
      label: 'Файл',
      items: [
        { label: 'Новый документ…', key: 'Ctrl+N', action: () => openDialogNew(app) },
        { label: 'Открыть проект…', key: 'Ctrl+O', action: () => openDialogOpenProject(app) },
        { label: 'Галерея проектов…', action: () => openDialogGallery(app) },
        { sep: true },
        { label: 'Сохранить в браузере', key: 'Ctrl+S', action: () => openDialogSaveProject(app, { silent: true }) },
        { label: 'Сохранить как файл…', key: 'Ctrl+Shift+S', action: () => openDialogSaveProject(app) },
        { label: 'Открыть изображение…', action: () => app.emit('openImageDialog') },
        { sep: true },
        { label: 'Экспорт изображения…', key: 'Ctrl+Shift+E', action: () => openDialogExport(app) },
        { label: 'Размер изображения…', action: () => openDialogResize(app) },
      ],
    },
    {
      label: 'Правка',
      items: [
        { label: 'Отменить', key: 'Ctrl+Z', disabled: !app.history.canUndo(), action: () => app.history.undo() },
        { label: 'Повторить', key: 'Ctrl+Y', disabled: !app.history.canRedo(), action: () => app.history.redo() },
        { sep: true },
        { label: 'Выделить всё', key: 'Ctrl+A', action: () => app.selection.selectAll() },
        { label: 'Снять выделение', key: 'Ctrl+D', action: () => app.selection.clear() },
        { sep: true },
        { label: 'Очистить слой', action: () => L() && app.layers.clearLayer(L()) },
      ],
    },
    {
      label: 'Изображение',
      items: [
        { label: 'Размер холста…', action: () => openDialogResize(app) },
        { label: 'Обрезать по выделению', disabled: !app.selection.active, action: () => cropToSelection(app) },
        { sep: true },
        { label: 'Сплющить изображение', action: () => app.layers.flatten() },
      ],
    },
    {
      label: 'Слой',
      items: layerItems,
    },
    {
      label: 'Фильтр',
      items: [
        { label: 'Размытие по Гауссу', disabled: true, action: () => app.emit('todo', 'Фаза 4: WebGL-фильтры') },
        { label: 'Резкость (Unsharp)', disabled: true },
        { label: 'Уровни / Кривые', disabled: true },
        { sep: true },
        { label: 'Инвертировать', disabled: true },
        { label: 'Постеризация', disabled: true },
      ],
    },
    {
      label: 'Вид',
      items: [
        { label: 'Увеличить', key: 'Ctrl++', action: () => app.viewport.setScale(app.viewport.scale * 1.25) },
        { label: 'Уменьшить', key: 'Ctrl+-', action: () => app.viewport.setScale(app.viewport.scale / 1.25) },
        { label: '100%', key: 'Ctrl+0', action: () => app.viewport.actualSize(app.doc.width, app.doc.height) },
        { label: 'Вписать в экран', key: 'Ctrl+1', action: () => app.viewport.fit(app.doc.width, app.doc.height) },
        { sep: true },
        { label: 'Режим фокуса', key: 'F11', action: () => app.emit('toggleFocus') },
        { label: 'Показать подсказки инструментов', checked: document.documentElement.dataset.showKeys === '1', action: () => app.emit('toggleToolKeys') },
      ],
    },
    {
      label: 'Справка',
      items: [
        { label: 'О программе…', action: () => openDialogAbout(app) },
        { label: 'Горячие клавиши', key: '?', action: () => openDialogAbout(app, 'keys') },
      ],
    },
  ];
}

/** Обрезка холста по выделению */
function cropToSelection(app) {
  const r = app.selection.rect;
  if (!r) return;
  app.doc.crop(r);
  app.selection.clear();
  app.viewport.fit(app.doc.width, app.doc.height);
  app.renderer.invalidate();
  app.markChanged();
  app.emit('doc');
}

/** Инициализация верхней строки меню */
export function initMenus(app) {
  const host = qs('#menus');

  /** Пункты меню — либо массив, либо функция (для пунктов со сменой состояния) */
  const itemsOf = (def) => (typeof def.items === 'function' ? def.items() : def.items);

  function rebuild() {
    const defs = buildMenuDefinition(app);
    host.replaceChildren(...defs.map((def) => {
      const btn = el('button.menu-item', { type: 'button', text: def.label });
      btn.addEventListener('click', () => showDropdown(btn, itemsOf(def)));
      btn.addEventListener('pointerenter', () => {
        // Если меню уже открыто — переключаемся на соседний пункт
        if (qs('.menu-layer.is-open') && btn !== host.querySelector('.is-open')) {
          showDropdown(btn, itemsOf(def));
        }
      });
      return btn;
    }));
  }

  app.on('history', rebuild);
  app.on('tool', rebuild);
  // app.layers пересоздаётся при смене документа — слушаем App
  app.on('layers', debounced(rebuild));
  app.on('selection', rebuild);
  app.on('doc', rebuild);

  rebuild();
  return { rebuild };
}

function debounced(fn) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), 60);
  };
}