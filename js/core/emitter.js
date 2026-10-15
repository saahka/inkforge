/** Минимальная шина событий: on / off / once / emit. */
export class Emitter {
  #map = new Map();

  on(type, fn) {
    if (!this.#map.has(type)) this.#map.set(type, new Set());
    this.#map.get(type).add(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const off = this.on(type, (...args) => { off(); fn(...args); });
    return off;
  }

  off(type, fn) {
    this.#map.get(type)?.delete(fn);
  }

  emit(type, ...args) {
    const set = this.#map.get(type);
    if (!set) return;
    // Копия набора: обработчик может отписаться прямо во время вызова
    for (const fn of [...set]) {
      try {
        fn(...args);
      } catch (err) {
        console.error(`[InkForge] ошибка в обработчике "${type}"`, err);
      }
    }
  }

  clear() { this.#map.clear(); }
}