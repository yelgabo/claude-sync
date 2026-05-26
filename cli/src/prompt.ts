import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

export async function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try { return (await rl.question(question)).trim(); }
  finally { rl.close(); }
}

// Read a line from stdin without echoing it. For non-interactive use, prefer
// CLAUDE_SYNC_PASSWORD / CLAUDE_SYNC_PASSPHRASE env vars (resolved by callers).
export async function promptSecret(question: string): Promise<string> {
  if (!stdin.isTTY) {
    // In non-TTY contexts (CI, piped stdin), echo the question and read a line normally.
    return promptLine(question);
  }
  process.stdout.write(question);
  return new Promise((resolve, reject) => {
    const buf: string[] = [];
    const onData = (chunk: Buffer): void => {
      const s = chunk.toString('utf8');
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(buf.join(''));
          return;
        }
        if (ch === '') {  // Ctrl-C
          cleanup();
          process.stdout.write('\n');
          reject(new Error('aborted'));
          return;
        }
        if (ch === '' || ch === '\b') {
          if (buf.length > 0) buf.pop();
          continue;
        }
        buf.push(ch);
      }
    };
    const cleanup = (): void => {
      stdin.removeListener('data', onData);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
    };
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

export async function getPassword(): Promise<string> {
  const env = process.env['CLAUDE_SYNC_PASSWORD'];
  if (env) return env;
  return promptSecret('Password: ');
}

export async function getPassphrase(): Promise<string> {
  const env = process.env['CLAUDE_SYNC_PASSPHRASE'];
  if (env) return env;
  return promptSecret('Vault passphrase: ');
}