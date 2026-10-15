/**
 * Точка входа: собирает ядро и интерфейс, навешивает глобальные обработчики.
 * Здесь нет логики рисования — только связывание частей.
 */

import { App } from './core/app.js';
import { InputHandler } from './core/input-handler.js';
import { projectStore } from './storage/project-store.js';
import { initToolPanel, initColorPanel, initLayersPanel, initHistoryPanel } from './ui/panels.js';
import { initMenus } from './ui/menus.js';
import { installShortcuts } from './ui/shortcuts.js';
import { initStatusBar } from './ui/statusbar.js';
import { notify, notifyError } from './ui/notify.js';
import { promptOpenImage, closeModal } from './ui/dialogs.js';
import { qs, qsa, on, debounce, bindDropZone } from './utils/dom.js';
import { imageToDocument } from './utils/file.js';

const THEME_KEY = 'inkforge.theme';

boot();

function boot() {
  const stage = qs('#stage');
  const viewCanvas = qs('#viewCanvas');
  const overlayCanvas = qs('#overlayCanvas');

  if (!stage || !viewCanvas || !overlayCanvas) {
    fatal('Не найден разметка холста. Проверьте, что index.html загрузился целиком.');
    return;
  }

  // ─── Тема до первой отрисовки (чтобы не мигало) ───
  initTheme();

  // ─── Ядро ───
  const app = new App({ stage, viewCanvas, overlayCanvas });
  app.init();

  // Инструменты рисуют курсор и вспомогательные элементы в оверлее
  app.renderer.onOverlay((ctx, renderer) => app.tool?.drawOverlay?.(ctx, renderer));

  const input = new InputHandler(app).attach(stage);

  // ─── Интерфейс ───
  initToolPanel(app);
  initColorPanel(app);
  initLayersPanel(app);
  initHistoryPanel(app);
  initMenus(app);
  const status = initStatusBar(app);
  installShortcuts(app);
  initToolbar(app);
  initTopBar(app);
  initZoomHud(app);
  initPanelsUI(app);
  initDocumentTitle(app);
  bindDropZone(document.body, (files) => handleFiles(app, files));
  bindPaste(app);

  // ─── Глобальные события приложения ───
  app.on('toast', ({ text, kind }) => notify(text, kind));
  app.on('toggleFocus', () => {
    const node = qs('#app');
    node.classList.toggle('is-focus');
    requestAnimationFrame(() => app.renderer.resize());
  });
  app.on('togglePanels', () => {
    const node = qs('#app');
    node.classList.toggle('is-hidden-chrome');
    requestAnimationFrame(() => app.renderer.resize());
  });
  app.on('toggleMemory', () => status.toggleMemory());
  app.on('toggleToolKeys', () => {
    const bar = qs('#toolbar');
    const on_ = bar.classList.toggle('show-keys');
    document.documentElement.dataset.showKeys = on_ ? '1' : '0';
  });
  app.on('openImageDialog', () => promptOpenImage(app));
  app.on('doAutosave', () => {
    projectStore.autosave(app).then((ok) => { if (ok) app.markSaved(); });
  });

  // ─── Пересчёт размеров ───
  const ro = new ResizeObserver(debounce(() => app.renderer.resize(), 80));
  ro.observe(stage);
  window.addEventListener('resize', () => app.renderer.resize());

  // ─── Предупреждение о несохранённом ───
  window.addEventListener('beforeunload', (e) => {
    if (!app.dirtySinceSave) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // ─── Открытие базы при старте ───
  projectStore.open().catch((err) => {
    notifyError(err);
    notify('Проекты не будут сохраняться: IndexedDB недоступна', 'error');
  });

  // ─── Отладочный доступ ───
  globalThis.INKFORGE = { app, input, projectStore, closeModal };
}

/* ─── Панель инструментов ─────────────────────────────────────────── */

function initToolbar(app) {
  const bar = qs('#toolbar');

  const sync = () => {
    for (const btn of qsa('.tool-btn', bar)) {
      btn.classList.toggle('is-active', btn.dataset.tool === app.toolId);
    }
  };

  on(bar, 'click', (e) => {
    const btn = e.target.closest('.tool-btn');
    if (btn?.dataset.tool) app.setTool(btn.dataset.tool);
  });

  app.on('tool', sync);
  sync();
}

/* ─── Верхняя панель: заголовок, тема, фокус, отмена ──────────────── */

function initTopBar(app) {
  const themeBtn = qs('#btnTheme');
  const focusBtn = qs('#btnFocus');
  const undoBtn = qs('#btnUndo');
  const redoBtn = qs('#btnRedo');

  on(themeBtn, 'click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem(THEME_KEY, next);
    app.renderer.invalidateTheme();
    app.emit('color');   // градиенты палитры перерисовать
  });

  on(focusBtn, 'click', () => app.emit('toggleFocus'));

  on(undoBtn, 'click', () => app.history.undo());
  on(redoBtn, 'click', () => app.history.redo());

  const sync = () => {
    undoBtn.disabled = !app.history.canUndo();
    redoBtn.disabled = !app.history.canRedo();
    undoBtn.title = app.history.canUndo()
      ? `Отменить: ${app.history.entries[app.history.cursor - 1].label} (Ctrl+Z)`
      : 'Отменить (Ctrl+Z)';
  };
  app.on('history', sync);
  sync();
}

/* ─── Плавающий индикатор масштаба ────────────────────────────────── */

function initZoomHud(app) {
  const value = qs('#zoomValue');
  on(qs('#zoomIn'), 'click', () => app.viewport.setScale(app.viewport.scale * 1.25));
  on(qs('#zoomOut'), 'click', () => app.viewport.setScale(app.viewport.scale / 1.25));
  on(qs('#zoomFit'), 'click', () => app.viewport.fit(app.doc.width, app.doc.height));
  on(value, 'click', () => app.viewport.actualSize(app.doc.width, app.doc.height));
}

/* ─── Сворачивание панелей ────────────────────────────────────────── */

function initPanelsUI(app) {
  for (const panel of qsa('.panel')) {
    const btn = panel.querySelector('[data-collapse]');
    if (!btn) continue;
    btn.addEventListener('click', () => {
      panel.classList.toggle('is-collapsed');
      btn.textContent = panel.classList.contains('is-collapsed') ? '+' : '–';
      requestAnimationFrame(() => app.renderer.resize());
    });
  }
}

/* ─── Заголовок документа ─────────────────────────────────────────── */

function initDocumentTitle(app) {
  const input = qs('#docTitle');
  app.docNameInput = input;
  input.value = app.doc.name;

  on(input, 'input', () => {
    app.doc.name = input.value || 'Без имени';
    app.markChanged();
  });
  app.on('doc', () => { input.value = app.doc.name; });
}

/** Вставка картинки из буфера обмена (Ctrl+V) новым слоем */
function bindPaste(app) {
  on(window, 'paste', async (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const imageItem = items.find((i) => i.type.startsWith('image/'));
    const file = imageItem?.getAsFile();
    if (!file) return;
    e.preventDefault();
    try {
      const { imageToLayer } = await import('./utils/file.js');
      await imageToLayer(app, file);
      app.markChanged();
      notify('Изображение вставлено новым слоем', 'ok');
    } catch (err) {
      notifyError(err);
    }
  });
}

/* ─── Drag & drop файлов ──────────────────────────────────────────── */

async function handleFiles(app, files) {
  for (const file of files) {
    try {
      if (/^image\//.test(file.type)) {
        if (files.length > 1 && app.doc.layers.length > 0) {
          const { imageToLayer } = await import('./utils/file.js');
          await imageToLayer(app, file);
          app.markChanged();
          notify(`Слой «${file.name}» добавлен`, 'ok');
        } else {
          const doc = await imageToDocument(file);
          app.setDocument(doc);
          app.projectId = null;
          notify(`Открыто ${doc.width}×${doc.height}`, 'ok');
        }
      } else if (/\.json$/i.test(file.name)) {
        const json = JSON.parse(await file.text());
        if (json.format) {
          const { deserializeProject } = await import('./utils/file.js');
          const result = await deserializeProject(json);
          app.setDocument(result.doc);
          app.projectId = null;
          notify(`Открыт проект «${result.doc.name}»`, 'ok');
        }
      } else {
        notify(`Не удалось определить тип файла: ${file.name}`, 'error');
      }
    } catch (err) {
      notifyError(err);
    }
  }
}

/* ─── Тема ────────────────────────────────────────────────────────── */

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const theme = saved || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.dataset.theme = theme;
}

/* ─── Аварийный экран ─────────────────────────────────────────────── */

function fatal(text) {
  const stage = qs('#stage');
  if (!stage) return;
  const node = document.createElement('div');
  node.className = 'stage__fatal';
  node.textContent = text;
  stage.append(node);
}