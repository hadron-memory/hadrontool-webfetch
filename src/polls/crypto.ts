/**
 * Credential-at-rest encryption for poll jobs (spec cor:web:030:02).
 *
 * AES-256-GCM under the tool-held TOKEN_ENCRYPTION_KEY (the ms-exchange /
 * gmail pattern). The key id — a digest fingerprint of the key, not a
 * secret — is stored alongside the ciphertext so a rotated key is detected
 * as "wrong key" instead of a garbled decrypt. Decryption happens ONLY in
 * the scheduler's tick path; ciphertext never appears on a read surface.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { AuthSpec } from '../fetcher.js';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

export interface CredentialCipher {
  keyId: string;
  encrypt(auth: AuthSpec): string;
  decrypt(ciphertext: string, keyId: string): AuthSpec;
}

/** Thrown when stored ciphertext can't be decrypted (rotation mismatch, corruption). */
export class CredentialDecryptError extends Error {
  constructor(reason: string) {
    // Never include ciphertext or key material — this message can reach logs.
    super(`stored poll credential cannot be decrypted: ${reason}`);
  }
}

/** Build a cipher from the 64-hex-char (32-byte) TOKEN_ENCRYPTION_KEY. */
export function createCredentialCipher(hexKey: string): CredentialCipher {
  if (!/^[0-9a-fA-F]{64}$/.test(hexKey)) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
  }
  const key = Buffer.from(hexKey, 'hex');
  const keyId = createHash('sha256').update(key).digest('hex').slice(0, 8);

  return {
    keyId,
    encrypt(auth) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGO, key, iv);
      const plaintext = Buffer.from(JSON.stringify(auth), 'utf8');
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':');
    },
    decrypt(ciphertext, storedKeyId) {
      if (storedKeyId !== keyId) {
        throw new CredentialDecryptError('key id mismatch (key rotated?)');
      }
      const parts = ciphertext.split(':');
      if (parts.length !== 3) throw new CredentialDecryptError('malformed ciphertext');
      try {
        const [iv, tag, data] = parts.map((p) => Buffer.from(p, 'base64'));
        const decipher = createDecipheriv(ALGO, key, iv);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
        return JSON.parse(plaintext.toString('utf8')) as AuthSpec;
      } catch {
        throw new CredentialDecryptError('authentication failed');
      }
    },
  };
}
