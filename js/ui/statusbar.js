/**
 * Нижняя панель: координаты под курсором, размер документа, зум,
 * тип указателя, индикатор давления пера и состояние автосохранения.
 */

import { qs, rafThrottle } from '../utils/dom.js';
import { formatBytes } from '../utils/math.js';

export function initStatusBar(app) {
  const coords = qs('#statusCoords');
  const size = qs('#statusSize');
  const zoom = qs('#statusZoom');
  const pointer = qs('#statusPointer');
  const save = qs('#statusSave');
  const pressureFill = qs('#pressureFill');
  const pressureLabel = qs('#pressureLabel');

  const setPressure = rafThrottle((value, type) => {
    const pct = Math.round(value * 100);
    pressureFill.style.height = `${pct}%`;
    pressureLabel.textContent = type === 'mouse' ? '—' : pct;
  });

  function updateZoom() {
    const text = `${app.viewport.zoomPercent}%`;
    if (zoom) zoom.textContent = text;
    const hud = qs('#zoomValue');
    if (hud) hud.textContent = text;
  }

  function updateSize() {
    if (!size) return;
    const doc = app.doc;
    size.textContent = `${doc.width} × ${doc.height} px · ${doc.layers.length} сл.`;
  }

  /* Курсор */
  app.on('cursor', ({ world, pointerType, pressure }) => {
    if (coords) coords.textContent = `${Math.floor(world.x)}, ${Math.floor(world.y)}`;
    if (pointer) {
      pointer.textContent = { mouse: 'мышь', pen: 'перо', touch: 'палец' }[pointerType] || pointerType;
    }
    setPressure(pressure ?? 0, pointerType);
  });

  /* Зум */
  app.viewport.on('change', updateZoom);
  app.on('zoom', updateZoom);

  /* Размер и слои */
  app.on('doc', updateSize);
  app.layers.on('change', updateSize);

  /* Состояние сохранения */
  let saveTimer = 0;
  app.on('autosave', () => {
    if (!save) return;
    save.textContent = 'сохранение…';
    save.classList.add('is-saving');
    app.emit('doAutosave');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      save.textContent = app.dirtySinceSave ? 'есть изменения' : 'сохранено';
      save.classList.toggle('is-saving', false);
      save.classList.toggle('is-saved', !app.dirtySinceSave);
    }, 600);
  });

  app.on('saved', () => {
    if (!save) return;
    save.textContent = 'сохранено';
    save.classList.remove('is-saving');
    save.classList.add('is-saved');
  });

  updateZoom();
  updateSize();

  /* Отладочный счётчик памяти (F3) */
  let memVisible = false;
  return {
    toggleMemory() {
      memVisible = !memVisible;
      if (!memVisible) { save.textContent = app.dirtySinceSave ? 'есть изменения' : 'сохранено'; return; }
      const tick = () => {
        if (!memVisible) return;
        const h = app.history;
        save.textContent = `история ${h.entries.length} шаг. · ${formatBytes(h.bytes)} · ${app.doc.layers.length} слоёв`;
        setTimeout(tick, 500);
      };
      tick();
    },
  };
}