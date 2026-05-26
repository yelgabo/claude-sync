// Public library exports for embedders (e.g., the Electron desktop app).
// The CLI itself uses these via internal paths; consumers should use this entry.

export { loadConfig, saveConfig, loadManifest, saveManifest, CONFIG_DIR, type Config, type Manifest, type ManifestEntry } from './config.js';
export { Api, ApiError, type SyncChange } from './api.js';
export { deriveVaultKey, aeadEncrypt, aeadDecrypt, blake2b, newSalt16, buildAad, AAD_VERSION } from './crypto.js';
export { push } from './commands/push.js';
export { pull } from './commands/pull.js';