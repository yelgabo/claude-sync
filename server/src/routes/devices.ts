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
