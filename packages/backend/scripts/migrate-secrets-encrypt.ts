/**
 * One-time migration script: encrypt existing plaintext agent_secrets values.
 *
 * Run with:
 *   pnpm --filter @agentspawner/backend tsx scripts/migrate-secrets-encrypt.ts
 *
 * The script is idempotent — it skips any row whose value is already a valid
 * AES-256-GCM ciphertext (hex string of the correct minimum length).
 * Run it once after deploying the encryption changes, before starting the server.
 *
 * Minimum encrypted length: IV(12) + TAG(16) + at least 1 byte ciphertext = 29 bytes = 58 hex chars.
 */

import Database from 'better-sqlite3';
import { resolve } from 'path';
import { config as loadEnv } from 'dotenv';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

loadEnv({ path: resolve(process.cwd(), '.env') });

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
// Minimum hex length for a valid ciphertext (iv + tag + 1 byte payload)
const MIN_ENCRYPTED_HEX_LEN = (IV_LENGTH + TAG_LENGTH + 1) * 2;

function getKey(): Buffer {
  const secret = process.env.ENCRYPTION_SECRET ?? '';
  if (!secret || secret.length !== 64) {
    console.error('ERROR: ENCRYPTION_SECRET must be a 64-char hex string.');
    process.exit(1);
  }
  return Buffer.from(secret, 'hex');
}

function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('hex');
}

function looksEncrypted(value: string): boolean {
  // Must be a hex string of at least MIN_ENCRYPTED_HEX_LEN characters
  if (value.length < MIN_ENCRYPTED_HEX_LEN) return false;
  return /^[0-9a-f]+$/i.test(value);
}

function tryDecrypt(value: string, key: Buffer): boolean {
  // Attempt decryption to verify it's actually encrypted (not just a coincidentally hex-looking secret)
  try {
    const data = Buffer.from(value, 'hex');
    const iv = data.subarray(0, IV_LENGTH);
    const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return true;
  } catch {
    return false;
  }
}

const dbPath = resolve(process.env.DB_PATH ?? './data/agentspawner.db');
console.log(`Opening database: ${dbPath}`);

const db = new Database(dbPath);
const key = getKey();

const rows = db.prepare('SELECT id, key, value FROM agent_secrets').all() as {
  id: string;
  key: string;
  value: string;
}[];

console.log(`Found ${rows.length} secret rows to inspect.`);

let migrated = 0;
let skipped = 0;

const update = db.prepare('UPDATE agent_secrets SET value = ? WHERE id = ?');

for (const row of rows) {
  if (looksEncrypted(row.value) && tryDecrypt(row.value, key)) {
    console.log(`  SKIP  ${row.key} (already encrypted)`);
    skipped++;
    continue;
  }

  const encryptedValue = encrypt(row.value);
  update.run(encryptedValue, row.id);
  console.log(`  MIGRATED  ${row.key}`);
  migrated++;
}

db.close();

console.log(`\nDone. Migrated: ${migrated}, Already encrypted (skipped): ${skipped}.`);
