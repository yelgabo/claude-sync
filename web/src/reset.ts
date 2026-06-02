// Password reset page. Two modes:
//  - no ?token=  -> request a reset link
//  - ?token=...  -> set a new password using that token

const REQUESTED_WITH = 'claude-sync';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

function show(el: HTMLElement | null, on: boolean): void { if (el) el.hidden = !on; }

async function postJson(path: string, body: unknown): Promise<{ ok: boolean; status: number; json: { error?: { message?: string } } & Record<string, unknown> }> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'x-requested-with': REQUESTED_WITH, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include',
  });
  let json: Record<string, unknown> = {};
  try { json = await res.json(); } catch { /* ignore */ }
  return { ok: res.ok, status: res.status, json };
}

const token = new URLSearchParams(location.search).get('token');

if (token) {
  show($('confirm-card'), true);
  $('confirm-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('confirm-err').textContent = '';
    const p1 = ($('new-password') as HTMLInputElement).value;
    const p2 = ($('new-password2') as HTMLInputElement).value;
    if (p1 !== p2) { $('confirm-err').textContent = 'Passwords do not match.'; return; }
    if (p1.length < 12) { $('confirm-err').textContent = 'Password must be at least 12 characters.'; return; }
    const r = await postJson('/auth/reset/confirm', { token, password: p1 });
    if (r.ok) {
      ($('confirm-form') as HTMLFormElement).reset();
      show($('confirm-ok'), true);
      $('confirm-err').textContent = '';
    } else {
      $('confirm-err').textContent = r.json.error?.message ?? 'Could not reset password. The link may have expired — request a new one.';
    }
  });
} else {
  show($('request-card'), true);
  $('request-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('req-err').textContent = '';
    show($('req-ok'), false);
    const email = ($('req-email') as HTMLInputElement).value;
    const r = await postJson('/auth/reset/request', { email });
    if (r.ok) {
      const ok = $('req-ok');
      ok.textContent = 'If that email has an account, a reset link is on its way.';
      show(ok, true);
    } else {
      $('req-err').textContent = r.json.error?.message ?? 'Something went wrong. Try again.';
    }
  });
}
