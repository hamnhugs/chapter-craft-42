import "@testing-library/jest-dom";

/**
 * Web Storage for the test environment.
 *
 * WHY THIS IS HERE AND NOT JSDOM'S. Node 26 added its own GLOBAL
 * `localStorage` / `sessionStorage` accessors, which resolve to `undefined`
 * unless the process was started with `--localstorage-file`. Vitest's jsdom
 * environment copies jsdom's window properties onto `globalThis` but SKIPS any
 * key that already exists there, so Node's inert accessor wins and jsdom's real
 * Storage is never installed. The result is that `localStorage` is `undefined`
 * in every test — `window.localStorage` too, since under Vitest `window` IS
 * `globalThis` — and any suite whose `beforeEach` starts with
 * `localStorage.clear()` dies on the first line with "Cannot read properties of
 * undefined (reading 'clear')" before its own code is reached.
 *
 * That is an environment fault, not a product one: the app's storage code is
 * fine, and these same suites pass on a Node that has no such global. Rather
 * than pin a Node version or thread `--localstorage-file` through every runner,
 * the storage is supplied here.
 *
 * The implementation follows the Web Storage spec where the specs bite:
 * keys and values are coerced to strings (`setItem(k, 1)` then `getItem(k)`
 * returns `"1"`, not `1`), a missing key reads `null` rather than `undefined`,
 * and `key(n)` indexes insertion order. Backed by a Map, per realm, so each
 * test file starts clean.
 */
class MemoryStorage implements Storage {
  #items = new Map<string, string>();

  get length(): number { return this.#items.size; }
  key(index: number): string | null { return [...this.#items.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.#items.get(String(key)) ?? null; }
  setItem(key: string, value: string): void { this.#items.set(String(key), String(value)); }
  removeItem(key: string): void { this.#items.delete(String(key)); }
  clear(): void { this.#items.clear(); }
  [name: string]: unknown;
}

for (const name of ["localStorage", "sessionStorage"] as const) {
  // Only when it is actually missing — a Node or jsdom that provides working
  // Storage keeps its own, so this never masks the real implementation.
  if (globalThis[name] == null) {
    Object.defineProperty(globalThis, name, {
      value: new MemoryStorage(),
      configurable: true,
      writable: true,
    });
  }
}

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});
