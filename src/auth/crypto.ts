import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../config.js";

const KEY = Buffer.from(config.tokenEncryptionKey, "hex");
const ALGO = "aes-256-gcm";
const IV_LEN = 12; // recommended for GCM

/**
 * Encrypt a string with AES-256-GCM.
 * Output format: base64( iv || authTag || ciphertext )
 *
 * IV is per-call random; authTag verifies integrity. A leaked Mongo
 * dump without TOKEN_ENCRYPTION_KEY is useless.
 */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, KEY, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

export function decrypt(payload: string): string {
  const buf = Buffer.from(payload, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const authTag = buf.subarray(IV_LEN, IV_LEN + 16);
  const ciphertext = buf.subarray(IV_LEN + 16);
  const decipher = createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}
