// Быстрые проверки чистой логики (без DOM): node tools/smoke-test.mjs
import assert from 'node:assert/strict';

const { clamp, unionRect, intersectRect, catmullRom, smoothPolyline, resample, extrapolate, extrapolateDegenerate } =
  await import('../js/utils/math.js').then((m) => ({ ...m, extrapolateDegenerate: m.extrapolate }));
const color = await import('../js/utils/color.js');
const { floodFillMask, maskToImageData, maskCount } = await import('../js/core/flood-fill.js');
const { blendPixels } = await import('../js/core/blend.js');
const { History, PixelCommand } = await import('../js/core/history.js');

// Минимальный полифилл ImageData для Node
if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class {
    constructor(...args) {
      if (args[0] instanceof Uint8ClampedArray) {
        this.data = args[0]; this.width = args[1]; this.height = args[2];
      } else {
        this.width = args[0]; this.height = args[1];
        this.data = new Uint8ClampedArray(this.width * this.height * 4);
      }
    }
  };
}

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    console.error('  ✗ ' + name + '\n    ' + err.message);
    process.exitCode = 1;
  }
};

console.log('\nmath.js');
test('clamp', () => assert.equal(clamp(5, 0, 3), 3));
test('unionRect объединяет два прямоугольника', () => {
  assert.deepEqual(unionRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 5, w: 5, h: 5 }),
    { x: 0, y: 0, w: 25, h: 10 });
});
test('intersectRect возвращает null при непересечении', () => {
  assert.equal(intersectRect({ x: 0, y: 0, w: 5, h: 5 }, { x: 10, y: 0, w: 5, h: 5 }), null);
});
test('Catmull-Rom проходит через опорные точки', () => {
  const p0 = { x: 0, y: 0 }, p1 = { x: 10, y: 10 }, p2 = { x: 20, y: 0 }, p3 = { x: 30, y: 10 };
  const mid = catmullRom(p0, p1, p2, p3, 0.5);
  assert.ok(Math.abs(mid.x - 15) < 1e-9, 'x в середине сегмента');
  assert.ok(Number.isFinite(mid.y));
});
test('smoothPolyline не теряет концы', () => {
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }];
  const out = smoothPolyline(pts, 4);
  assert.equal(out.length, 9);
  assert.equal(out[0].x, 0);
  assert.ok(Math.abs(out.at(-1).x - 20) < 1e-9);
});
test('resample соблюдает шаг', () => {
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const out = resample(pts, 10);
  assert.ok(out.length >= 10, 'точек не меньше длины/шага');
});
test('extrapolate продолжает траекторию', () => {
  const p = extrapolate({ x: 10, y: 0 }, { x: 0, y: 0 }, 0.05, 3);
  assert.ok(p.x > 10, 'предсказание впереди');
});

console.log('\ncolor.js');
test('rgb → hex → rgb', () => {
  const hex = color.rgbToHex({ r: 18, g: 52, b: 86 });
  assert.deepEqual(color.parseColor(hex), { r: 18, g: 52, b: 86 });
});
test('hsv → rgb → hsv (круг)', () => {
  const rgb = color.hsvToRgb(210, 0.8, 0.9);
  const hsv = color.rgbToHsv(rgb.r, rgb.g, rgb.b);
  assert.ok(Math.abs(hsv.h - 210) < 1.5, 'оттенок сохраняется');
  assert.ok(Math.abs(hsv.s - 0.8) < 0.02);
});
test('hsl ↔ rgb', () => {
  const rgb = color.hslToRgb(120, 1, 0.5);
  const hsl = color.rgbToHsl(rgb.r, rgb.g, rgb.b);
  assert.ok(Math.abs(hsl.h - 120) < 1.5);
  assert.ok(Math.abs(hsl.l - 0.5) < 0.02);
});
test('cmyk ↔ rgb', () => {
  const rgb = color.cmykToRgb(0, 100, 100, 0);
  assert.deepEqual(rgb, { r: 255, g: 0, b: 0 });
});
test('гармонии дают комплементарный оттенок', () => {
  const rows = color.harmonies({ r: 255, g: 0, b: 0 });
  const comp = rows.find((r) => r.name === 'Комплементарная');
  const h = color.rgbToHsv(comp.colors[1].r, comp.colors[1].g, comp.colors[1].b).h;
  assert.ok(Math.abs(h - 180) < 6, 'оттенок ≈180°, получено ' + h);
});

console.log('\nflood-fill.js');
test('заливка находит замкнутую область', () => {
  const w = 10, h = 10;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = 255; data[i * 4 + 3] = 255; }
  // Прямоугольник 2..6 закрашен чёрным — это «стена»
  for (let y = 2; y < 6; y++) {
    for (let x = 2; x < 6; x++) { data[(y * w + x) * 4] = 0; }
  }
  const img = { data, width: w, height: h };
  const mask = floodFillMask(img, w, h, 0, 0, 10, { contiguous: true });
  assert.equal(maskCount(mask), 100 - 16, 'всё, кроме внутреннего чёрного квадрата');
  const all = floodFillMask(img, w, h, 0, 0, 10, { contiguous: false });
  assert.equal(maskCount(all), 84, 'палочка без непрерывности находит все белые');
});
test('maskToImageData ставит цвет только в маске', () => {
  const mask = new Uint8Array([1, 0, 1, 1]);
  const out = maskToImageData(mask, 2, 2, { r: 10, g: 20, b: 30 });
  assert.equal(out.data[3], 255);
  assert.equal(out.data[7], 0);
  assert.equal(out.data[0], 10);
});

console.log('\nblend.js');
test('обычный режим совпадает с source-over', () => {
  const backdrop = { data: new Uint8ClampedArray([0, 0, 0, 255]), width: 1, height: 1 };
  const source = { data: new Uint8ClampedArray([255, 0, 0, 128]), width: 1, height: 1 };
  const out = { data: new Uint8ClampedArray(4), width: 1, height: 1 };
  blendPixels(backdrop, source, out, 'normal');
  // 50% красного поверх непрозрачного чёрного = тёмно-красный при полной альфе
  assert.ok(Math.abs(out.data[0] - 128) < 2, 'красный ≈128, получено ' + out.data[0]);
  assert.equal(out.data[1], 0);
  assert.ok(Math.abs(out.data[3] - 255) < 1, 'альфа объединяется с фоном');
});
test('полупрозрачный красный поверх белого даёт розовый', () => {
  const backdrop = { data: new Uint8ClampedArray([255, 255, 255, 255]), width: 1, height: 1 };
  const source = { data: new Uint8ClampedArray([255, 0, 0, 128]), width: 1, height: 1 };
  const out = { data: new Uint8ClampedArray(4), width: 1, height: 1 };
  blendPixels(backdrop, source, out, 'normal');
  assert.ok(Math.abs(out.data[0] - 255) < 1);
  assert.ok(Math.abs(out.data[1] - 127) < 2, 'зелёный ≈ 50% белого, получено ' + out.data[1]);
});
test('режим «Цвет» берёт цвет источника и светлоту фона', () => {
  const backdrop = { data: new Uint8ClampedArray([128, 128, 128, 255]), width: 1, height: 1 };
  const source = { data: new Uint8ClampedArray([255, 0, 0, 255]), width: 1, height: 1 };
  const out = { data: new Uint8ClampedArray(4), width: 1, height: 1 };
  blendPixels(backdrop, source, out, 'color');
  assert.equal(out.data[0], 255, 'красный канал максимальный');
  assert.ok(out.data[1] < 40 && out.data[2] < 40, 'остальные каналы близки к нулю');
});
test('прозрачный источник не меняет фон', () => {
  const backdrop = { data: new Uint8ClampedArray([10, 20, 30, 255]), width: 1, height: 1 };
  const source = { data: new Uint8ClampedArray([0, 0, 0, 0]), width: 1, height: 1 };
  const out = { data: new Uint8ClampedArray(4), width: 1, height: 1 };
  blendPixels(backdrop, source, out, 'hue');
  assert.deepEqual([...out.data], [10, 20, 30, 255]);
});

console.log('\nhistory.js');
test('отмена и повтор шага CallbackCommand', () => {
  const h = new History(10);
  let value = 0;
  const cmd = { label: 'Тест', bytes: 0, do: () => { value = 1; }, undo: () => { value = 0; } };
  h.execute(cmd);
  assert.equal(value, 1);
  assert.equal(h.canUndo(), true);
  h.undo();
  assert.equal(value, 0);
  h.redo();
  assert.equal(value, 1);
});
test('новая команда обрезает «отменённый хвост»', () => {
  const h = new History(10);
  h.execute({ label: 'a', bytes: 0, do() {}, undo() {} });
  h.undo();
  assert.equal(h.canRedo(), true);
  h.execute({ label: 'b', bytes: 0, do() {}, undo() {} });
  assert.equal(h.canRedo(), false);
  assert.equal(h.entries.length, 1);
});
test('лимит шагов соблюдается', () => {
  const h = new History(3);
  for (let i = 0; i < 10; i++) h.execute({ label: 's' + i, bytes: 0, do() {}, undo() {} });
  assert.equal(h.entries.length, 3);
  assert.equal(h.cursor, 3);
});
test('goto перематывает историю', () => {
  const h = new History(10);
  const log = [];
  h.execute({ label: 'a', bytes: 0, do: () => log.push('a'), undo: () => log.pop() });
  h.execute({ label: 'b', bytes: 0, do: () => log.push('b'), undo: () => log.pop() });
  h.goto(1);
  assert.deepEqual(log, ['a']);
  h.goto(2);
  assert.deepEqual(log, ['a', 'b']);
});
test('PixelCommand хранит снимок области', () => {
  // Минимальная имитация слоя
  const data = new Uint8ClampedArray(4 * 4 * 4).fill(255);
  const layer = {
    id: 'L1',
    _data: data,
    getImageData: () => ({ data, width: 4, height: 4 }),
    putImageData(img) { this._data = img.data; },
    markDirty() {},
  };
  const cmd = new PixelCommand(layer, { x: 0, y: 0, w: 4, h: 4 }, 'Кисть');
  layer._data = new Uint8ClampedArray(4 * 4 * 4).fill(0);
  cmd.capture();
  cmd.undo();
  assert.equal(layer._data[0], 255, 'отмена возвращает исходные пиксели');
});

console.log(`\nПройдено проверок: ${passed}\n`);