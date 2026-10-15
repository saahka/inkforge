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
  const check = (name, condition, info = '') =>
    results.push({ name, ok: !!condition, info: String(info) });

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

  const results = await cdp.eval(SCENARIO);

  console.log('\nБраузерные проверки (headless Chrome):');
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.info ? '  [' + r.info + ']' : ''}`);
  }

  const noise = cdp.logs.filter((l) => !/favicon|Autofill|IndexedDB.*version/i.test(l));
  if (noise.length) {
    console.log('\nСообщения из консоли:');
    for (const l of noise.slice(0, 15)) console.log('  ' + l);
    failed += noise.length;
  }

  console.log(`\nПройдено: ${results.length - failed}/${results.length}\n`);
  if (failed) process.exitCode = 1;
  cleanup();
  process.exit(process.exitCode || 0);
})().catch((err) => {
  console.error('Ошибка тестов:', err);
  cleanup();
  process.exit(1);
});