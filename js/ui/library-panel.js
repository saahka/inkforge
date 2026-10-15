/**
 * Панель «Библиотека» — папка с готовыми работами.
 *
 * Показывает карточки с превью: клик открывает работу (со слоями, если проект
 * сохранился), звёздочка отмечает любимое, правый клик — меню действий.
 * Список берётся из библиотеки в памяти и перерисовывается точечно:
 * при 200 работах это дешевле, чем полная перерисовка на каждый чих.
 */

import { el, qs, on, debounce } from '../utils/dom.js';
import { formatDate } from '../utils/math.js';
import { library } from '../storage/library.js';
import { notify } from './notify.js';
import {
  openArtworkDialog, openLibraryDialog, confirmDialog,
} from './dialogs.js';

/** Иконка-звезда */
function starIcon(filled) {
  return el('button.lib-card__star', {
    type: 'button',
    title: filled ? 'Убрать из избранного' : 'В избранное',
    text: filled ? '★' : '☆',
  });
}

export function initLibraryPanel(app) {
  const panel = qs('#panelLibrary');
  const grid = qs('#libraryGrid');
  const search = qs('#librarySearch');
  const sort = qs('#librarySort');
  if (!panel || !grid) return { render: () => {} };

  const state = { search: '', sort: 'date' };

  /* ─── Кнопки заголовка ──────────────────────────────────────── */

  on(panel.querySelector('[data-lib="add"]'), 'click', () => openArtworkDialog(app));
  on(panel.querySelector('[data-lib="refresh"]'), 'click', async () => {
    await library.load();
    render();
    notify(`Библиотека обновлена: ${library.items.length}`, 'ok');
  });

  on(search, 'input', debounce(() => {
    state.search = search.value;
    render();
  }, 120));

  on(sort, 'change', () => {
    state.sort = sort.value;
    render();
  });

  /* ─── Отрисовка ─────────────────────────────────────────────── */

  function card(item) {
    const node = el('div.lib-card', {
      dataset: { id: item.id },
      class: item.starred ? 'is-starred' : '',
      title: `${item.title}\n${item.width}×${item.height}\n${formatDate(item.updatedAt)}`,
      onclick: () => openItem(item),
      oncontextmenu: (e) => { e.preventDefault(); showItemMenu(e, item); },
    }, [
      el('img.lib-card__thumb', { src: item.thumb, alt: '', loading: 'lazy' }),
      item.projectId ? el('span.lib-card__link', { text: 'проект' }) : null,
      el('div.lib-card__body', null, [
        el('div.lib-card__title', {
          text: item.title,
          ondblclick: (e) => startRename(e.currentTarget, item),
        }),
        el('div.lib-card__meta', { text: `${item.width}×${item.height} · ${formatDate(item.updatedAt)}` }),
      ]),
    ]);

    const star = starIcon(item.starred);
    star.addEventListener('click', (e) => {
      e.stopPropagation();
      library.toggleStar(item.id);
    });
    node.append(star);
    return node;
  }

  function render() {
    const list = library.query(state);
    grid.replaceChildren();

    if (!list.length) {
      grid.append(el('div.library-empty', {
        html: library.items.length
          ? 'Ничего не найдено.<br>Измените запрос поиска.'
          : 'Библиотека пуста.<br>Дорисуйте картинку и нажмите <b>Ctrl+Shift+L</b>,<br>чтобы сохранить арт сюда.',
      }));
      return;
    }

    for (const item of list) grid.append(card(item));
  }

  /* ─── Действия ──────────────────────────────────────────────── */

  async function openItem(item) {
    try {
      const how = await library.open(item.id, app);
      notify(how === 'project' ? `Открыт проект «${item.title}»` : `Открыто изображение «${item.title}»`, 'ok');
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  function startRename(node, item) {
    node.contentEditable = 'true';
    node.focus();
    const range = document.createRange();
    range.selectNodeContents(node);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const finish = () => {
      node.contentEditable = 'false';
      const value = node.textContent.trim();
      if (value && value !== item.title) library.setTitle(item.id, value);
      else node.textContent = item.title;
    };
    node.addEventListener('blur', finish, { once: true });
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); node.blur(); }
      if (e.key === 'Escape') { node.textContent = item.title; node.blur(); }
    });
  }

  function showItemMenu(e, item) {
    import('./menus.js').then(({ showContextMenu }) => {
      showContextMenu(e.clientX, e.clientY, [
        { label: 'Открыть', action: () => openItem(item) },
        { label: 'Скачать PNG', action: () => library.downloadDirect(item.id).then((ok) => {
          if (ok) notify('Файл сохранён', 'ok');
        }) },
        { sep: true },
        {
          label: 'Скачать в другом формате…',
          action: () => import('./dialogs.js').then((d) => d.openArtworkExportDialog(app, item)),
        },
        {
          label: 'В избранное',
          checked: item.starred,
          action: () => library.toggleStar(item.id),
        },
        {
          label: 'Перезаписать текущим холстом',
          disabled: !item.projectId,
          action: async () => {
            try {
              await library.recapture(app, item.id);
              notify('Работа обновлена', 'ok');
            } catch (err) { notify(err.message, 'error'); }
          },
        },
        { sep: true },
        { label: 'Переименовать', action: () => {
          const node = grid.querySelector(`[data-id="${item.id}"] .lib-card__title`);
          if (node) startRename(node, item);
        } },
        { label: 'Открыть библиотеку…', action: () => openLibraryDialog(app) },
        { sep: true },
        { label: 'Удалить', danger: true, action: async () => {
          if (!(await confirmDialog('Удалить работу?', `«${item.title}» будет удалено из библиотеки.`, { danger: true, okLabel: 'Удалить' }))) return;
          await library.remove(item.id);
          notify('Работа удалена', 'ok');
        } },
      ]);
    });
  }

  /* ─── Реакция на изменения ───────────────────────────────────── */

  library.on('change', render);
  library.ensureLoaded().then(render);

  return { render, openItem, card };
}

/** Панель и меню библиотеки должны обновляться при добавлении/удалении */
export function bindLibraryToApp(app) {
  library.on('change', () => {
    app.emit('library', library.stats());
  });
}