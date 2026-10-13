import { mkdirSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';
import { v4 as uuidv4 } from 'uuid';

// Resolve relative to process.cwd() — matches how dbPath is resolved in config.ts
export const SCREENSHOTS_DIR = resolve('./data/screenshots');

/** Create the screenshots directory if it doesn't exist (idempotent). */
export function ensureScreenshotDir(): void {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

/**
 * Extract base64 from a data URL, save the PNG to disk, and return the URL path.
 * Input may be a full data URL ("data:image/png;base64,...") or raw base64.
 * Creates the screenshots directory on first call (lazy).
 */
export function saveScreenshotToDisk(dataUrlOrBase64: string): string {
  ensureScreenshotDir();
  const base64 = dataUrlOrBase64.replace(/^data:image\/[^;]+;base64,/, '');
  const filename = `${uuidv4()}.png`;
  const filepath = join(SCREENSHOTS_DIR, filename);
  writeFileSync(filepath, Buffer.from(base64, 'base64'));
  return `/screenshots/${filename}`;
}
