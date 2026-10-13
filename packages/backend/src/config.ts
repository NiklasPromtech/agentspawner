import { config as loadEnv } from 'dotenv';
import { resolve } from 'path';
import { logger } from './lib/logger.js';

loadEnv({ path: resolve(process.cwd(), '.env') });

export interface Config {
  port: number;
  dbPath: string;
  encryptionSecret: string;
  telegramBotToken: string;
  telegramChatId: string;
}

let _config: Config | null = null;

export function getConfig(): Config {
  if (_config) return _config;

  const encryptionSecret = process.env.ENCRYPTION_SECRET ?? '';
  if (!encryptionSecret || encryptionSecret.length !== 64) {
    logger.warn('ENCRYPTION_SECRET must be a 64-char hex string. Using insecure fallback for development.');
  }

  _config = {
    port: parseInt(process.env.PORT ?? '3001', 10),
    dbPath: resolve(process.env.DB_PATH ?? './data/agentspawner.db'),
    encryptionSecret: encryptionSecret || '0'.repeat(64),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID ?? '',
  };

  return _config;
}
