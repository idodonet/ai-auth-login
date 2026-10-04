import assert from "node:assert/strict";
import { test } from "node:test";
import { createTab, loadState, saveState } from "../src/client/storage.js";
import type { PersistedApp } from "../src/shared/types.js";

class MemoryStorage implements Storage {
  values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  clear(): void {
    this.values.clear();
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function app(): PersistedApp {
  const tab = createTab("codex");
  return { version: 1, activeTabId: tab.id, tabs: [tab] };
}

const key = "ai-auth-login.demo.v1";

test("opaque SDK state survives without parsing; interrupted streams restore as stopped", () => {
  const storage = new MemoryStorage();
  const state = app();
  state.tabs[0]!.sdkState = "opaque secret: { definitely not JSON }";
  state.tabs[0]!.messages = [
    { id: "m1", role: "assistant", content: "partial", status: "streaming" },
  ];
  assert.equal(saveState(state, storage), null);
  const restored = loadState(storage);
  assert.equal(restored.error, null);
  assert.equal(restored.state.tabs[0]!.sdkState, state.tabs[0]!.sdkState);
  assert.equal(restored.state.tabs[0]!.messages[0]!.status, "stopped");
  assert.equal(state.tabs[0]!.messages[0]!.status, "streaming");
});

test("invalid JSON, versions, duplicate IDs, and malformed messages leave original storage intact", () => {
  const state = app();
  const duplicate = { ...state, tabs: [state.tabs[0], state.tabs[0]] };
  const invalidMessage = structuredClone(state);
  invalidMessage.tabs[0]!.messages = [
    { id: "m", role: "user", content: "a" },
    { id: "m", role: "user", content: "b" },
  ];
  for (const serialized of [
    "{broken",
    JSON.stringify({ ...state, version: 2 }),
    JSON.stringify(duplicate),
    JSON.stringify(invalidMessage),
  ]) {
    const storage = new MemoryStorage();
    storage.setItem(key, serialized);
    const restored = loadState(storage);
    assert.ok(restored.error);
    assert.equal(restored.state.tabs.length, 1);
    assert.equal(storage.getItem(key), serialized);
  }
});

test("missing storage gives one usable tab", () => {
  const restored = loadState(new MemoryStorage());
  assert.equal(restored.error, null);
  assert.equal(restored.state.activeTabId, restored.state.tabs[0]!.id);
});

test("saved tab IDs must be usable in the server action routes", () => {
  for (const id of ["has spaces", "a/b", "x".repeat(81)]) {
    const storage = new MemoryStorage();
    const state = app();
    state.tabs[0]!.id = id;
    state.activeTabId = id;
    storage.setItem(key, JSON.stringify(state));
    assert.ok(loadState(storage).error);
    assert.match(saveState(state, storage)!, /invalid tab/);
  }
  const state = app();
  state.tabs[0]!.id = "x".repeat(80);
  state.activeTabId = state.tabs[0]!.id;
  assert.equal(saveState(state, new MemoryStorage()), null);
});

test("storage exceptions are visible and do not expose exception contents", () => {
  const storage = new MemoryStorage();
  storage.getItem = () => {
    throw new Error("SECRET");
  };
  storage.setItem = () => {
    throw new DOMException("SECRET", "QuotaExceededError");
  };
  assert.match(loadState(storage).error!, /unavailable or blocked/);
  assert.match(saveState(app(), storage)!, /storage is full/);
  assert.doesNotMatch(loadState(storage).error!, /SECRET/);
});

test("oversize and invalid state cannot replace the last good save", () => {
  const storage = new MemoryStorage();
  const state = app();
  assert.equal(saveState(state, storage), null);
  const original = storage.getItem(key);
  state.tabs[0]!.messages.push({ id: "big", role: "user", content: "😀".repeat(600_000) });
  assert.match(saveState(state, storage)!, /2 MiB/);
  assert.equal(storage.getItem(key), original);
  state.tabs[0]!.messages = [];
  state.activeTabId = "missing";
  assert.match(saveState(state, storage)!, /active tab/);
  assert.equal(storage.getItem(key), original);
});
