/**
 * Попиксельные режимы наложения, которые Canvas2D не умеет:
 * Оттенок, Насыщенность, Цвет, Светлота (неразделимые режимы Photoshop).
 *
 * Формулы — из спецификации W3C Compositing and Blending Level 1
 * (https://www.w3.org/TR/compositing/#blending), с поправкой на альфу.
 *
 * Фаза 4 заменит этот модуль на WebGL-шейдер; интерфейс (blendPixels)
 * останется тем же, поэтому вызывающий код не изменится.
 */

/* ─── Разделимые режимы (пригодятся для шейдеров и отладки) ───────── */

export const SEPARABLE = {
  multiply: (b, s) => b * s,
  screen: (b, s) => b + s - b * s,
  overlay: (b, s) => b < 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s),
  darken: (b, s) => Math.min(b, s),
  lighten: (b, s) => Math.max(b, s),
  'color-dodge': (b, s) => b === 0 ? 0 : s === 1 ? 1 : Math.min(1, b / (1 - s)),
  'color-burn': (b, s) => b === 1 ? 1 : s === 0 ? 0 : 1 - Math.min(1, (1 - b) / s),
  'hard-light': (b, s) => s < 0.5 ? 2 * s * b : 1 - 2 * (1 - s) * (1 - b),
  'soft-light': (b, s) => {
    if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
    const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
    return b + (2 * s - 1) * (d - b);
  },
  difference: (b, s) => Math.abs(b - s),
  exclusion: (b, s) => b + s - 2 * b * s,
};

/* ─── Неразделимые режимы ────────────────────────────────────────── */

const lum = ({ r, g, b }) => 0.3 * r + 0.59 * g + 0.11 * b;

function clipColor(c) {
  const l = lum(c);
  const n = Math.min(c.r, c.g, c.b);
  const x = Math.max(c.r, c.g, c.b);
  let out = { ...c };
  if (n < 0) {
    const d = l - n;
    out = {
      r: l + ((out.r - l) * l) / d,
      g: l + ((out.g - l) * l) / d,
      b: l + ((out.b - l) * l) / d,
    };
  }
  if (x > 1) {
    const d = x - l;
    out = {
      r: l + ((out.r - l) * d) / (1 - l),
      g: l + ((out.g - l) * d) / (1 - l),
      b: l + ((out.b - l) * d) / (1 - l),
    };
  }
  return out;
}

function setLum(c, l) {
  const d = l - lum(c);
  return clipColor({ r: c.r + d, g: c.g + d, b: c.b + d });
}

const sat = ({ r, g, b }) => Math.max(r, g, b) - Math.min(r, g, b);

function setSat(c, s) {
  const idx = [c.r, c.g, c.b];
  const mn = Math.min(...idx);
  const mx = Math.max(...idx);
  if (mx === mn) return { r: 0, g: 0, b: 0 };
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    out[i] = ((idx[i] - mn) / (mx - mn)) * s;
  }
  return { r: out[0], g: out[1], b: out[2] };
}

export const NON_SEPARABLE = {
  hue: (b, s) => setLum(setSat(s, sat(b)), lum(b)),
  saturation: (b, s) => setLum(setSat(b, sat(s)), lum(b)),
  color: (b, s) => setLum(s, lum(b)),
  luminosity: (b, s) => setLum(b, lum(s)),
};

/**
 * Смешивает два ImageData в третий по режиму mode.
 * Оба буфера должны быть одинакового размера и формата RGBA.
 * Работает на месте над `out` (может совпадать с backdrop).
 */
export function blendPixels(backdrop, source, out, mode) {
  const cb = backdrop.data;
  const cs = source.data;
  const co = out.data;

  if (mode === 'normal' || mode === 'source-over') {
    // Формула source-over для непрозрачных (non-premultiplied) данных:
    // Co = as·Cs + (1−as)·ab·Cb, затем делим на итоговую альфу
    for (let i = 0; i < cb.length; i += 4) {
      const ab = cb[i + 3] / 255;
      const as = cs[i + 3] / 255;
      const ao = as + ab - as * ab;
      if (ao <= 0) { co[i] = co[i + 1] = co[i + 2] = co[i + 3] = 0; continue; }
      for (let k = 0; k < 3; k++) {
        co[i + k] = (cs[i + k] * as + cb[i + k] * ab * (1 - as)) / ao;
      }
      co[i + 3] = ao * 255;
    }
    return out;
  }

  const fn = NON_SEPARABLE[mode];
  if (!fn) return out; // неизвестный режим — ничего не делаем

  const b = { r: 0, g: 0, b: 0 };
  const s = { r: 0, g: 0, b: 0 };

  for (let i = 0; i < cb.length; i += 4) {
    const ab = cb[i + 3];
    const as = cs[i + 3];

    if (as === 0) {
      co[i] = cb[i]; co[i + 1] = cb[i + 1]; co[i + 2] = cb[i + 2]; co[i + 3] = ab;
      continue;
    }
    if (ab === 0) {
      co[i] = cs[i]; co[i + 1] = cs[i + 1]; co[i + 2] = cs[i + 2]; co[i + 3] = as;
      continue;
    }

    b.r = cb[i] / 255; b.g = cb[i + 1] / 255; b.b = cb[i + 2] / 255;
    s.r = cs[i] / 255; s.g = cs[i + 1] / 255; s.b = cs[i + 2] / 255;

    const blended = fn(b, s);
    const cbr = ab / 255;
    const csr = as / 255;
    const ao = csr + cbr - csr * cbr;

    // Формула W3C: Co = cs(1-cb)Cs + cs·cb·B(Cb,B,S) + (1-cs)cb·B
    for (const k of ['r', 'g', 'b']) {
      const v = csr * (1 - cbr) * s[k]
        + csr * cbr * blended[k]
        + (1 - csr) * cbr * b[k];
      co[i + (k === 'r' ? 0 : k === 'g' ? 1 : 2)] = v * ao * 255;
    }
    co[i + 3] = ao * 255;
  }
  return out;
}