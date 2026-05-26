import { signup, login, logout, status } from './commands/auth.js';
import { registerDevice } from './commands/device.js';
import { vaultInit, vaultAdopt } from './commands/vault.js';
import { push } from './commands/push.js';
import { pull } from './commands/pull.js';
import { watch } from './commands/watch.js';

const USAGE = `claude-sync — sync your .claude folder

USAGE
  claude-sync <command> [args]

AUTH
  signup [email]       Create an account
  login  [email]       Log in
  logout               Log out (revokes server session)
  status               Print current config

DEVICE
  device [name]        Register this machine (defaults to hostname)

VAULT
  vault-init           Generate a new vault key (prompts for passphrase)
  vault-adopt          Adopt existing server-stored vault metadata (use on a new device)

SYNC
  push                 Upload all eligible files under ~/.claude
  pull                 Download changes since last cursor
  watch [seconds]      Poll loop: pull then push every N seconds (default 10)

ENV
  CLAUDE_SYNC_SERVER   Server URL (default: https://claude-sync-production.up.railway.app)
`;

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case 'signup': await signup(rest[0]); break;
    case 'login': await login(rest[0]); break;
    case 'logout': await logout(); break;
    case 'status': await status(); break;
    case 'device': await registerDevice(rest[0]); break;
    case 'vault-init': await vaultInit(); break;
    case 'vault-adopt': await vaultAdopt(); break;
    case 'push': await push(); break;
    case 'pull': await pull(); break;
    case 'watch': await watch(rest[0] ? Number(rest[0]) : 10); break;
    case 'help': case '--help': case '-h': case undefined: process.stdout.write(USAGE); break;
    default:
      process.stderr.write(`unknown command: ${cmd}\n${USAGE}`);
      process.exit(2);
  }
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
});