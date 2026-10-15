/**
 * Заливка по цвету (flood fill) и «волшебная палочка».
 *
 * Возвращает битовую маску (Uint8Array, 1 = пиксель принадлежит области)
 * — её одинаково используют заливка, палочка и «выделение по цвету» в Фазе 2.
 */

const matches = (data, i, r, g, b, tol) =>
  Math.abs(data[i] - r) <= tol
  && Math.abs(data[i + 1] - g) <= tol
  && Math.abs(data[i + 2] - b) <= tol;

/**
 * @param {ImageData} imageData источник (уже обрезанный по выделению)
 * @param {number} w
 * @param {number} h
 * @param {number} sx стартовая X (в координатах источника)
 * @param {number} sy стартовая Y
 * @param {number} tolerance 0..255
 * @param {object} [opts] { contiguous = true, alphaSensitive = true }
 * @returns {Uint8Array} маска w*h
 */
export function floodFillMask(imageData, w, h, sx, sy, tolerance = 32, opts = {}) {
  const { contiguous = true, alphaSensitive = true } = opts;
  const data = imageData.data;
  const mask = new Uint8Array(w * h);

  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return mask;

  const start = (sy * w + sx) * 4;
  const tr = data[start];
  const tg = data[start + 1];
  const tb = data[start + 2];
  const ta = data[start + 3];

  if (!contiguous) {
    // «Волшебная палочка» без непрерывности: все похожие пиксели
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const same = alphaSensitive ? Math.abs(data[i + 3] - ta) <= tolerance : true;
        if (same && matches(data, i, tr, tg, tb, tolerance)) mask[y * w + x] = 1;
      }
    }
    return mask;
  }

  // Scanline-алгоритм: заливка целыми горизонтальными отрезками
  const stack = [sx, sy];
  while (stack.length) {
    const y = stack.pop();
    let x = stack.pop();

    let left = x;
    while (left > 0) {
      const idx = y * w + (left - 1);
      if (mask[idx] || !matches(data, idx * 4, tr, tg, tb, tolerance)) break;
      if (alphaSensitive && Math.abs(data[idx * 4 + 3] - ta) > tolerance) break;
      left--;
    }
    let right = x;
    while (right < w - 1) {
      const idx = y * w + (right + 1);
      if (mask[idx] || !matches(data, idx * 4, tr, tg, tb, tolerance)) break;
      if (alphaSensitive && Math.abs(data[idx * 4 + 3] - ta) > tolerance) break;
      right++;
    }

    for (let i = left; i <= right; i++) mask[y * w + i] = 1;

    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= h) continue;
      let i = left;
      while (i <= right) {
        // idx обязан пересчитываться на каждом шаге, иначе проверяется устаревший пиксель
        const idx = ny * w + i;
        if (!mask[idx] && matches(data, idx * 4, tr, tg, tb, tolerance)
          && (!alphaSensitive || Math.abs(data[idx * 4 + 3] - ta) <= tolerance)) {
          stack.push(i, ny);
          // Пропускаем весь непрерывный участок — точки в стек не нужны
          while (i <= right) {
            const k = ny * w + i;
            if (mask[k] || !matches(data, k * 4, tr, tg, tb, tolerance)
              || (alphaSensitive && Math.abs(data[k * 4 + 3] - ta) > tolerance)) break;
            i++;
          }
        } else {
          i++;
        }
      }
    }
  }

  return mask;
}

/** Превращает маску в ImageData с заданным цветом (alpha = mask) */
export function maskToImageData(mask, w, h, { r, g, b }, alpha = 255) {
  const out = new ImageData(w, h);
  const d = out.data;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const p = i * 4;
    d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = alpha;
  }
  return out;
}

/** Сколько пикселей в маске (для отладочной статистики) */
export function maskCount(mask) {
  let n = 0;
  for (let i = 0; i < mask.length; i++) n += mask[i];
  return n;
}