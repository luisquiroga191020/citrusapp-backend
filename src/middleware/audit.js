const pool = require('../db');
const jwt = require('jsonwebtoken');

// Simple device type detection from user-agent
function detectDeviceType(ua) {
  if (!ua) return 'unknown';
  const uaLower = ua.toLowerCase();
  if (/mobile|iphone|android|ipad|ipod|phone/.test(uaLower)) return 'mobile';
  if (/tablet|ipad/.test(uaLower)) return 'tablet';
  return 'desktop';
}

module.exports = async (req, res, next) => {
  const start = Date.now();

  // try to extract user from Bearer token if present
  let user = null;
  try {
    const header = req.header('Authorization');
    if (header) {
      const token = header.replace('Bearer ', '');
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      user = decoded; // may contain id, rol, etc.
    }
  } catch (e) {
    // ignore invalid token for logging purposes
  }

  // After response finishes, insert audit record (non-blocking)
  res.on('finish', async () => {
    try {
      // create table if not exists (idempotent)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS audits (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          created_at timestamptz DEFAULT now(),
          user_id uuid NULL,
          username text NULL,
          rol text NULL,
          method text,
          path text,
          status int,
          ip text,
          user_agent text,
          device_type text,
          details jsonb
        );
      `);

      const ua = req.get('User-Agent') || null;
      const device = detectDeviceType(ua);

      // don't log request body blindly — include limited details
      const details = {
        query: req.query || {},
        params: req.params || {},
      };

      // include body for non-sensitive endpoints
      if (req.body && Object.keys(req.body).length) {
        // avoid logging common sensitive fields
        const bodyCopy = { ...req.body };
        if (bodyCopy.password) bodyCopy.password = '[REDACTED]';
        if (bodyCopy.password_hash) delete bodyCopy.password_hash;
        details.body = bodyCopy;
      }

      const insertText = `
        INSERT INTO audits (user_id, username, rol, method, path, status, ip, user_agent, device_type, details)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `;

      const values = [
        user?.id || null,
        user?.nombre || null,
        user?.rol || null,
        req.method,
        req.originalUrl || req.url,
        res.statusCode,
        req.ip || req.connection?.remoteAddress || null,
        ua,
        device,
        details,
      ];

      // fire and forget
      pool.query(insertText, values).catch((e) => console.error('Audit insert error', e.message));
    } catch (err) {
      console.error('Audit middleware error', err.message);
    }
  });

  next();
};
