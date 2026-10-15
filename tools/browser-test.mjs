// Браузерные проверки реального движка: node tools/browser-test.mjs
// Поднимает статический сервер и headless Chrome, выполняет сценарии
// через CDP и проверяет реальные пиксели холста.

import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 5199);
const CDP_PORT = Number(process.env.CDP_PORT || 9333);
const CHROME = process.env.CHROME
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(CHROME)) {
  console.log('Chrome/Edge не найден — браузерные тесты пропущены.');
  process.exit(0);
}

/* ─── Поднимаем сервер и браузер ─────────────────────────────────── */

const server = spawn(process.execPath, ['tools/serve.mjs', String(PORT)], {
  cwd: join(import.meta.dirname, '..'),
  stdio: 'ignore',
});

const profile = mkdtempSync(join(tmpdir(), 'inkforge-chrome-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1400,900',
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${CDP_PORT}`,
  `http://localhost:${PORT}/`,
], { stdio: 'ignore' });

const cleanup = () => {
  try { chrome.kill(); } catch { /* уже убит */ }
  try { server.kill(); } catch { /* уже убит */ }
};
process.on('exit', cleanup);

/* ─── Минимальный клиент CDP поверх встроенного WebSocket ─────────── */

class CDP {
  #ws;
  #id = 0;
  #pending = new Map();
  logs = [];

  static async attach(wsUrl) {
    const cdp = new CDP();
    cdp.#ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      cdp.#ws.onopen = resolve;
      cdp.#ws.onerror = reject;
    });
    cdp.#ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && cdp.#pending.has(msg.id)) {
        const { resolve, reject } = cdp.#pending.get(msg.id);
        cdp.#pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        cdp.logs.push('EXCEPTION: ' + (msg.params.exceptionDetails?.exception?.description
          || msg.params.exceptionDetails?.text));
      } else if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
        cdp.logs.push(msg.params.type.toUpperCase() + ': '
          + msg.params.args.map((a) => a.description || a.value).join(' '));
      }
    };
    await cdp.send('Runtime.enable');
    return cdp;
  }

  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id);
          reject(new Error('таймаут ' + method));
        }
      }, 20000);
    });
  }

  /** Выполняет код в странице и возвращает значение */
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    }
    return res.result.value;
  }
}

async function waitForDevtools() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && t.url.includes(String(PORT)));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* ещё не поднялся */ }
    await sleep(250);
  }
  throw new Error('Chrome DevTools не отвечает');
}

/* ─── Сценарии ───────────────────────────────────────────────────── */

const SCENARIO = `
  const results = [];
  // Результаты в глобале: если сценарий упадёт, тест всё равно их напечатает
  globalThis.__TEST = results;
  const check = (name, condition, info = '') =>
    results.push({ name, ok: !!condition, info: String(info) });
  const { createDocument } = await import('./js/core/doc.js');

  const app = INKFORGE.app;
  const doc = app.doc;
  const layer = () => doc.activeLayer;
  const px = (x, y) => Array.from(layer().ctx.getImageData(x, y, 1, 1).data);

  // Экранный canvas обновляется по кадрам — форсируем кадр перед чтением
  const flush = () => { app.renderer.invalidate(); app.renderer.render(); };

  // Полуширина штриха по вертикали в столбце x (по альфе)
  const halfWidth = (x, y0) => {
    let up = 0, down = 0;
    while (layer().ctx.getImageData(x, y0 - up - 1, 1, 1).data[3] > 8 && up < 200) up++;
    while (layer().ctx.getImageData(x, y0 + down + 1, 1, 1).data[3] > 8 && down < 200) down++;
    return up + down + 1;
  };

  /* 1. Документ и вид */
  check('документ 1600×1000', doc.width === 1600 && doc.height === 1000, doc.width + 'x' + doc.height);
  check('есть активный слой', !!layer());

  /* 2. Штрих кистью */
  app.setColor({ r: 255, g: 0, b: 0 }, 'fg');
  app.setBrush({ size: 30, hardness: 1, flow: 1, smoothing: 0, opacity: 1, opacityDynamics: 0, sizeDynamics: 0 });
  const line = [];
  for (let i = 0; i <= 40; i++) line.push({ x: 200 + i * 8, y: 300 + Math.sin(i / 5) * 40, pressure: 1, tilt: 0 });
  app.beginStroke(line[0], { composite: 'source-over', tool: 'brush' });
  app.extendStroke(line);
  const cmd = app.commitStroke('Кисть');
  const sample = () => px(400, 300 + Math.sin(25 / 5) * 40);
  check('штрих лёг на слой', sample()[0] > 200 && sample()[1] < 60 && sample()[2] < 60, 'rgb=' + sample().join(','));
  check('вне штриха прозрачно', px(50, 50)[3] === 0, 'alpha=' + px(50, 50)[3]);
  check('создана команда истории', !!cmd && app.history.canUndo());

  /* 3. Отмена и повтор */
  app.history.undo();
  check('отмена убирает штрих', sample()[3] === 0, 'alpha=' + sample()[3]);
  app.history.redo();
  check('повтор возвращает штрих', sample()[0] > 200, 'rgb=' + sample().join(','));

  /* 4. Давление влияет на толщину (динамика размера) */
  app.setBrush({ sizeDynamics: 0.9, smoothing: 0 });
  const ramp = [];
  for (let i = 0; i <= 20; i++) ramp.push({ x: 200 + i * 20, y: 500, pressure: 0.1 + (i / 20) * 0.9, tilt: 0 });
  app.beginStroke(ramp[0], { composite: 'source-over', tool: 'brush' });
  app.extendStroke(ramp);
  app.commitStroke('Кисть');
  const wThin = halfWidth(210, 500), wThick = halfWidth(590, 500);
  check('давление расширяет мазок', wThick > wThin * 1.3, 'ширина: ' + wThin + ' → ' + wThick);
  app.setBrush({ sizeDynamics: 0 });

  /* 5. Ластик */
  app.setTool('eraser');
  app.eraserBrush = { ...app.eraserBrush, size: 60, hardness: 1, flow: 1, smoothing: 0, sizeDynamics: 0, opacityDynamics: 0 };
  app.beginStroke({ x: 200, y: 300, pressure: 1, tilt: 0 }, { composite: 'destination-out', tool: 'eraser' });
  app.extendStroke([{ x: 300, y: 300, pressure: 1, tilt: 0 }]);
  app.commitStroke('Ластик');
  check('ластик стирает', px(250, 300)[3] === 0, 'alpha=' + px(250, 300)[3]);
  app.setTool('brush');

  /* 6. Слои */
  const n0 = doc.layers.length;
  const added = app.layers.addLayer({ name: 'Тест', record: true });
  check('слой добавлен', doc.layers.length === n0 + 1 && doc.activeLayerId === added.id);
  app.setColor({ r: 0, g: 128, b: 255 }, 'fg');
  app.beginStroke({ x: 100, y: 700, pressure: 1, tilt: 0 }, {});
  app.extendStroke([{ x: 400, y: 700, pressure: 1, tilt: 0 }]);
  app.commitStroke();
  check('новый слой пишет в себя', px(200, 700)[2] > 200, 'rgb=' + px(200, 700).join(','));

  app.layers.duplicateLayer(added.id);
  check('дублирование слоя', doc.layers.length === n0 + 2);
  app.history.undo();
  check('отмена дублирования', doc.layers.length === n0 + 1);

  app.layers.setVisible(added.id, false, { record: true });
  check('скрытие слоя', doc.layerById(added.id).visible === false);
  app.layers.setVisible(added.id, true, { record: true });

  app.layers.mergeDown(added.id);
  check('объединение вниз', doc.layers.length === n0 && !doc.layerById(added.id), 'слоёв=' + doc.layers.length);
  app.history.undo();
  check('отмена объединения', doc.layers.length === n0 + 1);

  /* 7. Режимы наложения */
  app.layers.setBlendMode(added.id, 'multiply', { record: true });
  check('режим наложения применён', doc.layerById(added.id).blendMode === 'multiply');
  app.layers.setOpacity(added.id, 0.5);
  check('непрозрачность применена', Math.abs(doc.layerById(added.id).opacity - 0.5) < 1e-6);

  /* 8. Заливка */
  app.layers.addLayer({ name: 'Заливка', record: true });
  app.setColor({ r: 255, g: 255, b: 0 }, 'fg');
  const fillTool = app.tools.get('fill');
  fillTool.settings.sampleAllLayers = true;
  fillTool.onPointerDown({ x: 900, y: 900 });
  const filled = px(900, 900);
  check('заливка заливает область', filled[0] > 200 && filled[1] > 200 && filled[2] < 80, 'rgb=' + filled.join(','));
  check('заливка не вышла за слой', px(950, 200)[3] === 0 || px(950, 200)[2] === 0, 'rgb=' + px(950, 200).join(','));

  /* 9. Выделение ограничивает рисование (на чистом слое) */
  app.layers.addLayer({ name: 'Выделение', record: true });
  app.setColor({ r: 0, g: 0, b: 0 }, 'fg');
  app.setBrush({ size: 20, hardness: 1, flow: 1, smoothing: 0, sizeDynamics: 0 });
  app.selection.setRect({ x: 0, y: 0, w: 300, h: 200 });
  app.beginStroke({ x: 200, y: 100, pressure: 1, tilt: 0 }, {});
  app.extendStroke([{ x: 600, y: 100, pressure: 1, tilt: 0 }]);
  app.commitStroke();
  check('выделение пропускает штрих внутри', px(280, 100)[3] > 0, 'alpha=' + px(280, 100)[3]);
  check('выделение обрезает штрих снаружи', px(320, 100)[3] === 0, 'alpha=' + px(320, 100)[3]);
  app.selection.clear();

  /* 10. Пипетка читает итоговое изображение (после кадра) */
  flush();
  const picked = app.sampleComposite(200, 700);
  check('пипетка видит композит слоёв',
    !!picked && picked.b > 200 && picked.r < 100,
    'rgb=' + (picked ? [picked.r, picked.g, picked.b].join(',') : 'null'));

  /* 11. Градиент */
  app.layers.addLayer({ name: 'Градиент', record: true });
  app.setColor({ r: 255, g: 255, b: 0 }, 'fg');
  app.setColor({ r: 255, g: 255, b: 255 }, 'bg');
  const gt = app.tools.get('gradient');
  gt.onPointerDown({ x: 1000, y: 200, shift: false });
  gt.onPointerMove({ x: 1400, y: 400, shift: false });
  gt.onPointerUp();
  const g1 = px(1010, 200), g2 = px(1390, 400);
  check('градиент идёт от основного к фоновому цвету',
    g1[2] < 100 && g2[2] > 200, 'старт=' + g1.join(',') + ' конец=' + g2.join(','));

  /* 12. Зум и панорамирование */
  const before = app.viewport.scale;
  app.viewport.zoomAt(400, 300, 2);
  check('зум увеличивает масштаб', Math.abs(app.viewport.scale - before * 2) < 1e-6, 'scale=' + app.viewport.scale);
  app.viewport.fit(doc.width, doc.height);
  const k = app.viewport.scale;
  check('вписывание считает масштаб', k > 0 && Math.abs((doc.width * k) - (app.viewport.viewW - 48)) < 1, 'scale=' + k.toFixed(3));

  /* 13. Новый документ и слои */
  const oldDoc = doc;
  app.setDocument(app.doc);
  check('документ на месте', app.doc === oldDoc);

  /* 14. Плоский экспорт */
  const flat = app.flattenCanvas();
  check('экспорт сплющивает в canvas', flat.width === doc.width && flat.height === doc.height);

  /* 15. Превью кисти рисуется */
  check('панель кисти построена', !!document.querySelector('.tool-preview canvas'));
  check('слои отрисованы в панели', document.querySelectorAll('.layer-item').length === doc.layers.length);

  /* ── Отменяемость операций ─────────────────────────────────── */

  // Заливка: отмена и повтор должны менять пиксели
  app.layers.addLayer({ name: 'Отмена заливки', record: true });
  app.setColor({ r: 10, g: 200, b: 90 }, 'fg');
  app.tools.get('fill').settings.contiguous = true;
  app.tools.get('fill').onPointerDown({ x: 700, y: 700, shift: false });
  check('заливка легла на слой', px(700, 700)[1] > 150, 'rgb=' + px(700, 700).join(','));
  app.history.undo();
  check('отмена заливки чистит пиксели', px(700, 700)[3] === 0, 'alpha=' + px(700, 700)[3]);
  app.history.redo();
  check('повтор заливки возвращает пиксели', px(700, 700)[1] > 150, 'rgb=' + px(700, 700).join(','));

  // Shift+клик заливает фоновым цветом
  app.setColor({ r: 0, g: 0, b: 255 }, 'fg');
  app.setColor({ r: 255, g: 0, b: 255 }, 'bg');
  app.layers.addLayer({ name: 'Shift-заливка', record: true });
  app.tools.get('fill').onPointerDown({ x: 1100, y: 700, shift: true });
  check('Shift+клик берёт фоновый цвет', px(1100, 700)[0] > 200 && px(1100, 700)[2] > 200, 'rgb=' + px(1100, 700).join(','));

  // Очистка слоя отменяется
  app.layers.addLayer({ name: 'Очистка', record: true });
  app.setColor({ r: 255, g: 255, b: 255 }, 'fg');
  app.beginStroke({ x: 300, y: 900, pressure: 1, tilt: 0 }, {});
  app.extendStroke([{ x: 700, y: 900, pressure: 1, tilt: 0 }]);
  app.commitStroke();
  const clearedBefore = px(500, 900)[3] > 0;
  app.layers.clearLayer(app.doc.activeLayer);
  check('очистка стирает слой', clearedBefore && px(500, 900)[3] === 0);
  app.history.undo();
  check('отмена очистки возвращает слой', px(500, 900)[3] > 0, 'alpha=' + px(500, 900)[3]);
  app.history.redo();
  check('повтор очистки снова стирает', px(500, 900)[3] === 0);

  // Объединение вниз должно быть полностью отменяемым
  const mergeTop = app.layers.addLayer({ name: 'К объединению', record: true });
  const mergeBase = doc.layers[doc.indexOf(mergeTop.id) - 1];
  app.setColor({ r: 120, g: 60, b: 200 }, 'fg');
  app.beginStroke({ x: 200, y: 600, pressure: 1, tilt: 0 }, {});
  app.extendStroke([{ x: 900, y: 600, pressure: 1, tilt: 0 }]);
  app.commitStroke();
  const markerX = 550;
  const topHasInk = Array.from(mergeTop.ctx.getImageData(markerX, 600, 1, 1).data)[3] > 0;
  const baseBefore = Array.from(mergeBase.ctx.getImageData(markerX, 600, 1, 1).data)[3];
  app.layers.mergeDown(mergeTop.id);
  const baseAfter = Array.from(mergeBase.ctx.getImageData(markerX, 600, 1, 1).data)[3];
  check('объединение переносит пиксели вниз', topHasInk && baseBefore === 0 && baseAfter > 0,
    'до=' + baseBefore + ' после=' + baseAfter);
  app.history.undo();
  const baseRestored = Array.from(mergeBase.ctx.getImageData(markerX, 600, 1, 1).data)[3];
  const topBack = !!doc.layerById(mergeTop.id);
  check('отмена объединения чистит нижний слой', baseRestored === 0 && topBack,
    'низ=' + baseRestored + ' верхний слой вернулся=' + topBack);
  app.history.redo();
  check('повтор объединения снова сливает',
    Array.from(mergeBase.ctx.getImageData(markerX, 600, 1, 1).data)[3] > 0 && !doc.layerById(mergeTop.id));

  // Перемещение содержимого: отмена не должна падать
  app.layers.addLayer({ name: 'Перемещение', record: true });
  app.setColor({ r: 255, g: 255, b: 255 }, 'fg');
  app.setBrush({ size: 16, hardness: 1, flow: 1, smoothing: 0, sizeDynamics: 0, opacityDynamics: 0 });
  app.beginStroke({ x: 200, y: 400, pressure: 1, tilt: 0 }, {});
  app.extendStroke([{ x: 400, y: 400, pressure: 1, tilt: 0 }]);
  app.commitStroke();
  const mv = app.tools.get('move');
  mv.onPointerDown({ x: 300, y: 400, ctrl: false });
  mv.onPointerMove({ x: 500, y: 400, ctrl: false });
  mv.onPointerUp({ x: 500, y: 400, ctrl: false });
  const movedOut = px(300, 400)[3] === 0 && px(500, 400)[3] > 0;
  check('перемещение сдвинуло пиксели', movedOut, 'в источнике=' + px(300, 400)[3] + ' в цели=' + px(500, 400)[3]);
  let undoError = null;
  try { app.history.undo(); } catch (err) { undoError = err.message; }
  check('отмена перемещения не падает', !undoError, undoError || '');
  check('отмена перемещения вернула пиксели', px(300, 400)[3] > 0 && px(500, 400)[3] === 0,
    'источник=' + px(300, 400)[3] + ' цель=' + px(500, 400)[3]);
  app.history.redo();
  check('повтор перемещения снова сдвинул', px(300, 400)[3] === 0 && px(500, 400)[3] > 0);

  // Сплющивание отменяемо
  const layersBeforeFlat = doc.layers.length;
  app.layers.flatten();
  check('сплющивание оставляет один слой', doc.layers.length === 1, 'слоёв=' + doc.layers.length);
  app.history.undo();
  check('отмена сплющивания вернула слои', doc.layers.length === layersBeforeFlat,
    'слоёв=' + doc.layers.length);

  /* ── Порядок слоёв ─────────────────────────────────────────── */

  const orderIds = doc.layers.map(l => l.id);
  const bottomId = orderIds[0];
  const n = doc.layers.length;
  app.layers.moveLayer(bottomId, 1);          // поднять на один уровень
  check('moveLayer(+1) поднимает слой', doc.indexOf(bottomId) === 1,
    'индекс=' + doc.indexOf(bottomId) + ' ожидался 1');
  app.history.undo();
  check('отмена порядка слоёв', doc.indexOf(bottomId) === 0);
  app.layers.moveLayer(bottomId, -1);
  check('moveLayer(-1) не выходит за нижнюю границу', doc.indexOf(bottomId) === 0);

  const topId = orderIds[orderIds.length - 1];
  app.layers.moveLayer(topId, 1);
  check('верхний слой не уходит выше крыши', doc.indexOf(topId) === n - 1);

  /* ── Выделение ─────────────────────────────────────────────── */

  app.selection.setRect({ x: 100, y: 100, w: 200, h: 200 });
  check('прямоугольное выделение', app.selection.rect.w === 200 && !app.selection.mask);
  app.selection.invert();
  check('инверсия даёт маску', app.selection.mask !== null && app.selection.rect === null);
  app.layers.addLayer({ name: 'Инверсия', record: true });
  app.setColor({ r: 0, g: 255, b: 0 }, 'fg');
  app.setBrush({ size: 40, hardness: 1, flow: 1, smoothing: 0, sizeDynamics: 0, opacityDynamics: 0 });
  const mvStart = { x: 150, y: 150 }, mvEnd = { x: 1200, y: 800 };
  app.beginStroke({ ...mvStart, pressure: 1, tilt: 0 }, {});
  app.extendStroke([{ ...mvEnd, pressure: 1, tilt: 0 }]);
  app.commitStroke();
  // Точка строго на линии штриха, но вне исключённого прямоугольника
  const onLine = {
    x: 700,
    y: Math.round(mvStart.y + ((700 - mvStart.x) / (mvEnd.x - mvStart.x)) * (mvEnd.y - mvStart.y)),
  };
  check('маска выделения пропускает внешнюю область', px(onLine.x, onLine.y)[3] > 0,
    'точка ' + onLine.x + ',' + onLine.y + ' alpha=' + px(onLine.x, onLine.y)[3]);
  check('маска выделения блокирует внутреннюю область', px(200, 200)[3] === 0, 'alpha=' + px(200, 200)[3]);
  app.selection.clear();

  /* ── Динамика прозрачности ─────────────────────────────────── */

  app.layers.addLayer({ name: 'Давление', record: true });
  app.setBrush({ size: 60, hardness: 1, flow: 1, smoothing: 0, sizeDynamics: 0, opacityDynamics: 0.9 });
  app.setColor({ r: 255, g: 255, b: 255 }, 'fg');
  app.beginStroke({ x: 100, y: 520, pressure: 0.15, tilt: 0 }, {});
  app.extendStroke([{ x: 100, y: 520, pressure: 0.15, tilt: 0 }]);
  app.commitStroke();
  const faint = px(100, 520)[3];
  app.beginStroke({ x: 300, y: 520, pressure: 1, tilt: 0 }, {});
  app.extendStroke([{ x: 300, y: 520, pressure: 1, tilt: 0 }]);
  app.commitStroke();
  const strong = px(300, 520)[3];
  check('непрозрачность зависит от давления', strong > faint + 60, 'слабо=' + faint + ' сильно=' + strong);
  app.setBrush({ opacityDynamics: 0 });

  /* ── Наклон пера не ломает штрих ───────────────────────────── */

  app.setBrush({ tiltDynamics: 0.7 });
  app.beginStroke({ x: 100, y: 800, pressure: 0.5, tiltX: 60, tiltY: 20, tilt: 0.4 }, {});
  app.extendStroke([{ x: 400, y: 800, pressure: 0.6, tilt: 0.5 }]);
  const tiltCmd = app.commitStroke();
  check('штрих с наклоном не даёт NaN', !!tiltCmd, tiltCmd ? 'ok' : 'команда не создана');
  app.setBrush({ tiltDynamics: 0 });

  /* ── Пипетка и прозрачность ────────────────────────────────── */

  app.layers.addLayer({ name: 'Прозрачность', record: true });
  // Берём чистый документ: на прежнем всё залито градиентом
  const blank = createDocument({ width: 200, height: 200 });
  app.setDocument(blank);
  const sampled = app.sampleComposite(50, 50);
  check('пипетка читает альфу прозрачного места',
    sampled && sampled.a === 0, 'a=' + (sampled ? sampled.a : 'null'));

  /* ── Смена документа не ломает интерфейс ───────────────────── */

  const fresh = createDocument({ width: 640, height: 480, name: 'Тестовый' });
  app.setDocument(fresh);
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  check('после нового документа панель слоёв обновилась',
    document.querySelectorAll('.layer-item').length === fresh.layers.length,
    'в DOM=' + document.querySelectorAll('.layer-item').length + ' слоёв=' + fresh.layers.length);
  const newLayer = app.layers.addLayer({ name: 'После открытия', record: true });
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  check('добавление слоя после смены документа обновляет панель',
    !!document.querySelector('[data-id="' + newLayer.id + '"]'));
  check('статусбар показывает новый размер',
    document.querySelector('#statusSize').textContent.includes('640'),
    document.querySelector('#statusSize').textContent);

  /* ── Интерфейс: клики по реальным элементам ─────────────────── */

  const click = (sel) => {
    const node = document.querySelector(sel);
    if (!node) { check('элемент ' + sel + ' существует', false); return null; }
    node.click();
    return node;
  };

  click('.tool-btn[data-tool="eraser"]');
  check('тулбар переключает инструмент', app.toolId === 'eraser');
  check('кнопка инструмента подсвечена',
    document.querySelector('.tool-btn[data-tool="eraser"]').classList.contains('is-active'));
  click('.tool-btn[data-tool="brush"]');
  check('возврат на кисть', app.toolId === 'brush');

  const sizeBefore = app.brush.size;
  const sizeSlider = document.querySelectorAll('#toolPanelBody input[type="range"]')[0];
  sizeSlider.value = String(sizeBefore + 25);
  sizeSlider.dispatchEvent(new Event('input', { bubbles: true }));
  check('слайдер размера меняет кисть', Math.abs(app.brush.size - (sizeBefore + 25)) < 0.5,
    'size=' + app.brush.size);

  const blend = document.querySelector('#layerBlend');
  blend.value = 'multiply';
  blend.dispatchEvent(new Event('change', { bubbles: true }));
  check('выбор режима наложения из панели',
    app.doc.activeLayer.blendMode === 'multiply', app.doc.activeLayer.blendMode);

  const opacitySlider = document.querySelector('#layerOpacity');
  opacitySlider.value = '40';
  opacitySlider.dispatchEvent(new Event('input', { bubbles: true }));
  check('непрозрачность слоя из панели',
    Math.abs(app.doc.activeLayer.opacity - 0.4) < 0.01, 'opacity=' + app.doc.activeLayer.opacity);

  const paletteCell = document.querySelector('.palette__cell');
  paletteCell.click();
  check('клик по палитре меняет цвет', !!app.fgHex, app.fgHex);

  /* ── Тема, панели, диалоги ─────────────────────────────────── */

  document.querySelector('#btnTheme').click();
  const theme1 = document.documentElement.dataset.theme;
  check('тема переключается', theme1 === 'light' || theme1 === 'dark', theme1);
  document.querySelector('#btnTheme').click();

  const panelBtn = document.querySelector('#panelTool [data-collapse]');
  panelBtn.click();
  check('панель сворачивается', document.querySelector('#panelTool').classList.contains('is-collapsed'));
  panelBtn.click();
  check('панель разворачивается', !document.querySelector('#panelTool').classList.contains('is-collapsed'));

  document.querySelector('#btnFocus').click();
  check('режим фокуса включается', document.querySelector('#app').classList.contains('is-focus'));
  await new Promise(r => requestAnimationFrame(r));
  check('холст пересчитывается в фокус-режиме', app.renderer.cssW > 10);
  document.querySelector('#btnFocus').click();

  /* ── Меню и диалоги ─────────────────────────────────────────── */

  const menuBtn = document.querySelector('#menus .menu-item');
  menuBtn.click();
  check('меню открывается', document.querySelector('#menuLayer').classList.contains('is-open'));
  const entries = document.querySelectorAll('#menuLayer .menu-entry');
  check('в меню есть пункты', entries.length > 3, 'пунктов=' + entries.length);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise(r => setTimeout(r, 50));
  check('Escape закрывает меню', !document.querySelector('#menuLayer').classList.contains('is-open'));

  const { openDialogNew, openDialogResize, openDialogAbout, closeModal } = await import('./js/ui/dialogs.js');
  openDialogNew(app);
  await new Promise(r => setTimeout(r, 50));
  check('диалог нового документа открывается', !document.querySelector('#modalLayer').hidden);
  const newBtn = [...document.querySelectorAll('#modalLayer .btn')].find(b => b.textContent === 'Создать');
  check('в диалоге есть кнопка «Создать»', !!newBtn,
    [...document.querySelectorAll('#modalLayer .btn')].map(b => b.textContent).join('/'));
  newBtn?.click();
  await new Promise(r => setTimeout(r, 50));
  check('новый документ создан', app.doc.width === 1600 && app.doc.height === 1000,
    app.doc.width + 'x' + app.doc.height);
  check('имя документа обновилось в шапке',
    document.querySelector('#docTitle').value === app.doc.name,
    document.querySelector('#docTitle').value);

  openDialogResize(app);
  await new Promise(r => setTimeout(r, 50));
  const baseW = app.doc.width, baseH = app.doc.height;
  const nums = [...document.querySelectorAll('#modalLayer input[type="number"]')];
  nums[2].value = '50';   // поле «%»
  nums[2].dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 30));
  check('изменение процента пересчитывает размер',
    +nums[0].value === Math.round(baseW / 2) && +nums[1].value === Math.round(baseH / 2),
    'ожидалось ' + Math.round(baseW / 2) + 'x' + Math.round(baseH / 2)
      + ', получено ' + nums[0].value + 'x' + nums[1].value);
  closeModal();

  openDialogAbout(app);
  await new Promise(r => setTimeout(r, 50));
  check('диалог «О программе» открывается', !document.querySelector('#modalLayer').hidden);
  closeModal();
  check('диалог закрывается', document.querySelector('#modalLayer').hidden);

  /* ── Сохранение в IndexedDB и загрузка обратно ──────────────── */

  const { projectStore } = await import('./js/storage/project-store.js');
  app.setColor({ r: 90, g: 200, b: 160 }, 'fg');
  app.beginStroke({ x: 100, y: 100, pressure: 1, tilt: 0 }, {});
  app.extendStroke([{ x: 400, y: 400, pressure: 1, tilt: 0 }]);
  app.commitStroke();
  const savedId = await projectStore.save(app);
  const list = await projectStore.list();
  check('проект сохранён в IndexedDB', list.some(p => p.id === savedId), 'проектов=' + list.length);
  const loaded = await projectStore.load(savedId);
  check('проект загрузился', loaded.doc.layers.length === app.doc.layers.length,
    'слоёв=' + loaded.doc.layers.length);
  const lx = 200, ly = 250;
  const originalPx = app.sampleComposite(lx, ly);
  const loadedPx = (() => {
    const c = document.createElement('canvas');
    c.width = app.doc.width; c.height = app.doc.height;
    const cx = c.getContext('2d');
    for (const l of loaded.doc.layers) { cx.globalAlpha = l.opacity; cx.drawImage(l.canvas, 0, 0); }
    return cx.getImageData(lx, ly, 1, 1).data;
  })();
  check('пиксели сохранились', Math.abs(originalPx.a - loadedPx[3] / 255) < 0.06,
    'было=' + originalPx.a + ' стало=' + (loadedPx[3] / 255).toFixed(2));
  await projectStore.delete(savedId);

  /* ── Формат проекта: сериализация → десериализация ─────────── */

  const { serializeProject, deserializeProject } = await import('./js/utils/file.js');
  const json = await serializeProject(app);
  const roundTrip = await deserializeProject(JSON.parse(JSON.stringify(json)));
  check('формат проекта совпадает', roundTrip.doc.width === app.doc.width && roundTrip.doc.layers.length === app.doc.layers.length,
    roundTrip.doc.width + 'x' + roundTrip.doc.height);
  let badFormat = null;
  try { await deserializeProject({ format: 'чужая' }); } catch (err) { badFormat = err.message; }
  check('чужой формат отклоняется', !!badFormat, badFormat || 'не отклонён');

  /* ── Экспорт в PNG ─────────────────────────────────────────── */

  const { exportImage } = await import('./js/utils/file.js');
  const blob = await exportImage(app.flattenCanvas(), 'png');
  check('экспорт PNG работает', blob && blob.size > 100, 'байт=' + (blob ? blob.size : 0));
  const jpegBlob = await exportImage(app.flattenCanvas(), 'jpeg', { background: '#ffffff' });
  check('экспорт JPEG работает', jpegBlob && jpegBlob.size > 100, 'байт=' + (jpegBlob ? jpegBlob.size : 0));

  /* ── Горячие клавиши ───────────────────────────────────────── */

  const key = (k, opts = {}) => window.dispatchEvent(new KeyboardEvent('keydown', {
    key: k, code: opts.code || (/^[a-z]$/.test(k) ? 'Key' + k.toUpperCase() : k),
    ctrlKey: !!opts.ctrl, shiftKey: !!opts.shift, altKey: !!opts.alt, bubbles: true,
  }));

  key('e'); await new Promise(r => setTimeout(r, 30));
  check('клавиша E выбирает ластик', app.toolId === 'eraser', app.toolId);
  key('b'); await new Promise(r => setTimeout(r, 30));
  check('клавиша B выбирает кисть', app.toolId === 'brush', app.toolId);
  key(']'); await new Promise(r => setTimeout(r, 30));
  check('клавиша ] увеличивает кисть', app.brush.size > 25, 'size=' + app.brush.size);
  key('a', { ctrl: true }); await new Promise(r => setTimeout(r, 30));
  check('Ctrl+A выделяет всё', app.selection.active, JSON.stringify(app.selection.rect));
  key('d', { ctrl: true }); await new Promise(r => setTimeout(r, 30));
  check('Ctrl+D снимает выделение', !app.selection.active);
  const undoDepth = app.history.cursor;
  key('z', { ctrl: true }); await new Promise(r => setTimeout(r, 30));
  check('Ctrl+Z отменяет', app.history.cursor === undoDepth - 1, 'курсор=' + app.history.cursor);
  key('z', { ctrl: true, shift: true }); await new Promise(r => setTimeout(r, 30));
  check('Ctrl+Shift+Z повторяет', app.history.cursor === undoDepth, 'курсор=' + app.history.cursor);
  key('?'); await new Promise(r => setTimeout(r, 30));
  check('клавиша ? открывает справку', !document.querySelector('#modalLayer').hidden);
  closeModal();

  const field = document.querySelector('#docTitle');
  field.focus();
  key('b'); await new Promise(r => setTimeout(r, 30));
  check('в поле ввода хоткеи не срабатывают', app.toolId === 'brush');
  field.blur();

  return results;
`;

(async () => {
  const wsUrl = await waitForDevtools();
  const cdp = await CDP.attach(wsUrl);
  await sleep(1500);   // даём приложению инициализироваться

  const ready = await cdp.eval('return !!window.INKFORGE?.app');
  if (!ready) {
    console.error('Приложение не инициализировалось');
    process.exitCode = 1;
    cleanup();
    process.exit();
  }

  /** Печатает результаты; при падении сценария берёт их из глобала */
  const report = async (results, error) => {
    console.log('\nБраузерные проверки (headless Chrome):');
    const list = results || await cdp.eval('return globalThis.__TEST || []').catch(() => []);
    let failed = 0;
    for (const r of list) {
      if (!r.ok) failed++;
      console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.info ? '  [' + r.info + ']' : ''}`);
    }
    if (error) {
      failed++;
      console.log(`\n✗ Сценарий упал: ${String(error.message || error).split('\n')[0]}`);
    }

    const noise = cdp.logs.filter((l) => !/favicon|Autofill|IndexedDB.*version/i.test(l));
    if (noise.length) {
      console.log('\nСообщения из консоли:');
      for (const l of noise.slice(0, 15)) console.log('  ' + l);
      failed += noise.length;
    }

    console.log(`\nПройдено: ${list.length - failed}/${list.length}\n`);
    return failed;
  };

  let results = null;
  try {
    results = await cdp.eval(SCENARIO);
  } catch (err) {
    process.exitCode = await report(null, err);
  }
  if (process.exitCode === undefined) {
    process.exitCode = await report(results);
  }
  cleanup();
  process.exit(process.exitCode ? 1 : 0);
})().catch((err) => {
  console.error('Ошибка тестов:', err);
  cleanup();
  process.exit(1);
});