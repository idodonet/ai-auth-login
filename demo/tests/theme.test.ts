import assert from "node:assert/strict";
import test from "node:test";
import { loadTheme, saveTheme } from "../src/client/theme";
test("theme defaults to system, validates preferences, and survives storage failures", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let value: string | null = null;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => value,
      setItem: (_key: string, next: string) => {
        value = next;
      },
    },
  });
  try {
    assert.equal(loadTheme(), "system");
    saveTheme("dark");
    assert.equal(loadTheme(), "dark");
    saveTheme("light");
    assert.equal(loadTheme(), "light");
    value = "unknown";
    assert.equal(loadTheme(), "system");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("Unavailable");
      },
    });
    assert.equal(loadTheme(), "system");
    assert.doesNotThrow(() => saveTheme("dark"));
  } finally {
    if (original) {
      Object.defineProperty(globalThis, "localStorage", original);
    } else {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  }
});
