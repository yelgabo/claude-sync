import type { Config } from './config.js';

const REQUESTED_WITH = 'claude-sync';

interface ApiOpts {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: string | Buffer | undefined;
  headers?: Record<string, string>;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(`${status} ${code}: ${message}`);
  }
}

export class Api {
  constructor(private config: Config) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      'x-requested-with': REQUESTED_WITH,
      ...extra,
    };
    if (this.config.session) h['cookie'] = `__Host-session=${this.config.session}`;
    return h;
  }

  private url(path: string): string {
    return `${this.config.serverUrl}${path}`;
  }

  private async req(path: string, opts: ApiOpts = {}): Promise<Response> {
    const method = opts.method ?? 'GET';
    const headers = this.headers(opts.headers ?? {});
    const res = await fetch(this.url(path), {
      method, headers,
      body: opts.body as unknown as undefined,
    });
    return res;
  }

  async signup(email: string, password: string): Promise<{ user: { id: string; email: string }; sessionCookie: string }> {
    const res = await this.req('/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    return this.completeAuth(res);
  }

  async login(email: string, password: string): Promise<{ user: { id: string; email: string }; sessionCookie: string }> {
    const res = await this.req('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    return this.completeAuth(res);
  }

  private async completeAuth(res: Response): Promise<{ user: { id: string; email: string }; sessionCookie: string }> {
    const text = await res.text();
    if (!res.ok) {
      const err = safeJson(text);
      throw new ApiError(res.status, err?.error?.code ?? 'unknown', err?.error?.message ?? text);
    }
    const json = JSON.parse(text) as { user: { id: string; email: string } };
    const setCookie = res.headers.get('set-cookie') ?? '';
    const m = /__Host-session=([^;]+)/.exec(setCookie);
    if (!m) throw new Error('server did not return a session cookie');
    return { user: json.user, sessionCookie: m[1]! };
  }

  async logout(): Promise<void> {
    await this.req('/auth/logout', { method: 'POST' });
  }

  async me(): Promise<{ user: { id: string; email: string }; current_device: { id: string; name: string } | null; devices: { id: string; name: string }[] }> {
    return this.json(await this.req('/api/me'));
  }

  async createDevice(name: string): Promise<{ device: { id: string; name: string } }> {
    return this.json(await this.req('/api/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }));
  }

  async getVaultMeta(): Promise<{ kdf_algo: 'argon2id'; kdf_salt_b64: string; key_id: string } | null> {
    const res = await this.req('/api/vault/key-metadata');
    if (res.status === 404) return null;
    return this.json(res);
  }

  async putVaultMeta(meta: { kdf_algo: 'argon2id'; kdf_salt_b64: string; key_id: string }): Promise<void> {
    const res = await this.req('/api/vault/key-metadata', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(meta),
    });
    await this.expectOk(res);
  }

  async putFileVersion(
    fileId: string, versionId: string,
    ciphertext: Buffer, nonceB64: string, keyId: string, path?: string,
  ): Promise<{ seq: number; uploaded_at: string }> {
    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream',
      'x-nonce': nonceB64,
      'x-key-id': keyId,
    };
    if (path) headers['x-path'] = path;
    const res = await this.req(`/api/files/${fileId}/versions/${versionId}`, {
      method: 'PUT', headers, body: ciphertext,
    });
    return this.json(res);
  }

  async getLatest(fileId: string): Promise<{ ciphertext: Buffer; nonceB64: string; keyId: string; versionId: string; seq: number } | { gone: true; latestVersionId: string }> {
    const res = await this.req(`/api/files/${fileId}`);
    if (res.status === 410) {
      return { gone: true, latestVersionId: res.headers.get('x-latest-version-id') ?? '' };
    }
    if (!res.ok) {
      const err = safeJson(await res.text());
      throw new ApiError(res.status, err?.error?.code ?? 'unknown', err?.error?.message ?? '');
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      ciphertext: buf,
      nonceB64: res.headers.get('x-nonce') ?? '',
      keyId: res.headers.get('x-key-id') ?? '',
      versionId: res.headers.get('x-version-id') ?? '',
      seq: Number(res.headers.get('x-seq') ?? '0'),
    };
  }

  async sync(since: number, limit = 200): Promise<{ changes: SyncChange[]; next_seq: number; has_more: boolean }> {
    return this.json(await this.req(`/api/sync?since=${since}&limit=${limit}`));
  }

  private async json<T>(res: Response): Promise<T> {
    const text = await res.text();
    if (!res.ok) {
      const err = safeJson(text);
      throw new ApiError(res.status, err?.error?.code ?? 'unknown', err?.error?.message ?? text);
    }
    return JSON.parse(text) as T;
  }

  private async expectOk(res: Response): Promise<void> {
    if (res.ok) return;
    const err = safeJson(await res.text());
    throw new ApiError(res.status, err?.error?.code ?? 'unknown', err?.error?.message ?? '');
  }
}

export interface SyncChange {
  file_id: string;
  version_id: string;
  seq: number;
  size_bytes: number;
  deleted: boolean;
  path?: string | null;
}

function safeJson(text: string): { error?: { code?: string; message?: string } } | null {
  try { return JSON.parse(text); } catch { return null; }
}