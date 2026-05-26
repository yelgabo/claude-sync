import { hostname } from 'node:os';
import { Api } from '../api.js';
import { loadConfig, saveConfig } from '../config.js';

export async function registerDevice(name?: string): Promise<void> {
  const config = await loadConfig();
  if (!config.session) throw new Error('not logged in; run `claude-sync login` first');
  const api = new Api(config);
  const deviceName = name ?? hostname();
  const { device } = await api.createDevice(deviceName);
  config.deviceId = device.id;
  await saveConfig(config);
  console.log(`Device registered: ${device.name} (id=${device.id}).`);
}