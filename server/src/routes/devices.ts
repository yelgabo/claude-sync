import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '../db/client.js';
import { bindSessionDevice, makeSessionMiddleware } from '../auth/session.js';
import { ApiError } from '../lib/errors.js';

const DeviceCreate = z.object({ name: z.string().min(1).max(64) });

export function registerDevices(app: FastifyInstance, db: DbClient): void {
  const session = makeSessionMiddleware(db);

  app.post('/api/devices', { preHandler: session }, async (req) => {
    const parsed = DeviceCreate.safeParse(req.body);
    if (!parsed.success) throw new ApiError('invalid_request', 'name required (1-64 chars)');

    const id = uuidv4();
    await db.query(
      `INSERT INTO devices (id, user_id, name) VALUES ($1, $2, $3)`,
      [id, req.user!.id, parsed.data.name],
    );
    await bindSessionDevice(db, req.session!.id, id);
    req.session!.device_id = id;
    return { device: { id, name: parsed.data.name } };
  });

  app.get('/api/devices', { preHandler: session }, async (req) => {
    const r = await db.query<{ id: string; name: string; created_at: Date; last_seen_at: Date | null }>(
      `SELECT id, name, created_at, last_seen_at FROM devices WHERE user_id = $1 ORDER BY created_at`,
      [req.user!.id],
    );
    return { devices: r.rows };
  });

  app.patch<{ Params: { id: string }; Body: { name: string } }>(
    '/api/devices/:id', { preHandler: session },
    async (req) => {
      const parsed = DeviceCreate.safeParse(req.body);
      if (!parsed.success) throw new ApiError('invalid_request', 'name required (1-64 chars)');
      const r = await db.query<{ id: string }>(
        `UPDATE devices SET name = $1 WHERE id = $2 AND user_id = $3 RETURNING id`,
        [parsed.data.name, req.params.id, req.user!.id],
      );
      if (r.rows.length === 0) throw new ApiError('not_found', 'device not found');
      return { device: { id: req.params.id, name: parsed.data.name } };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/devices/:id', { preHandler: session },
    async (req) => {
      const r = await db.query<{ id: string }>(
        `DELETE FROM devices WHERE id = $1 AND user_id = $2 RETURNING id`,
        [req.params.id, req.user!.id],
      );
      if (r.rows.length === 0) throw new ApiError('not_found', 'device not found');
      // Revoke any active sessions bound to this device (best-effort).
      await db.query(
        `UPDATE sessions SET revoked_at = now() WHERE device_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [req.params.id, req.user!.id],
      );
      return { ok: true };
    },
  );

  app.get('/api/me', { preHandler: session }, async (req) => {
    const userRow = await db.query<{ id: string; email: string | null; storage_bytes: string | number }>(
      `SELECT id, email, storage_bytes FROM users WHERE id = $1`,
      [req.user!.id],
    );
    const devices = await db.query<{ id: string; name: string; created_at: Date; last_seen_at: Date | null }>(
      `SELECT id, name, created_at, last_seen_at FROM devices WHERE user_id = $1 ORDER BY created_at`,
      [req.user!.id],
    );
    const current = devices.rows.find((d) => d.id === req.session!.device_id) ?? null;
    return { user: userRow.rows[0], current_device: current, devices: devices.rows };
  });
}
