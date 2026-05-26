import { push } from './push.js';
import { pull } from './pull.js';
import { getPassphrase } from '../prompt.js';

export async function watch(intervalSec = 10): Promise<void> {
  const passphrase = await getPassphrase();
  console.log(`Watching... will push + pull every ${intervalSec}s. Ctrl-C to stop.`);
  // Initial sync
  while (true) {
    const t0 = Date.now();
    try {
      await pull({ passphrase });
      await push({ passphrase });
    } catch (e) {
      console.error(`tick error: ${(e as Error).message}`);
    }
    const elapsed = Date.now() - t0;
    const wait = Math.max(0, intervalSec * 1000 - elapsed);
    await new Promise((r) => setTimeout(r, wait));
  }
}