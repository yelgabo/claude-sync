// Browser-side API client. The session cookie is __Host-session, set/cleared by the server
// via Set-Cookie on /auth/login. Since we serve the web app from the same origin as the API
// (Railway), the cookie is automatically sent with fetch() requests under default credentials.

const REQUESTED_WITH = 'claude-sync';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(`${status} ${code}: ${message}`);
  }
}

type Headers = Record<string, string>;
async function req(path: string, opts: { method?: string; headers?: Headers; body?: string } = {}): Promise<Response> {
  return fetch(path, {
    method: opts.method ?? 'GET',
    headers: { 'x-requested-with': REQUESTED_WITH, ...(opts.headers ?? {}) },
    body: opts.body,
    credentials: 'include',
  });
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    let code = 'unknown', msg = text;
    try { const j = JSON.parse(text); code = j.error?.code ?? code; msg = j.error?.message ?? msg; } catch {}
    throw new ApiError(res.status, code, msg);
  }
  return JSON.parse(text) as T;
}

export async function login(email: string, password: string): Promise<{ user: { id: string; email: string } }> {
  const res = await req('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return jsonOrThrow(res);
}

export async function logout(): Promise<void> {
  await req('/auth/logout', { method: 'POST' });
}

export async function me(): Promise<{ user: { id: string; email: string }; devices: Array<{ id: string; name: string; created_at: string; last_seen_at: string | null }> }> {
  return jsonOrThrow(await req('/api/me'));
}

export interface FileEntry {
  file_id: string;
  path: string | null;
  latest_version_id: string;
  latest_seq: number;
  updated_at: string;
  size_bytes: number;
  deleted: boolean;
}

export async function listFiles(): Promise<{ files: FileEntry[] }> {
  return jsonOrThrow(await req('/api/files'));
}

export interface VersionEntry {
  id: string;
  seq: number;
  uploaded_at: string;
  size_bytes: number;
  deleted: boolean;
  uploaded_by_device: string | null;
}

export async function listVersions(fileId: string): Promise<{ versions: VersionEntry[] }> {
  return jsonOrThrow(await req(`/api/files/${fileId}/versions`));
}

export async function fetchVersion(fileId: string, versionId: string): Promise<{
  content: Uint8Array;
}> {
  const res = await req(`/api/files/${fileId}/versions/${versionId}`);
  if (!res.ok) throw new ApiError(res.status, 'fetch_failed', await res.text());
  const buf = new Uint8Array(await res.arrayBuffer());
  return { content: buf };
}

export async function listDevices(): Promise<{ devices: Array<{ id: string; name: string; created_at: string; last_seen_at: string | null }> }> {
  return jsonOrThrow(await req('/api/devices'));
}

export async function sync(since = 0, limit = 200): Promise<{ changes: Array<{ file_id: string; version_id: string; seq: number; size_bytes: number; deleted: boolean; path: string | null }>; next_seq: number; has_more: boolean }> {
  return jsonOrThrow(await req(`/api/sync?since=${since}&limit=${limit}`));
}