import pino from 'pino';
import type { LoggerOptions } from 'pino';

export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-nonce"]',
  'req.headers["x-path"]',
  'req.headers["x-key-id"]',
  'res.headers["set-cookie"]',
  'res.headers["x-nonce"]',
  'res.headers["x-path"]',
  'ciphertext', 'ciphertext_b64',
  'nonce', 'nonce_b64',
  'kdf_salt', 'kdf_salt_b64',
  '*.ciphertext', '*.ciphertext_b64',
  '*.nonce', '*.nonce_b64',
  '*.kdf_salt', '*.kdf_salt_b64',
];

export function loggerOptions(): LoggerOptions {
  return {
    level: process.env['LOG_LEVEL'] ?? 'info',
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  };
}

export function createLogger(): pino.Logger {
  return pino(loggerOptions());
}
