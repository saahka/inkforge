/**
 * Горячие клавиши. Раскладка как в Photoshop/Krita, но с русскими подписями.
 * Все сочетания перечислены в одной таблице — её легко расширять и переназначать.
 */

import { clamp } from '../utils/math.js';
import {
  openDialogNew, openDialogOpenProject, openDialogSaveProject,
  openDialogGallery, openDialogAbout, openDialogExport,
} from './dialogs.js';
import { notify } from './notify.js';

const DEFAULT_COLOR = { r: 24, g: 26, b: 32 };

/** Список сочетаний: клавиша → обработчик */
export function buildShortcutTable(app) {
  return [
    // ─── Инструменты ───
    { key: 'b', label: 'B', run: () => app.setTool('brush') },
    { key: 'e', label: 'E', run: () => app.setTool('eraser') },
    { key: 'g', label: 'G', run: () => app.setTool('fill') },
    { key: 'shift+g', label: '⇧G', run: () => app.setTool('gradient') },
    { key: 'i', label: 'I', run: () => app.setTool('eyedropper') },
    { key: 'm', label: 'M', run: () => app.setTool('marquee') },
    { key: 'v', label: 'V', run: () => app.setTool('move') },
    { key: 'h', label: 'H', run: () => app.setTool('pan') },

    // ─── Кисть ───
    {
      key: '[', label: '[',
      run: () => {
        const b = app.activeBrush;
        const step = b.size > 100 ? 10 : (b.size > 20 ? 4 : 1);
        const next = clamp(b.size - step, 1, 2000);
        app.toolId === 'eraser' ? app.setEraserBrush({ size: next }) : app.setBrush({ size: next });
      },
    },
    {
      key: ']', label: ']',
      run: () => {
        const b = app.activeBrush;
        const step = b.size > 100 ? 10 : (b.size > 20 ? 4 : 1);
        const next = clamp(b.size + step, 1, 2000);
        app.toolId === 'eraser' ? app.setEraserBrush({ size: next }) : app.setBrush({ size: next });
      },
    },
    {
      key: 'shift+[', label: '⇧[',
      run: () => {
        const b = app.activeBrush;
        app.toolId === 'eraser'
          ? app.setEraserBrush({ hardness: clamp(b.hardness - 0.05, 0, 1) })
          : app.setBrush({ hardness: clamp(b.hardness - 0.05, 0, 1) });
      },
    },
    {
      key: 'shift+]', label: '⇧]',
      run: () => {
        const b = app.activeBrush;
        app.toolId === 'eraser'
          ? app.setEraserBrush({ hardness: clamp(b.hardness + 0.05, 0, 1) })
          : app.setBrush({ hardness: clamp(b.hardness + 0.05, 0, 1) });
      },
    },
    { key: 'd', label: 'D', run: () => { app.setColor(DEFAULT_COLOR, 'fg'); app.setColor({ r: 255, g: 255, b: 255 }, 'bg'); } },
    { key: 'x', label: 'X', run: () => app.swapColors() },

    // ─── Непрозрачность кисти цифрами ───
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
      key: String(n),
      label: String(n),
      run: () => {
        const v = n * 10;
        app.toolId === 'eraser'
          ? app.setEraserBrush({ opacity: v / 100 })
          : app.setBrush({ opacity: v / 100 });
      },
    })),
    { key: '0', label: '0', run: () => app.setBrush({ opacity: 1 }) },

    // ─── Выделение ───
    { key: 'ctrl+a', label: 'Ctrl+A', run: () => app.selection.selectAll() },
    { key: 'ctrl+d', label: 'Ctrl+D', run: () => app.selection.clear() },
    { key: 'ctrl+shift+i', label: '⇧Ctrl+I', run: () => app.selection.invert?.() },

    // ─── Слои ───
    { key: 'ctrl+shift+n', label: 'Ctrl+⇧N', run: () => app.layers.addLayer({ record: true }) },
    { key: 'ctrl+j', label: 'Ctrl+J', run: () => app.doc.activeLayer && app.layers.duplicateLayer(app.doc.activeLayer.id) },
    { key: 'ctrl+e', label: 'Ctrl+E', run: () => app.doc.activeLayer && app.layers.mergeDown(app.doc.activeLayer.id) },
    { key: 'ctrl+shift+e', label: 'Ctrl+⇧E', run: () => openDialogExport(app) },
    { key: 'ctrl+alt+e', label: 'Ctrl+Alt+E', run: () => app.layers.flatten() },
    { key: 'delete', label: 'Del', run: () => app.doc.activeLayer && app.layers.deleteLayer(app.doc.activeLayer.id) },
    { key: 'backspace', label: '⌫', run: () => app.doc.activeLayer && app.layers.clearLayer(app.doc.activeLayer) },
    { key: 'ctrl+shift+]', label: 'Ctrl+⇧]', run: () => app.doc.activeLayer && app.layers.moveLayer(app.doc.activeLayer.id, 1) },
    { key: 'ctrl+shift+[', label: 'Ctrl+⇧[', run: () => app.doc.activeLayer && app.layers.moveLayer(app.doc.activeLayer.id, -1) },

    // ─── История ───
    { key: 'ctrl+z', label: 'Ctrl+Z', run: () => app.history.undo() },
    { key: 'ctrl+y', label: 'Ctrl+Y', run: () => app.history.redo() },
    { key: 'ctrl+shift+z', label: 'Ctrl+⇧Z', run: () => app.history.redo() },

    // ─── Файл ───
    { key: 'ctrl+s', label: 'Ctrl+S', run: () => openDialogSaveProject(app, { silent: true }) },
    { key: 'ctrl+shift+s', label: 'Ctrl+⇧S', run: () => openDialogSaveProject(app) },
    { key: 'ctrl+n', label: 'Ctrl+N', run: () => openDialogNew(app) },
    { key: 'ctrl+o', label: 'Ctrl+O', run: () => openDialogOpenProject(app) },
    { key: 'ctrl+shift+g', label: 'Ctrl+⇧G', run: () => openDialogGallery(app) },

    // ─── Вид ───
    { key: 'ctrl+0', label: 'Ctrl+0', run: () => app.viewport.actualSize(app.doc.width, app.doc.height) },
    { key: 'ctrl+1', label: 'Ctrl+1', run: () => app.viewport.fit(app.doc.width, app.doc.height) },
    { key: 'ctrl+=', label: 'Ctrl++', run: () => app.viewport.setScale(app.viewport.scale * 1.25) },
    { key: 'ctrl+-', label: 'Ctrl+-', run: () => app.viewport.setScale(app.viewport.scale / 1.25) },
    { key: 'f11', label: 'F11', run: () => app.emit('toggleFocus') },
    { key: 'tab', label: 'Tab', run: () => app.emit('togglePanels') },
    { key: 'f3', label: 'F3', run: () => app.emit('toggleMemory') },
    { key: '?', label: '?', run: () => openDialogAbout(app, 'keys') },
    { key: 'shift+/', label: '⇧/', run: () => openDialogAbout(app, 'keys') },
  ];
}

/** Нормализация сочетания в строку вида "ctrl+shift+s" */
function comboOf(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  parts.push(e.key.toLowerCase());
  return parts.join('+');
}

const EDITABLE = /^(input|textarea|select)$/i;

export function installShortcuts(app) {
  const table = buildShortcutTable(app);
  const map = new Map();
  for (const item of table) {
    if (!map.has(item.key)) map.set(item.key, []);
    map.get(item.key).push(item);
  }

  const onKeyDown = (e) => {
    const target = e.target;
    // Не перехватываем ввод в полях и contenteditable
    if (EDITABLE.test(target.tagName) || target.isContentEditable) {
      if (e.key === 'Escape') target.blur();
      return;
    }
    // Буквенные сочетания работают и в русской раскладке (по e.code)
    let combo = comboOf(e);
    if (!map.has(combo)) {
      const codeCombo = `${e.ctrlKey || e.metaKey ? 'ctrl+' : ''}${e.shiftKey ? 'shift+' : ''}${e.code.replace(/^Key|^Digit/, '').toLowerCase()}`;
      combo = map.has(codeCombo) ? codeCombo : combo;
    }

    const items = map.get(combo);
    if (!items) return;
    e.preventDefault();
    for (const item of items) {
      try { item.run(); } catch (err) { notify(err.message, 'error'); }
    }
  };

  window.addEventListener('keydown', onKeyDown);
  return { table, map, dispose: () => window.removeEventListener('keydown', onKeyDown) };
}