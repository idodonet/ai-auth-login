import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const key = createHash("sha256").update("CLIProxyAPI").digest();
/** CPA's fixed key is wire encoding, not a secret or an authorization boundary. */
export function seal(prefix: string, value: unknown): string {
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, nonce);
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return prefix + Buffer.concat([nonce, data, cipher.getAuthTag()]).toString("base64url");
}
export function unseal(prefix: string, value: unknown): Record<string, any> {
  if (typeof value !== "string" || !value.startsWith(prefix) || value.length > 4 * 1024 * 1024)
    throw new Error("Invalid continuation capsule");
  const encoded = value.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("Invalid continuation capsule");
  const data = Buffer.from(encoded, "base64url");
  if (data.toString("base64url") !== encoded || data.length < 28)
    throw new Error("Invalid continuation capsule");
  const cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  cipher.setAuthTag(data.subarray(-16));
  const decoded: unknown = JSON.parse(
    Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]).toString(),
  );
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
    throw new Error("Invalid continuation capsule");
  return decoded;
}
export const reasoningPrefix = "aial-reasoning-v1:";
export const compactionPrefix = "cpa-ag-compact-v1:";
