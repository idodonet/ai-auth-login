import type { PersistedApp, PersistedTab, Provider } from "../shared/types.js";

const STORAGE_KEY = "ai-auth-login.demo.v1";
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TABS = 100;
const MAX_MESSAGES = 1000;

export function createTab(provider: Provider | null = null): PersistedTab {
  return {
    id: globalThis.crypto.randomUUID(),
    provider,
    model: null,
    sdkState: null,
    messages: [],
  };
}

function initialState(): PersistedApp {
  const tab = createTab();
  return { version: 1, activeTabId: tab.id, tabs: [tab] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown, maxLength = MAX_BYTES): boolean {
  return value === null || (typeof value === "string" && value.length <= maxLength);
}

function validate(value: unknown): asserts value is PersistedApp {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.activeTabId !== "string" ||
    !Array.isArray(value.tabs) ||
    value.tabs.length === 0 ||
    value.tabs.length > MAX_TABS
  ) {
    throw new Error("Saved demo data has an unsupported version or invalid app structure.");
  }
  const tabIds = new Set<string>();
  for (const tab of value.tabs) {
    if (
      !isRecord(tab) ||
      typeof tab.id !== "string" ||
      !/^[\w-]{1,80}$/.test(tab.id) ||
      tabIds.has(tab.id) ||
      !nullableString(tab.provider, 200) ||
      !nullableString(tab.model, 1000) ||
      !nullableString(tab.sdkState) ||
      !Array.isArray(tab.messages) ||
      tab.messages.length > MAX_MESSAGES
    ) {
      throw new Error("Saved demo data contains an invalid tab.");
    }
    tabIds.add(tab.id);
    const messageIds = new Set<string>();
    for (const message of tab.messages) {
      if (
        !isRecord(message) ||
        typeof message.id !== "string" ||
        !message.id ||
        message.id.length > 200 ||
        messageIds.has(message.id) ||
        (message.role !== "user" && message.role !== "assistant") ||
        typeof message.content !== "string" ||
        (message.status !== undefined &&
          !["complete", "streaming", "stopped", "error"].includes(message.status as string))
      ) {
        throw new Error("Saved demo data contains an invalid message.");
      }
      messageIds.add(message.id);
    }
  }
  if (!tabIds.has(value.activeTabId)) {
    throw new Error("Saved demo data has an invalid active tab.");
  }
}

function checkSize(serialized: string): void {
  if (new TextEncoder().encode(serialized).byteLength > MAX_BYTES) {
    throw new Error("Demo data exceeds the 2 MiB storage limit. Remove old chats before saving.");
  }
}

function storageError(action: string, error: unknown): string {
  if (error instanceof Error && error.name === "QuotaExceededError") {
    return "Browser storage is full. Remove old chats or free browser storage before saving.";
  }
  // Browser exceptions may include sensitive serialized values; show only the operation.
  return `Could not ${action} demo data. Browser storage may be unavailable or blocked.`;
}

export function loadState(storage?: Storage): { state: PersistedApp; error: string | null } {
  let serialized: string | null;
  try {
    serialized = (storage ?? globalThis.localStorage).getItem(STORAGE_KEY);
  } catch (error) {
    return { state: initialState(), error: storageError("load", error) };
  }
  if (serialized === null) {
    return { state: initialState(), error: null };
  }
  try {
    checkSize(serialized);
    const state: unknown = JSON.parse(serialized);
    validate(state);
    for (const tab of state.tabs) {
      for (const message of tab.messages) {
        if (message.status === "streaming") {
          message.status = "stopped";
        }
      }
    }
    return { state, error: null };
  } catch {
    return {
      state: initialState(),
      error:
        "Saved demo data is invalid, too large, or from an unsupported version. Reset explicitly to replace it.",
    };
  }
}

export function saveState(state: PersistedApp, storage?: Storage): string | null {
  let serialized: string;
  try {
    validate(state);
    serialized = JSON.stringify(state);
    checkSize(serialized);
  } catch (error) {
    return error instanceof Error ? error.message : "Could not serialize demo data.";
  }
  try {
    (storage ?? globalThis.localStorage).setItem(STORAGE_KEY, serialized);
    return null;
  } catch (error) {
    return storageError("save", error);
  }
}
