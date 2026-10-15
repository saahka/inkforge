/**
 * Математические помощники: интерполяция, геометрия прямоугольников, генерация id.
 * Никаких зависимостей — чистые функции.
 */

export const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const round = (v, digits = 0) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/** Плавная интерполяция 0..1 (smoothstep) */
export const smoothstep = (t) => t * t * (3 - 2 * t);

/** Расстояние между точками */
export const dist = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1);

/** Короткий уникальный id без внешних зависимостей */
let idCounter = 0;
export const uid = (prefix = 'id') =>
  `${prefix}_${Date.now().toString(36)}_${(idCounter++).toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

/* ─── Прямоугольники (везде формат {x, y, w, h}) ─────────────────────── */

export const makeRect = (x, y, w, h) => ({ x, y, w, h });

export const rectFromPoints = (x1, y1, x2, y2) => ({
  x: Math.min(x1, x2),
  y: Math.min(y1, y2),
  w: Math.abs(x2 - x1),
  h: Math.abs(y2 - y1),
});

/** Нормализует «перевёрнутые» прямоугольники (w/h < 0) */
export const normalizeRect = (r) =>
  r.w < 0 ? { x: r.x + r.w, y: r.y, w: -r.w, h: r.h }
  : r.h < 0 ? { x: r.x, y: r.y + r.h, w: r.w, h: -r.h }
  : r;

export const rectsIntersect = (a, b) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

export const rectContainsRect = (outer, inner) =>
  inner.x >= outer.x && inner.y >= outer.y &&
  inner.x + inner.w <= outer.x + outer.w &&
  inner.y + inner.h <= outer.y + outer.h;

export const rectContainsPoint = (r, x, y) =>
  x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/** Объединение двух прямоугольников; null + r = r */
export const unionRect = (a, b) => {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const r = Math.max(a.x + a.w, b.x + b.w);
  const bt = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: r - x, h: bt - y };
};

/** Пересечение двух прямоугольников или null */
export const intersectRect = (a, b) => {
  if (!rectsIntersect(a, b)) return null;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, w: Math.min(a.x + a.w, b.x + b.w) - x, h: Math.min(a.y + a.h, b.y + b.h) - y };
};

/** Расширяет прямоугольник на n пикселей по всем сторонам */
export const expandRect = (r, n) => ({ x: r.x - n, y: r.y - n, w: r.w + n * 2, h: r.h + n * 2 });

export const rectArea = (r) => Math.max(0, r.w) * Math.max(0, r.h);

/** Прямоугольник, покрывающий отрезок (с запасом под толщину мазка) */
export const segmentBounds = (p0, p1, pad = 0) => ({
  x: Math.min(p0.x, p1.x) - pad,
  y: Math.min(p0.y, p1.y) - pad,
  w: Math.abs(p1.x - p0.x) + pad * 2,
  h: Math.abs(p1.y - p0.y) + pad * 2,
});

/* ─── Сглаживание штрихов ────────────────────────────────────────────── */

/**
 * Интерполяция Catmull-Rom между p1 и p2 (p0/p3 — соседние точки).
 * Даёт гладкую кривую, проходящую точно через точки — база для «ровных» линий.
 */
export function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t +
      (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
      (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t +
      (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
      (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}

/**
 * Сглаживает ломаную по алгоритму Catmull-Rom в равномерно распределённые точки.
 * @param {Array<{x:number,y:number}>} pts исходные точки
 * @param {number} steps точек на один сегмент
 * @returns {Array<{x:number,y:number}>}
 */
export function smoothPolyline(pts, steps = 6) {
  if (pts.length < 3) return pts.slice();
  const out = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    for (let s = 1; s <= steps; s++) {
      out.push(catmullRom(p0, p1, p2, p3, s / steps));
    }
  }
  return out;
}

/** Демпфированная (low-pass) фильтрация координат — убирает дрожание руки */
export function lowPass(prev, next, amount) {
  if (!prev) return { x: next.x, y: next.y };
  return {
    x: prev.x + (next.x - prev.x) * amount,
    y: prev.y + (next.y - prev.y) * amount,
  };
}

/** Равномерно пересемплирует ломаную с шагом step */
export function resample(pts, step) {
  if (pts.length < 2 || step <= 0) return pts.slice();
  const out = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const d = dist(a.x, a.y, b.x, b.y);
    if (d < 1e-6) continue;
    let t = (step - carry) / d;
    while (t <= 1) {
      out.push({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });
      t += step / d;
    }
    carry = (carry + d) % step;
  }
  const last = pts[pts.length - 1];
  const tail = out[out.length - 1];
  if (dist(tail.x, tail.y, last.x, last.y) > step * 0.35) out.push({ ...last });
  return out;
}

/** Линейная экстраполяция траектории — для предсказания позиции пера */
export function extrapolate(last, prev, latencySec, maxDist = 60) {
  const vx = (last.x - prev.x);
  const vy = (last.y - prev.y);
  const d = Math.hypot(vx, vy);
  if (d < 1e-4) return { x: last.x, y: last.y };
  const k = Math.min(latencySec * 60, maxDist) / d; // 60 px ≈ «единица скорости»
  return { x: last.x + vx * k, y: last.y + vy * k };
}

/* ─── Разное ────────────────────────────────────────────────────────── */

/** Детерминированный ГПСЧ (для текстур карандаша — стабильная зернистость) */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const formatBytes = (bytes) => {
  if (!bytes) return '0 Б';
  const u = ['Б', 'КБ', 'МБ', 'ГБ'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), u.length - 1);
  return `${round(bytes / 1024 ** i, i ? 1 : 0)} ${u[i]}`;
};

export const formatDate = (ts) =>
  new Date(ts).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });