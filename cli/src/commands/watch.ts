import { push } from './push.js';
import { pull } from './pull.js';
import { getPassphrase } from '../prompt.js';

const MAX_BACKOFF_MS = 5 * 60 * 1000;

export async function watch(intervalSec = 10): Promise<void> {
  const passphrase = await getPassphrase();
  console.log(`Watching... will push + pull every ${intervalSec}s. Ctrl-C to stop.`);
  let consecutiveFailures = 0;
  while (true) {
    const t0 = Date.now();
    let ok = true;
    // Pull and push are independently caught: a permanent failure in one direction
    // (e.g. one undecryptable remote version) must not block the other forever.
    try {
      await pull({ passphrase });
    } catch (e) {
      ok = false;
      console.error(`pull error: ${(e as Error).message}`);
    }
    try {
      await push({ passphrase });
    } catch (e) {
      ok = false;
      console.error(`push error: ${(e as Error).message}`);
    }
    if (ok) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures += 1;
    }
    const elapsed = Date.now() - t0;
    // Exponential backoff on sustained failure so we don't hammer the rate limit or
    // burn CPU when something is permanently broken (revoked session, wrong vault key).
    const base = intervalSec * 1000;
    const backoff = consecutiveFailures > 0
      ? Math.min(MAX_BACKOFF_MS, base * 2 ** Math.min(consecutiveFailures - 1, 8))
      : base;
    const wait = Math.max(0, backoff - elapsed);
    if (consecutiveFailures > 0) {
      console.error(`backing off ${Math.round(wait / 1000)}s (consecutive failures: ${consecutiveFailures})`);
    }
    await new Promise((r) => setTimeout(r, wait));
  }
}
