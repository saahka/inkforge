/**
 * Правая панель: свойства активного инструмента, цвет, слои, история.
 * Всё строится на обычном DOM — без виртуальных деревьев и перерисовки целиком:
 * списки обновляются точечно (по diff по id), поэтому 200 слоёв не тормозят.
 */

import { el, qs, qsa, on, debounce } from '../utils/dom.js';
import { clamp } from '../utils/math.js';
import {
  rgbToHex, parseColor, rgbToHsv, hsvToRgb, rgbToHsl, hslToRgb,
  rgbToCmyk, cmykToRgb, loadPalette, savePalette, loadRecent, harmonies,
} from '../utils/color.js';
import { PRESETS, makeBrush } from '../core/brush.js';
import { BLEND_MODES } from '../core/layer.js';

/* ══════════════════════════════════════════════════════════════════
   Панель инструмента
   ══════════════════════════════════════════════════════════════════ */

export function initToolPanel(app) {
  const body = qs('#toolPanelBody');
  const title = qs('#toolPanelTitle');

  /** Превью мазка текущей кисти */
  const drawPreview = debounce(() => {
    const canvas = body.querySelector('.tool-preview canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = clamp(globalThis.devicePixelRatio || 1, 1, 3);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const brush = app.toolId === 'eraser' ? app.eraserBrush : app.brush;
    const preview = app.previewStroke || makeStrokePreview(brush);
    // Масштабируем эталонную линию (±50 × ~20) под размер превью
    const scale = Math.min((w - 40) / 110, (h - 30) / 30);
    const cx = w / 2, cy = h / 2 - 4;

    ctx.save();
    for (let i = 1; i < preview.length; i++) {
      const a = preview[i - 1];
      const b = preview[i];
      const da = Math.hypot(a.x - b.x, a.y - b.y);
      const steps = Math.max(1, Math.ceil(da / Math.max(0.8, brush.size * brush.spacing * 0.5)));
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const x = cx + (a.x + (b.x - a.x) * t) * scale;
        const y = cy + (a.y + (b.y - a.y) * t) * scale;
        const pressure = a.pressure + ((b.pressure ?? 1) - a.pressure) * t;
        const size = brush.size * (1 - brush.sizeDynamics * (1 - pressure ** 0.7));
        const alpha = brush.flow * brush.opacity * (1 - brush.opacityDynamics * (1 - pressure));
        paintDabPreview(ctx, brush, x, y, size, alpha);
      }
    }
    ctx.restore();
  }, 60);

  function rebuild() {
    const tool = app.tool;
    body.replaceChildren();
    title.textContent = tool?.label || 'Инструмент';
    if (!tool) return;

    if (['brush', 'eraser'].includes(app.toolId)) buildBrushControls();
    else buildToolSpecific(tool);
  }

  /* ─── Кисть / ластик ─────────────────────────────────────────── */

  function buildBrushControls() {
    const isEraser = app.toolId === 'eraser';

    // Превью
    const previewBox = el('div.tool-preview', { title: 'Потри здесь, чтобы проверить кисть' });
    const cv = el('canvas', { style: { width: '100%', height: '100%', display: 'block' } });
    previewBox.append(cv, el('span.tool-preview__hint', { text: 'предпросмотр кисти' }));

    // Тестовая линия мышью
    on(previewBox, 'pointerdown', (e) => {
      previewBox.setPointerCapture(e.pointerId);
      const brush = isEraser ? app.eraserBrush : app.brush;
      const rect = previewBox.getBoundingClientRect();
      const pts = [];
      const move = (ev) => pts.push({
        x: ev.clientX - rect.left - rect.width / 2,
        y: ev.clientY - rect.top - rect.height / 2 + 4,
        pressure: ev.pressure || 1,
      });
      move(e);
      const up = () => {
        previewBox.removeEventListener('pointermove', move);
        previewBox.removeEventListener('pointerup', up);
        app.previewStroke = smoothForPreview(pts);
        drawPreview.flush();
        drawPreview();
      };
      previewBox.addEventListener('pointermove', move);
      previewBox.addEventListener('pointerup', up);
    });

    const bind = isEraser ? 'setEraserBrush' : 'setBrush';

    body.append(
      previewBox,
      slider('Размер', app.activeBrush.size, 1, 2000, 1, (v) => app[bind]({ size: v })),
      slider('Непрозрачность', Math.round(app.activeBrush.opacity * 100), 1, 100, 1,
        (v) => app[bind]({ opacity: v / 100 })),
      slider('Поток', Math.round(app.activeBrush.flow * 100), 1, 100, 1,
        (v) => app[bind]({ flow: v / 100 })),
      slider('Жёсткость', Math.round(app.activeBrush.hardness * 100), 0, 100, 1,
        (v) => app[bind]({ hardness: v / 100 })),
      slider('Шаг', Math.round(app.activeBrush.spacing * 100), 1, 60, 1,
        (v) => app[bind]({ spacing: v / 100 })),
      slider('Сглаживание', Math.round(app.activeBrush.smoothing * 100), 0, 95, 1,
        (v) => app[bind]({ smoothing: v / 100 })),
    );

    if (!isEraser) {
      body.append(el('div.field.field--row', null, [
        el('span.field__label.field__label--w', { text: 'Тип' }),
        select(BRUSH_TYPES_LIST, app.brush.type, (v) => {
          const base = makeBrush({ type: v });
          app.setBrush({ ...base, color: { ...app.brush.color } });
          rebuild();
        }),
      ]));
    }

    // Динамика и пресеты — в сворачиваемый блок, чтобы панель не была вечной
    const extras = el('details', null, [
      el('summary.field__label', { text: 'Динамика пера и пресеты' }),
      el('div.field-list', null, [
        check('Размер от давления', app.activeBrush.sizeDynamics > 0, (on_) =>
          app[bind]({ sizeDynamics: on_ ? 0.6 : 0 })),
        check('Непрозрачность от давления', app.activeBrush.opacityDynamics > 0, (on_) =>
          app[bind]({ opacityDynamics: on_ ? 0.6 : 0 })),
        check('Толщина от наклона', app.activeBrush.tiltDynamics > 0, (on_) =>
          app[bind]({ tiltDynamics: on_ ? 0.6 : 0 })),
      ]),
    ]);

    if (!isEraser) {
      extras.append(el('div.field-list', null, [
        el('span.field__label', { text: 'Пресеты' }),
        ...PRESETS.map((p) => el('button.preset-chip', {
          text: p.name,
          type: 'button',
          title: `${p.type} · ${p.size}px`,
          onclick: () => { app.resetBrushToPreset(p); rebuild(); },
        })),
      ]));
    }
    body.append(extras);

    drawPreview.flush();
    drawPreview();
  }

  /* ─── Параметры конкретных инструментов ───────────────────────── */

  function buildToolSpecific(tool) {
    const s = tool.settings || {};

    if (tool.id === 'fill') {
      body.append(
        slider('Допуск', s.tolerance, 0, 128, 1, (v) => { s.tolerance = v; }),
        check('Все слои', s.sampleAllLayers, (v) => { s.sampleAllLayers = v; }),
        check('Непрерывная область', s.contiguous, (v) => { s.contiguous = v; }),
        el('p.field__label', { text: 'Shift+клик — заливка фоновым цветом.' }),
      );
    }

    if (tool.id === 'gradient') {
      body.append(
        check('Радиальный', s.radial, (v) => { s.radial = v; }),
        check('Реверс (градиент от курсора)', s.reverse, (v) => { s.reverse = v; }),
        el('p.field__label', { text: 'Тяните мышью. Shift — угол 45°. Цвета берутся из палитры.' }),
      );
    }

    if (tool.id === 'marquee') {
      body.append(
        slider('Растушевка', s.feather || 0, 0, 64, 1, (v) => { s.feather = v; }),
        el('p.field__label', { text: 'Протяните прямоугольник. Ctrl+A — всё, Ctrl+D — снять.' }),
      );
    }

    if (tool.id === 'move') {
      body.append(
        check('Двигать выделение', s.moveSelection !== false, (v) => { s.moveSelection = v; }),
        el('p.field__label', { text: 'Ctrl+тяга — копировать содержимое.' }),
      );
    }

    if (tool.id === 'eyedropper') {
      body.append(
        select([{ v: 'fg', t: 'Основной цвет' }, { v: 'bg', t: 'Фоновый цвет' }],
          s.target || 'fg', (v) => { s.target = v; }),
        el('p.field__label', { text: 'Alt по кисти — разовая пипетка.' }),
      );
    }

    if (tool.id === 'pan') {
      body.append(el('p.field__label', { text: 'Пробел + тяга мышью работает в любом инструменте.' }));
    }
  }

  /* ─── Реакция на изменения ────────────────────────────────────── */

  app.on('tool', rebuild);
  app.on('brush', debounce(() => {
    if (['brush', 'eraser'].includes(app.toolId)) drawPreview();
  }, 40));

  rebuild();
  return { rebuild };
}

/* ─── Вспомогательные элементы формы ──────────────────────────────── */

function slider(label, value, min, max, step, onInput) {
  const num = el('input.field__num', {
    type: 'number', min, max, step, value,
    onchange: (e) => onInput(clamp(+e.target.value, min, max)),
  });
  const range = el('input', {
    type: 'range', min, max, step, value,
    oninput: (e) => {
      const v = +e.target.value;
      num.value = v;
      onInput(v);
    },
  });
  return el('div.field.field--row', null, [
    el('span.field__label.field__label--w', { text: label, title: label }),
    range,
    num,
  ]);
}

function check(label, value, onChange) {
  const input = el('input', { type: 'checkbox', checked: value });
  input.addEventListener('change', () => onChange(input.checked));
  return el('label.checkbox', null, [input, label]);
}

function select(options, value, onChange) {
  const node = el('select.field__select', {
    onchange: (e) => onChange(e.target.value),
  }, options.map((o) => {
    const value_ = o.v ?? o.id ?? o;
    const text = o.t ?? o.label ?? o;
    return el('option', { value: value_, selected: value_ === value, text });
  }));
  return node;
}

const BRUSH_TYPES_LIST = [
  { v: 'pen', t: 'Перо' },
  { v: 'ink', t: 'Тушь' },
  { v: 'pencil', t: 'Карандаш' },
  { v: 'marker', t: 'Маркер' },
  { v: 'soft', t: 'Мягкая' },
  { v: 'airbrush', t: 'Аэрограф' },
  { v: 'watercolor', t: 'Акварель' },
  { v: 'calligraphy', t: 'Каллиграфия' },
];

/** Готовая S-образная линия для превью кисти */
function makeStrokePreview(brush) {
  const len = 24;
  const pts = [];
  for (let i = 0; i <= len; i++) {
    const t = i / len;
    pts.push({
      x: (t - 0.5) * 100,
      y: Math.sin(t * Math.PI) * 10 - 4,
      pressure: brush.sizeDynamics > 0 ? 0.15 + Math.sin(t * Math.PI) * 0.85 : 1,
    });
  }
  return smoothForPreview(pts);
}

function smoothForPreview(pts) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    for (let s = 1; s <= 5; s++) {
      const t = s / 5;
      const t2 = t * t, t3 = t2 * t;
      out.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
        pressure: p1.pressure + ((p2.pressure ?? 1) - p1.pressure) * t,
      });
    }
  }
  return out;
}

/** Рисует dab в превью (упрощённая версия stampDab без кэша) */
function paintDabPreview(ctx, brush, x, y, size, alpha) {
  if (size <= 0) return;
  const r = size / 2;
  ctx.save();
  ctx.globalAlpha = clamp(alpha, 0, 1);
  if (brush.hardness >= 0.97 || brush.aspect < 1) {
    ctx.fillStyle = rgbToHex(brush.color);
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * brush.aspect, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgbToHex(brush.color));
    g.addColorStop(Math.max(0.01, brush.hardness), rgbToHex(brush.color));
    g.addColorStop(1, `${rgbToHex(brush.color)}00`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/* ══════════════════════════════════════════════════════════════════
   Панель цвета
   ══════════════════════════════════════════════════════════════════ */

export function initColorPanel(app) {
  const body = qs('#colorPanelBody');
  let hsv = rgbToHsv(app.color.fg.r, app.color.fg.g, app.color.fg.b);

  /* Текущий цвет */
  const fill = el('div.color-current__fill');
  const current = el('div.color-current', { title: 'Основной цвет (клик — выбор)' }, [fill]);
  const pickerInput = el('input', {
    type: 'color', value: rgbToHex(app.color.fg),
    style: { position: 'absolute', opacity: '0', width: '1px', height: '1px' },
    oninput: (e) => app.setFgHex(e.target.value),
  });
  on(current, 'click', () => pickerInput.click());
  const swapBtn = qs('#panelColor [data-swap-colors]');
  on(swapBtn, 'click', () => app.swapColors());

  /* Поле SV */
  const svCursor = el('div.color-picker__cursor');
  const sv = el('div.color-picker__sv', null, [svCursor]);
  const svBox = el('div.color-picker', null, [sv]);

  /* Полоса оттенка */
  const hueCursor = el('div.color-picker__hue-cursor');
  const hueBar = el('div.color-picker__hue', null, [hueCursor]);

  /* Числовые поля */
  const hex = el('input.field__text', {
    type: 'text', value: rgbToHex(app.color.fg), maxlength: 7, spellcheck: false,
    title: 'HEX',
    onchange: (e) => app.setFgHex(e.target.value),
  });
  const rgbInputs = {};
  const mkChannel = (ch) => {
    const range = el('input', { type: 'range', min: 0, max: 255, step: 1, value: app.color.fg[ch] });
    const track = el('div.color-slider__track', {
      style: { background: channelGradient(ch) },
    }, [range]);
    range.addEventListener('input', () => {
      app.setColor({ ...app.color.fg, [ch]: +range.value }, 'fg');
    });
    const num = el('input.field__num', {
      type: 'number', min: 0, max: 255, value: app.color.fg[ch],
      onchange: (e) => app.setColor({ ...app.color.fg, [ch]: clamp(+e.target.value | 0, 0, 255) }, 'fg'),
    });
    rgbInputs[ch] = { range, num, track };
    return el('div.color-slider', null, [
      el('span.field__label', { text: ch.toUpperCase() }), track, num,
    ]);
  };

  const hslRow = el('div.row-3', null, ['h', 's', 'l'].map((ch) => {
    const num = el('input.field__num', {
      type: 'number', min: ch === 'h' ? 0 : 0, max: ch === 'h' ? 360 : 100,
      onchange: () => syncHslInputs(),
    });
    num.dataset.ch = ch;
    return el('div.field', null, [el('span.field__label', { text: ch.toUpperCase() }), num]);
  }));

  const cmykRow = el('div.row-3', null, ['c', 'm', 'y', 'k'].map((ch) => {
    const num = el('input.field__num', {
      type: 'number', min: 0, max: 100,
      onchange: () => syncCmykInputs(),
    });
    num.dataset.ch = ch;
    return el('div.field', null, [el('span.field__label', { text: ch.toUpperCase() }), num]);
  }));

  const paletteBox = el('div.palette');
  const recentBox = el('div.palette');
  const harmonyBox = el('div.harmony-row');

  body.append(
    el('div.color-widget', null, [
      el('div.color-swatches-row', null, [current, pickerInput]),
      svBox,
      hueBar,
      el('div.color-sliders', null, [mkChannel('r'), mkChannel('g'), mkChannel('b')]),
      el('div.field', null, [el('span.field__label', { text: 'HEX / CMYK' }), hex]),
      el('details', null, [
        el('summary.field__label', { text: 'HSL / CMYK' }),
        el('div', { style: { display: 'grid', gap: '8px', marginTop: '8px' } }, [hslRow, cmykRow]),
      ]),
      el('details', null, [
        el('summary.field__label', { text: 'Гармонии, палитра, недавние' }),
        el('div.field-list', null, [
          el('div.field', null, [
            el('span.field__label', { text: 'Гармонии' }),
            harmonyBox,
          ]),
          el('div.field', null, [
            el('span.field__label', { text: 'Палитра' }),
            paletteBox,
          ]),
          el('div.field', null, [
            el('span.field__label', { text: 'Недавние' }),
            recentBox,
          ]),
        ]),
      ]),
    ]),
  );

  /* Взаимодействие с SV-плоскостью */
  const svPointer = (e) => {
    const r = svBox.getBoundingClientRect();
    hsv.s = clamp((e.clientX - r.left) / r.width, 0, 1);
    hsv.v = 1 - clamp((e.clientY - r.top) / r.height, 0, 1);
    applyHsv();
  };
  on(svBox, 'pointerdown', (e) => {
    svBox.setPointerCapture(e.pointerId);
    svPointer(e);
    const move = (ev) => svPointer(ev);
    const up = () => {
      svBox.removeEventListener('pointermove', move);
      svBox.removeEventListener('pointerup', up);
    };
    svBox.addEventListener('pointermove', move);
    svBox.addEventListener('pointerup', up);
  });

  const huePointer = (e) => {
    const r = hueBar.getBoundingClientRect();
    hsv.h = clamp((e.clientX - r.left) / r.width, 0, 1) * 360;
    applyHsv();
  };
  on(hueBar, 'pointerdown', (e) => {
    hueBar.setPointerCapture(e.pointerId);
    huePointer(e);
    const move = (ev) => huePointer(ev);
    const up = () => {
      hueBar.removeEventListener('pointermove', move);
      hueBar.removeEventListener('pointerup', up);
    };
    hueBar.addEventListener('pointermove', move);
    hueBar.addEventListener('pointerup', up);
  });

  function applyHsv() {
    app.setColor(hsvToRgb(hsv.h, hsv.s, hsv.v), 'fg');
    update();
  }

  function syncHslInputs() {
    const vals = {};
    hslRow.querySelectorAll('input').forEach((i) => { vals[i.dataset.ch] = +i.value; });
    const rgb = hslToRgb(vals.h, vals.s / 100, vals.l / 100);
    app.setColor(rgb, 'fg');
  }

  function syncCmykInputs() {
    const vals = {};
    cmykRow.querySelectorAll('input').forEach((i) => { vals[i.dataset.ch] = +i.value; });
    app.setColor(cmykToRgb(vals.c, vals.m, vals.y, vals.k), 'fg');
  }

  const renderPalette = () => {
    const colors = loadPalette();
    paletteBox.replaceChildren(...colors.map((hexColor) => el('button.palette__cell', {
      type: 'button',
      style: { background: hexColor },
      title: hexColor,
      onclick: () => app.setFgHex(hexColor),
    })));
    // добавить текущий цвет
    paletteBox.append(el('button.palette__cell', {
      type: 'button',
      style: { background: '#8883' },
      title: 'Добавить текущий цвет в палитру',
      text: '+',
      onclick: () => {
        const list = loadPalette();
        const hexColor = rgbToHex(app.color.fg);
        if (!list.includes(hexColor)) {
          list.push(hexColor);
          savePalette(list);
          renderPalette();
        }
      },
    }));
  };

  const renderRecent = () => {
    const list = app.recentColors || loadRecent();
    recentBox.replaceChildren(
      ...(list.length ? list : []).map((hexColor) => el('button.palette__cell', {
        type: 'button', style: { background: hexColor }, title: hexColor,
        onclick: () => app.setFgHex(hexColor),
      })),
      list.length ? null : el('span.palette--empty', { text: 'Цвета появятся после выбора' }),
    );
  };

  const renderHarmony = () => {
    const rows = harmonies(app.color.fg);
    harmonyBox.replaceChildren(...rows.map((row) => row.colors.map((c, i) => el('button.harmony-swatch', {
      type: 'button',
      style: { background: rgbToHex(c) },
      title: `${row.name}${i ? '' : ' (база)'}`,
      onclick: () => app.setColor(c, 'fg'),
    }))).flat());
  };

  function update() {
    const c = app.color.fg;
    const hexValue = rgbToHex(c);
    hsv = rgbToHsv(c.r, c.g, c.b);

    fill.style.background = hexValue;
    pickerInput.value = hexValue;
    hex.value = hexValue;
    for (const ch of ['r', 'g', 'b']) {
      const ui = rgbInputs[ch];
      ui.range.value = c[ch];
      ui.num.value = c[ch];
      ui.track.style.background = channelGradient(ch);
    }

    sv.style.background =
      `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), ${hexValue}`;
    svCursor.style.left = `${hsv.s * 100}%`;
    svCursor.style.top = `${(1 - hsv.v) * 100}%`;
    svCursor.style.background = hexValue;
    hueCursor.style.left = `${(hsv.h / 360) * 100}%`;

    const hsl = rgbToHsl(c.r, c.g, c.b);
    hslRow.querySelectorAll('input').forEach((i) => {
      const ch = i.dataset.ch;
      if (document.activeElement !== i) i.value = Math.round(ch === 'h' ? hsl.h : hsl[ch] * 100);
    });
    const cmyk = rgbToCmyk(c.r, c.g, c.b);
    cmykRow.querySelectorAll('input').forEach((i) => {
      if (document.activeElement !== i) i.value = cmyk[i.dataset.ch];
    });

    renderHarmony();
  }

  function channelGradient(ch) {
    const c = app.color.fg;
    const from = rgbToHex({ ...c, [ch]: 0 });
    const to = rgbToHex({ ...c, [ch]: 255 });
    return `linear-gradient(to right, ${from}, ${to})`;
  }

  app.on('color', update);
  app.on('recent', renderRecent);
  renderPalette();
  renderRecent();
  update();

  return { update, renderPalette, renderRecent };
}

/* ══════════════════════════════════════════════════════════════════
   Панель слоёв
   ══════════════════════════════════════════════════════════════════ */

export function initLayersPanel(app) {
  const list = qs('#layerList');
  const opacity = qs('#layerOpacity');
  const opacityNum = qs('#layerOpacityNum');
  const blend = qs('#layerBlend');
  const head = qs('#panelLayers .panel__head');

  blend.replaceChildren(...BLEND_MODES.map((m) =>
    el('option', { value: m.id, text: m.label })));

  on(opacity, 'input', () => {
    const v = +opacity.value;
    opacityNum.value = v;
    const layer = app.doc.activeLayer;
    if (layer) app.layers.setOpacity(layer.id, v / 100);
  });
  on(opacityNum, 'change', () => {
    opacity.value = clamp(+opacityNum.value, 0, 100);
    opacity.dispatchEvent(new Event('input'));
  });
  on(blend, 'change', () => {
    const layer = app.doc.activeLayer;
    if (layer) app.layers.setBlendMode(layer.id, blend.value, { record: true });
  });

  /* Кнопки заголовка */
  on(head.querySelector('[data-layer="add"]'), 'click', () => app.layers.addLayer({ record: true }));
  on(head.querySelector('[data-layer="duplicate"]'), 'click', () => {
    const l = app.doc.activeLayer;
    if (l) app.layers.duplicateLayer(l.id);
  });
  on(head.querySelector('[data-layer="merge"]'), 'click', () => {
    const l = app.doc.activeLayer;
    if (l) app.layers.mergeDown(l.id);
  });
  on(head.querySelector('[data-layer="delete"]'), 'click', () => {
    const l = app.doc.activeLayer;
    if (l) app.layers.deleteLayer(l.id);
  });

  /* Точечное обновление списка */
  function render() {
    const layers = app.doc.layers;
    const activeId = app.doc.activeLayerId;

    // Убираем пропавшие
    for (const node of [...list.children]) {
      if (!layers.some((l) => l.id === node.dataset.id)) node.remove();
    }

    // Список снизу вверх: верхний слой — первым в DOM
    layers.slice().reverse().forEach((layer) => {
      let node = list.querySelector(`[data-id="${layer.id}"]`);
      if (!node) {
        node = buildRow(layer);
        list.append(node);
        refreshThumb(layer, node);
      }
      updateRow(layer, node);
    });

    // Порядок в DOM = снизу вверх
    layers.slice().reverse().forEach((layer) => {
      const node = list.querySelector(`[data-id="${layer.id}"]`);
      if (node) list.append(node);
    });

    updateProps();
  }

  function updateProps() {
    const layer = app.doc.activeLayer;
    const disabled = !layer;
    opacity.disabled = disabled;
    opacityNum.disabled = disabled;
    blend.disabled = disabled;
    if (!layer) return;
    if (document.activeElement !== opacity) {
      opacity.value = Math.round(layer.opacity * 100);
      opacityNum.value = Math.round(layer.opacity * 100);
    }
    if (document.activeElement !== blend) blend.value = layer.blendMode;
  }

  async function refreshThumb(layer, node) {
    const img = node.querySelector('img');
    try {
      const url = await app.layers.getThumb(layer, 64);
      if (img.isConnected) img.src = url;
    } catch { /* пусто */ }
  }

  function buildRow(layer) {
    const vis = el('button.layer-item__vis', {
      type: 'button',
      title: 'Видимость',
      onclick: (e) => { e.stopPropagation(); app.layers.setVisible(layer.id, !layer.visible, { record: true }); },
    }, layer.visible ? [icon('M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z')] : [icon('M3 3l18 18M10.6 5.1A9.8 9.8 0 0 1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-3.2 3.9M6.2 6.2A18 18 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 4-.85')]);

    const thumb = el('img.layer-item__thumb', { alt: '', draggable: false });
    const name = el('span.layer-item__name', {
      text: layer.name,
      ondblclick: (e) => startRename(e.currentTarget, layer),
    });
    const meta = el('span.layer-item__meta');
    const lock = el('button.layer-flag', {
      type: 'button',
      title: 'Блокировка',
      text: '🔒',
      onclick: (e) => { e.stopPropagation(); app.layers.setLocked(layer.id, !layer.locked, { record: true }); },
    });
    const clip = el('button.layer-flag', {
      type: 'button',
      title: 'Маска слоя (clipping)',
      text: '⤵',
      onclick: (e) => { e.stopPropagation(); toggleClip(layer); },
    });
    const alpha = el('button.layer-flag', {
      type: 'button',
      title: 'Блокировка прозрачности',
      text: '◧',
      onclick: (e) => { e.stopPropagation(); app.layers.setAlphaLocked(layer.id, !layer.alphaLocked); },
    });
    const menu = el('button.layer-flag', {
      type: 'button',
      title: 'Меню',
      text: '⋯',
      onclick: (e) => { e.stopPropagation(); showLayerMenu(e, layer); },
    });

    const row = el('li.layer-item', {
      draggable: 'true',
      dataset: { id: layer.id },
      onclick: () => app.layers.select(layer.id),
      oncontextmenu: (e) => { e.preventDefault(); app.layers.select(layer.id); showLayerMenu(e, layer); },
      onpointerdown: (e) => { if (e.button === 1) e.preventDefault(); },
    }, [vis, thumb, el('div.layer-item__main', null, [name, meta]), el('div.layer-item__flags', null, [lock, alpha, clip, menu])]);

    // Перетаскивание для сортировки
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', layer.id);
      e.dataTransfer.effectAllowed = 'move';
      row.style.opacity = '.5';
    });
    row.addEventListener('dragend', () => {
      row.style.opacity = '';
      qsa('.layer-drop-before,.layer-drop-after', list).forEach((n) =>
        n.classList.remove('layer-drop-before', 'layer-drop-after'));
    });
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      const r = row.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      row.classList.toggle('layer-drop-before', !after);
      row.classList.toggle('layer-drop-after', after);
    });
    row.addEventListener('dragleave', () => row.classList.remove('layer-drop-before', 'layer-drop-after'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const id = e.dataTransfer.getData('text/plain');
      if (!id || id === layer.id) return;
      const afterDrop = row.classList.contains('layer-drop-after');
      const targetIndex = app.doc.indexOf(layer.id);
      const after = targetIndex + (afterDrop ? 0 : 1);
      // Индекс считается в массиве до удаления перетаскиваемого слоя,
      // поэтому при движении вниз его нужно скорректировать на 1
      const from = app.doc.indexOf(id);
      const finalIndex = from < targetIndex ? after - 1 : after;
      app.layers.reorderLayer(id, finalIndex);
    });

    return row;
  }

  function updateRow(layer, node) {
    node.classList.toggle('is-active', layer.id === app.doc.activeLayerId);
    node.classList.toggle('is-hidden', !layer.visible);
    const name = node.querySelector('.layer-item__name');
    if (document.activeElement !== name && !name.isContentEditable) name.textContent = layer.name;
    const meta = node.querySelector('.layer-item__meta');
    meta.textContent = `${Math.round(layer.opacity * 100)}% · ${BLEND_MODES.find((b) => b.id === layer.blendMode)?.label || layer.blendMode}`;
    node.querySelectorAll('.layer-flag')[0].classList.toggle('is-on', layer.locked);
    node.querySelectorAll('.layer-flag')[1].classList.toggle('is-on', layer.alphaLocked);
    node.querySelectorAll('.layer-flag')[2].classList.toggle('is-on', !!layer.clipTo);
    const vis = node.querySelector('.layer-item__vis');
    vis.style.opacity = layer.visible ? '1' : '.45';
    if (!layer.visible) vis.title = 'Показать слой';
  }

  function startRename(node, layer) {
    node.contentEditable = 'true';
    node.focus();
    document.execCommand?.('selectAll', false, null);
    const finish = () => {
      node.contentEditable = 'false';
      const value = node.textContent.trim();
      if (value && value !== layer.name) app.layers.rename(layer.id, value, { record: true });
      else node.textContent = layer.name;
    };
    node.addEventListener('blur', finish, { once: true });
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); node.blur(); }
      if (e.key === 'Escape') { node.textContent = layer.name; node.blur(); }
    });
  }

  function toggleClip(layer) {
    const next = layer.clipTo ? null : (app.doc.layers[app.doc.indexOf(layer.id) - 1]?.id || null);
    if (!layer.clipTo && !next) {
      import('./notify.js').then(({ notify }) => notify('Нет слоя ниже', 'error'));
      return;
    }
    app.layers.setClipTo(layer.id, next, { record: true });
  }

  function showLayerMenu(e, layer) {
    import('./menus.js').then(({ showContextMenu }) => {
      const items = [
        { label: 'Дублировать', key: 'Ctrl+J', action: () => app.layers.duplicateLayer(layer.id) },
        { label: 'Очистить', action: () => app.layers.clearLayer(layer) },
        { sep: true },
        { label: 'Объединить вниз', key: 'Ctrl+E', action: () => app.layers.mergeDown(layer.id) },
        { label: 'Сплющить изображение', action: () => app.layers.flatten() },
        { sep: true },
        { label: 'Переименовать', action: () => {
          const node = list.querySelector(`[data-id="${layer.id}"] .layer-item__name`);
          if (node) startRename(node, layer);
        } },
        { label: 'Удалить', danger: true, key: 'Del', action: () => app.layers.deleteLayer(layer.id) },
      ];
      showContextMenu(e.clientX, e.clientY, items);
    });
  }

  // Подписываемся на события App, а не на app.layers: менеджер слоёв
  // пересоздаётся при открытии файла, и прямая подписка «слепла бы» после этого
  app.on('layers', ({ structural } = {}) => {
    render();
    if (!structural) return;
    // Превью обновляем отложенно — чтобы не тормозить рисование
    clearTimeout(render._t);
    render._t = setTimeout(() => {
      for (const layer of app.doc.layers) {
        const node = list.querySelector(`[data-id="${layer.id}"]`);
        if (node) refreshThumb(layer, node);
      }
    }, 250);
  });

  // После штрихов пиксели слоя меняются, но структура стека — нет
  const refreshActiveThumb = debounce(() => {
    const l = app.doc.activeLayer;
    if (!l) return;
    app.layers.invalidateThumb(l.id);
    const node = list.querySelector(`[data-id="${l.id}"]`);
    if (node) refreshThumb(l, node);
  }, 400);
  app.on('stroke', refreshActiveThumb);
  app.on('tool', () => { app.previewStroke = null; });
  app.on('doc', render);

  render();
  return { render };
}

/* ══════════════════════════════════════════════════════════════════
   Панель истории
   ══════════════════════════════════════════════════════════════════ */

export function initHistoryPanel(app) {
  const list = qs('#historyList');
  const badge = qs('#historyBadge');

  function render(state) {
    const entries = app.history.entries;
    badge.textContent = `${app.history.cursor}/${entries.length}`;

    if (!entries.length) {
      list.replaceChildren(el('li.history-item', { text: 'История пуста' }));
      return;
    }

    const items = entries.map((cmd, i) => el('li.history-item', {
      dataset: { index: i + 1 },
      class: i + 1 === app.history.cursor ? 'is-current' : (i + 1 > app.history.cursor ? 'is-future' : ''),
      onclick: () => app.history.goto(i + 1),
    }, [
      el('i.history-item__dot'),
      `${i + 1}. ${cmd.label}`,
    ]));

    list.replaceChildren(...items);
    list.scrollTop = list.scrollHeight;
  }

  app.on('history', render);
  render();
  return { render };
}

/* ─── Общие мелочи ───────────────────────────────────────────────── */

function icon(pathData) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  for (const d of [].concat(pathData)) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

export { parseColor };