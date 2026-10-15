/**
 * Движок кистей.
 *
 * Кисть — это набор параметров + функция штампа (dab). Штампы кэшируются
 * как маленькие canvas'ы: это в разы быстрее, чем рисовать радиальный
 * градиент на каждый dab заново.
 */

import { mulberry32, clamp } from '../utils/math.js';
import { rgba } from '../utils/color.js';

/** Типы кистей. baseOpacity — множитель для базовой непрозрачности типа. */
export const BRUSH_TYPES = {
  pen:         { label: 'Перо', hardness: 0.98, spacing: 0.04, flow: 1.0, jitter: 0 },
  pencil:      { label: 'Карандаш', hardness: 0.35, spacing: 0.05, flow: 0.55, jitter: 0.55, grain: true },
  ink:         { label: 'Тушь', hardness: 0.85, spacing: 0.03, flow: 0.9, jitter: 0.05 },
  airbrush:    { label: 'Аэрограф', hardness: 0.0, spacing: 0.06, flow: 0.28, jitter: 0 },
  soft:        { label: 'Мягкая', hardness: 0.25, spacing: 0.06, flow: 0.7, jitter: 0 },
  watercolor:  { label: 'Акварель', hardness: 0.45, spacing: 0.1, flow: 0.35, jitter: 0.4, grain: true },
  calligraphy: { label: 'Каллиграфия', hardness: 0.95, spacing: 0.03, flow: 1.0, aspect: 0.22, jitter: 0 },
  marker:      { label: 'Маркер', hardness: 0.7, spacing: 0.05, flow: 0.8, jitter: 0 },
  eraser:      { label: 'Ластик', hardness: 0.6, spacing: 0.05, flow: 1.0, jitter: 0 },
  smudge:      { label: 'Размазывание', hardness: 0.5, spacing: 0.04, flow: 1.0, jitter: 0 },
};

/** Готовые пресеты для панели кистей */
export const PRESETS = [
  { name: 'Тонкое перо',    type: 'pen', size: 3, hardness: 1, flow: 1 },
  { name: 'Толстое перо',    type: 'pen', size: 18, hardness: 1, flow: 1 },
  { name: 'Карандаш 2B',     type: 'pencil', size: 14, hardness: 0.4, flow: 0.6 },
  { name: 'Карандаш HB',     type: 'pencil', size: 6, hardness: 0.5, flow: 0.5 },
  { name: 'Тушь',           type: 'ink', size: 9, hardness: 0.85, flow: 0.95 },
  { name: 'Аэрограф',       type: 'airbrush', size: 90, hardness: 0, flow: 0.3 },
  { name: 'Мягкий мазок',   type: 'soft', size: 60, hardness: 0.2, flow: 0.7 },
  { name: 'Акварель',       type: 'watercolor', size: 48, hardness: 0.45, flow: 0.4 },
  { name: 'Каллиграфия',    type: 'calligraphy', size: 40, hardness: 0.95, flow: 1 },
  { name: 'Маркер',         type: 'marker', size: 26, hardness: 0.75, flow: 0.85 },
  { name: 'Ластик',         type: 'eraser', size: 40, hardness: 0.6, flow: 1 },
];

let defaultColor = { r: 24, g: 26, b: 32 };

export function setDefaultBrushColor(rgb) { defaultColor = { ...rgb }; }

/** Создаёт объект кисти с настройками по умолчанию */
export function makeBrush(props = {}) {
  const type = props.type || 'pen';
  const base = BRUSH_TYPES[type] || BRUSH_TYPES.pen;
  return {
    type,
    name: props.name || base.label,
    size: clamp(props.size ?? 24, 1, 2000),
    opacity: clamp(props.opacity ?? 1, 0, 1),
    flow: clamp(props.flow ?? base.flow, 0.01, 1),
    hardness: clamp(props.hardness ?? base.hardness, 0, 1),
    spacing: clamp(props.spacing ?? base.spacing, 0.01, 1),
    /** Насколько размер зависит от давления, 0..1 */
    sizeDynamics: clamp(props.sizeDynamics ?? 0, 0, 1),
    /** Насколько прозрачность зависит от давления */
    opacityDynamics: clamp(props.opacityDynamics ?? 0, 0, 1),
    /** Насколько толщина зависит от наклона пера */
    tiltDynamics: clamp(props.tiltDynamics ?? 0, 0, 1),
    /** Случайный разброс размера (для зерна) */
    jitter: clamp(props.jitter ?? base.jitter, 0, 1),
    /** Сид зерна: у каждой кисти свой, иначе все «карандаши» зернятся одинаково */
    seed: props.seed ?? (Math.floor(Math.random() * 1e9) + 1),
    /** Угол кисти в градусах (для каллиграфии/текстуры) */
    angle: props.angle ?? 0,
    /** Отношение меньшей стороны к большей (эллипс) */
    aspect: props.aspect ?? base.aspect ?? 1,
    /** Сила сглаживания 0..1 (демпфирование координат) */
    smoothing: clamp(props.smoothing ?? 0.5, 0, 0.95),
    /** Цвет: {r,g,b} */
    color: props.color ? { ...props.color } : { ...defaultColor },
    /** Режим наложения внутри слоя (ластик — destination-out) */
    composite: props.composite || 'source-over',
    texture: props.texture || null,
  };
}

/* ─── Кэш штампов ──────────────────────────────────────────────────── */

const stampCache = new Map();
const CACHE_LIMIT = 160;

/** Радиус штампа с учётом жёсткости: мягкие кисти требуют запаса */
export function dabRadius(brush) {
  return Math.max(0.5, brush.size * 0.5);
}

function stampKey(brush) {
  return [
    brush.type, Math.round(brush.size), brush.hardness.toFixed(2),
    brush.color.r, brush.color.g, brush.color.b, brush.aspect.toFixed(2),
    brush.texture?.name || '', Math.round(brush.angle),
  ].join('|');
}

/**
 * Возвращает готовый canvas штампа (с прозрачностью) или null, если
 * параметры требуют рисования «на лету».
 */
function getStamp(brush) {
  const key = stampKey(brush);
  const hit = stampCache.get(key);
  if (hit) return hit;

  const meta = BRUSH_TYPES[brush.type] || BRUSH_TYPES.pen;
  const r = dabRadius(brush);
  const size = Math.ceil(r * 2) + 2;         // +2 на сглаживание по краям
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const cx = size / 2;

  // Растягиваем в эллипс, если кисти задана аспект (каллиграфия)
  const aspect = clamp(brush.aspect, 0.02, 1);
  ctx.save();
  ctx.translate(cx, cx);
  ctx.rotate((brush.angle * Math.PI) / 180);
  ctx.scale(1, aspect);
  ctx.translate(-cx, -cx);

  const color = rgba(brush.color);

  if (brush.texture?.image) {
    // Пользовательская текстура (PNG-штамп)
    const img = brush.texture.image;
    ctx.drawImage(img, 0, 0, size, size);
  } else if (meta.grain) {
    drawGrainStamp(ctx, cx, cx, r, brush, color, meta);
  } else if (brush.hardness >= 0.97) {
    // Жёсткий край: круг + тонкая AA-обводка
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cx, r - 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.arc(cx, cx, r - 0.25, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.5;
    ctx.stroke();
  } else {
    // Мягкий радиальный градиент: жёсткость = позиция начала затухания
    const g = ctx.createRadialGradient(cx, cx, 0, cx, cx, r);
    const h = brush.hardness;
    g.addColorStop(0, color);
    if (h > 0) g.addColorStop(Math.max(0, Math.min(0.99, h)), color);
    g.addColorStop(1, rgba(brush.color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cx, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  if (stampCache.size > CACHE_LIMIT) stampCache.delete(stampCache.keys().next().value);
  stampCache.set(key, c);
  return c;
}

/** Зернистый штамп (карандаш/акварель) — набор полупрозрачных точек */
function drawGrainStamp(ctx, cx, cy, r, brush, color, meta) {
  const rnd = mulberry32((brush.seed || 1) >>> 0);
  // У акварели зерно крупнее и реже, у карандаша — мелкое и частое
  const density = brush.type === 'watercolor' ? 26 : 90;
  const maxR = Math.max(1, Math.floor(r));
  const base = Math.max(0.05, 0.5 * (1 - brush.hardness * 0.5));

  for (let i = 0; i < density; i++) {
    // Равномерное распределение по площади круга
    const a = rnd() * Math.PI * 2;
    const rr = Math.sqrt(rnd()) * maxR;
    const x = cx + Math.cos(a) * rr;
    const y = cy + Math.sin(a) * rr;
    // Края мягче
    const falloff = 1 - (rr / r) * (1 - brush.hardness);
    ctx.globalAlpha = base * falloff * (0.45 + rnd() * 0.55);
    ctx.fillStyle = color;
    const s = 0.5 + rnd() * 1.2;
    ctx.fillRect(x - s / 2, y - s / 2, s, s);
  }
  ctx.globalAlpha = 1;
}

export function clearStampCache() { stampCache.clear(); }

/* ─── Нанесение штампа ─────────────────────────────────────────────── */

/**
 * Рисует один dab в контекст слоя.
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} brush
 * @param {number} x мировые координаты
 * @param {number} y
 * @param {object} [o] { alpha, scale, rotation }
 */
export function stampDab(ctx, brush, x, y, o = {}) {
  const alpha = clamp(o.alpha ?? 1, 0, 1);
  if (alpha <= 0.001) return;

  const r = dabRadius(brush) * (o.scale ?? 1);
  if (r < 0.25) {
    // Совсем мелкая кисть — рисуем пиксель, иначе получится «дырявый» след
    ctx.globalAlpha = alpha;
    ctx.fillStyle = rgba(brush.color);
    ctx.fillRect(x - 0.5, y - 0.5, 1, 1);
    ctx.globalAlpha = 1;
    return;
  }

  const stamp = getStamp(brush);
  // Штамп кэшируется в размере brush.size — масштабируем при отрисовке
  const d = (stamp.width / 2) * (o.scale ?? 1);
  ctx.save();
  ctx.globalAlpha = alpha;
  if (o.rotation) {
    ctx.translate(x, y);
    ctx.rotate(o.rotation);
    ctx.drawImage(stamp, -d, -d, d * 2, d * 2);
  } else {
    ctx.drawImage(stamp, x - d, y - d, d * 2, d * 2);
  }
  ctx.restore();
}

/**
 * Эффективный размер кисти при текущем давлении/наклоне.
 * Давление 1 → полный размер, 0 → почти ноль (при включённой динамике).
 */
export function dynamicSize(brush, { pressure = 1, tilt = 0 } = {}) {
  let s = brush.size;
  if (brush.sizeDynamics > 0) {
    const p = Number.isFinite(pressure) ? clamp(pressure, 0.02, 1) : 1;
    s *= 1 - brush.sizeDynamics * (1 - p ** 0.7);
  }
  if (brush.tiltDynamics > 0) {
    const t = Number.isFinite(tilt) ? clamp(tilt, 0, 1) : 0;
    s *= 1 + brush.tiltDynamics * 0.9 * t;
  }
  return Math.max(0.5, Number.isFinite(s) ? s : brush.size);
}

/**
 * Прозрачность dab с учётом flow, динамики давления и накопления.
 * @param {object} brush
 * @param {object} p точка штриха: { pressure }
 */
export function dynamicAlpha(brush, p = {}) {
  const pressure = Number.isFinite(p.pressure) ? clamp(p.pressure, 0.02, 1) : 1;
  let a = brush.flow * brush.opacity;
  if (brush.opacityDynamics > 0) {
    a *= 1 - brush.opacityDynamics * (1 - pressure);
  }
  return clamp(a, 0, 1);
}

/** Прямоугольник, который закроет dab данного размера */
export function dabBounds(x, y, radius) {
  return { x: x - radius, y: y - radius, w: radius * 2, h: radius * 2 };
}

/** Клонирование кисти (для превью в панели) */
export const cloneBrush = (b) => ({ ...b, color: { ...b.color } });