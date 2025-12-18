const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');
const router = express.Router();

// GET /api/audits?page=1&limit=50&user_id=&from=&to=&path=
router.get('/', auth, async (req, res) => {
  // only admins
  if (req.user?.rol !== 'Administrador' && req.user?.rol !== 'admin')
    return res.status(403).json({ error: 'Acceso denegado' });

  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = (page - 1) * limit;

  const filters = [];
  const values = [];
  let idx = 1;

  if (req.query.user_id) {
    filters.push(`user_id = $${idx++}`);
    values.push(req.query.user_id);
  }
  if (req.query.path) {
    filters.push(`path ILIKE $${idx++}`);
    values.push(`%${req.query.path}%`);
  }
  if (req.query.method) {
    filters.push(`method = $${idx++}`);
    values.push(req.query.method);
  }
  if (req.query.from) {
    filters.push(`created_at >= $${idx++}`);
    values.push(req.query.from);
  }
  if (req.query.to) {
    filters.push(`created_at <= $${idx++}`);
    values.push(req.query.to);
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  try {
    const totalRes = await pool.query(`SELECT count(*) FROM audits ${where}`, values);
    const total = parseInt(totalRes.rows[0].count, 10);

    const q = `SELECT * FROM audits ${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
    const data = await pool.query(q, values);

    res.json({ page, limit, total, rows: data.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
