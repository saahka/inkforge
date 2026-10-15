/**
 * Цветовые утилиты: конвертации RGB/HSV/HSL/CMYK/HEX, гармонии, палитры.
 */

import { clamp } from './math.js';

/* ─── Базовые конвертации ──────────────────────────────────────────── */

export function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360 / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 1) [r, g, b] = [c, x, 0];
  else if (h < 2) [r, g, b] = [x, c, 0];
  else if (h < 3) [r, g, b] = [0, c, x];
  else if (h < 4) [r, g, b] = [0, x, c];
  else if (h < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

export function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

export function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return {
    r: Math.round(hue2rgb(h + 1 / 3) * 255),
    g: Math.round(hue2rgb(h) * 255),
    b: Math.round(hue2rgb(h - 1 / 3) * 255),
  };
}

export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

export function rgbToCmyk(r, g, b) {
  const R = r / 255, G = g / 255, B = b / 255;
  const k = 1 - Math.max(R, G, B);
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 100 };
  return {
    c: Math.round(((1 - R - k) / (1 - k)) * 100),
    m: Math.round(((1 - G - k) / (1 - k)) * 100),
    y: Math.round(((1 - B - k) / (1 - k)) * 100),
    k: Math.round(k * 100),
  };
}

export function cmykToRgb(c, m, y, k) {
  const C = c / 100, M = m / 100, Y = y / 100, K = k / 100;
  return {
    r: Math.round(255 * (1 - C) * (1 - K)),
    g: Math.round(255 * (1 - M) * (1 - K)),
    b: Math.round(255 * (1 - Y) * (1 - K)),
  };
}

/* ─── HEX / строки ──────────────────────────────────────────────────── */

const hex2 = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');

/** {r,g,b} → "#rrggbb" */
export const rgbToHex = ({ r, g, b }) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

/** "#rgb" | "#rrggbb" | "rgb(...)" → {r,g,b} | null */
export function parseColor(str) {
  if (!str) return null;
  const s = String(str).trim().toLowerCase();
  if (s[0] === '#') {
    const h = s.slice(1);
    if (h.length === 3 || h.length === 4) {
      const r = parseInt(h[0] + h[0], 16);
      const g = parseInt(h[1] + h[1], 16);
      const b = parseInt(h[2] + h[2], 16);
      return Number.isNaN(r) ? null : { r, g, b };
    }
    if (h.length === 6 || h.length === 8) {
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      return Number.isNaN(r) ? null : { r, g, b };
    }
    return null;
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(/[,/\s]+/).filter(Boolean).map(Number);
    return { r: p[0] | 0, g: p[1] | 0, b: p[2] | 0 };
  }
  return null;
}

export const rgba = ({ r, g, b }, a = 1) =>
  a >= 1 ? rgbToHex({ r, g, b })
    : `rgba(${clamp(r | 0, 0, 255)},${clamp(g | 0, 0, 255)},${clamp(b | 0, 0, 255)},${round3(a)})`;

const round3 = (v) => Math.round(v * 1000) / 1000;

/* ─── Оттенки и гармонии ────────────────────────────────────────────── */

/** Сдвигает оттенок на delta градусов с коррекцией «по краю круга» */
export function shiftHue(rgb, delta) {
  const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
  return hsvToRgb(hsv.h + delta, hsv.s, hsv.v);
}

/**
 * Цветовые схемы относительно опорного цвета.
 * @returns {{name:string, colors:{r,g,b}[]}[]}
 */
export function harmonies(rgb) {
  const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
  const at = (deg, sMul = 1, vMul = 1) => {
    const c = hsvToRgb(hsv.h + deg, clamp(hsv.s * sMul, 0, 1), clamp(hsv.v * vMul, 0, 1));
    return c;
  };
  return [
    { name: 'Комплементарная', colors: [rgb, at(180)] },
    { name: 'Триадная', colors: [rgb, at(120), at(240)] },
    { name: 'Аналоговая', colors: [at(-30), rgb, at(30)] },
    { name: 'Разделённая комплементарная', colors: [rgb, at(150), at(210)] },
    { name: 'Тетрадическая', colors: [rgb, at(90), at(180), at(270)] },
    { name: 'Монохромная', colors: [at(0, 0.15, 1), rgb, at(0, 0.8, 0.55), at(0, 1, 0.3)] },
  ];
}

/** Относительная яркость (WCAG) — для выбора контрастного текста */
export function luminance({ r, g, b }) {
  const f = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export const contrastText = (rgb) => (luminance(rgb) > 0.42 ? '#14161a' : '#ffffff');

/* ─── Палитра ───────────────────────────────────────────────────────── */

const PALETTE_KEY = 'inkforge.palette.v1';
const RECENT_KEY = 'inkforge.recent.v1';
const DEFAULT_PALETTE = [
  '#000000', '#404040', '#808080', '#c0c0c0', '#ffffff',
  '#7f0000', '#ff0000', '#ff7f00', '#ffff00', '#7fff00',
  '#00ff00', '#00ff7f', '#00ffff', '#007fff', '#0000ff',
  '#7f00ff', '#ff00ff', '#ff007f', '#8b4513', '#d2691e',
  '#f4a460', '#ffe4c4', '#2f4f4f', '#556b2f', '#8fbc8f',
  '#191970', '#4b0082', '#9400d3', '#ff69b4', '#fa8072',
];

export function loadPalette() {
  try {
    const raw = localStorage.getItem(PALETTE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* повреждённые данные — используем дефолт */ }
  return DEFAULT_PALETTE.slice();
}

export function savePalette(colors) {
  try {
    localStorage.setItem(PALETTE_KEY, JSON.stringify(colors.slice(-200)));
  } catch { /* приватный режим — просто не сохраняем */ }
}

export function loadRecent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  } catch {
    return [];
  }
}

export function pushRecent(hex) {
  const list = loadRecent().filter((c) => c !== hex);
  list.unshift(hex);
  const trimmed = list.slice(0, 24);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(trimmed)); } catch { /* игнорируем */ }
  return trimmed;
}