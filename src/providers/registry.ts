import type { Provider, ProviderInput, ProviderDescriptor } from "../types.js";
import type { ProviderAdapter } from "./contract.js";
import { createProvider as codex } from "./codex/index.js";
import { createProvider as claude } from "./claude/index.js";
import { createProvider as antigravity } from "./antigravity/index.js";
import { createProvider as kimi } from "./kimi/index.js";
import { createProvider as xai } from "./xai/index.js";
import { createProvider as devin } from "./devin/index.js";
import { createProvider as meta } from "./meta/index.js";
import { createGeminiProvider as gemini } from "./gemini/index.js";
import { createVertexProvider as vertex } from "./vertex/index.js";
import { createProvider as aistudio } from "./aistudio/index.js";
import { createProvider as compatible } from "./openai-compatible/index.js";

const factories: Record<Provider, () => ProviderAdapter> = {
  codex,
  claude,
  antigravity,
  kimi: () => kimi("kimi"),
  "kimi-ai": () => kimi("kimi-ai"),
  xai,
  devin,
  meta,
  gemini: () => gemini("gemini"),
  "gemini-interactions": () => gemini("gemini-interactions"),
  vertex,
  aistudio,
  "openai-compatibility": compatible,
};
export function getProvider(input: ProviderInput): ProviderAdapter | undefined {
  const id = input === "kimi.ai" ? "kimi-ai" : input === "kimi.com" ? "kimi" : input;
  return Object.hasOwn(factories, id) ? factories[id]() : undefined;
}
export function listProviders(): readonly ProviderDescriptor[] {
  return Object.values(factories).map((factory) => structuredClone(factory().descriptor));
}
