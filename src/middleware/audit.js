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
      // Tabla y extensiones asumidas creadas manualmente por el administrador.
      // No intentamos crear extensiones o tablas desde la app para evitar
      // problemas de permisos en entornos gestionados (Neon).

      const ua = req.get('User-Agent') || null;
      const device = detectDeviceType(ua);

      // Normalize IP: prefer X-Forwarded-For (comma list), fall back to req.ip or remoteAddress
      let ip = null;
      try {
        const xff = req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For'] || null;
        if (xff && typeof xff === 'string' && xff.length) {
          ip = xff.split(',')[0].trim();
        }
      } catch (e) {
        ip = null;
      }
      if (!ip) ip = req.ip || req.connection?.remoteAddress || null;
      // If IPv6-mapped IPv4 (e.g. ::ffff:127.0.0.1) convert to IPv4
      if (ip && ip.startsWith('::ffff:')) ip = ip.replace('::ffff:', '');

      // don't log request body blindly — include limited details
      const details = {
        query: req.query || {},
        params: req.params || {},
      };

      // capture view name if frontend sends it
      try {
        const viewName = req.get('X-View-Name') || req.get('x-view-name') || null;
        if (viewName) details.view = viewName;
      } catch (e) {
        // ignore
      }

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
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      `;

      const values = [
        user?.id || null,
        user?.nombre || null,
        user?.rol || null,
        req.method,
        req.originalUrl || req.url,
        res.statusCode,
        ip,
        ua,
        device,
        details,
      ];

      // fire and forget (log any insert error)
      pool.query(insertText, values).catch((e) => console.error('Audit insert error', e.message, e.stack));
    } catch (err) {
      console.error('Audit middleware error', err.message, err.stack);
    }
  });

  next();
};
