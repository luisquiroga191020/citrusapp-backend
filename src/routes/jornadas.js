const router = require('express').Router();
const pool = require('../db');
const auth = require('../middleware/auth');

// 1. Listar Jornadas (Con filtros básicos)
router.get('/', auth, async (req, res) => {
    try {
        // Traemos datos del promotor y calculamos totales al vuelo
        const query = `
            SELECT j.*, p.foto_url, u.nombre_completo as nombre_promotor,
            (SELECT COUNT(*) FROM ventas v WHERE v.jornada_id = j.id) as total_fichas,
            (SELECT COALESCE(SUM(monto), 0) FROM ventas v WHERE v.jornada_id = j.id) as total_ventas
            FROM jornadas j
            JOIN promotores_info p ON j.promotor_id = p.id
            JOIN usuarios u ON p.usuario_id = u.id
            ORDER BY j.fecha DESC, j.created_at DESC
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Crear Nueva Jornada
router.post('/', auth, async (req, res) => {
    const { promotor_id, fecha, tipo_jornada } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO jornadas (promotor_id, fecha, tipo_jornada, check_in) VALUES ($1, $2, $3, NOW()) RETURNING *',
            [promotor_id, fecha, tipo_jornada]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Obtener Detalle de una Jornada (Y sus ventas)
router.get('/:id', auth, async (req, res) => {
    const { id } = req.params;
    try {
        // Datos de la jornada
        const jornadaQuery = `
            SELECT j.*, u.nombre_completo, z.nombre as zona_nombre
            FROM jornadas j
            JOIN promotores_info p ON j.promotor_id = p.id
            JOIN usuarios u ON p.usuario_id = u.id
            JOIN zonas z ON p.zona_id = z.id
            WHERE j.id = $1
        `;
        const jornada = await pool.query(jornadaQuery, [id]);

        if (jornada.rows.length === 0) return res.status(404).json({ error: "Jornada no encontrada" });

        // Ventas asociadas
        const ventasQuery = `
            SELECT v.*, p.nombre as plan_nombre
            FROM ventas v
            LEFT JOIN planes p ON v.plan_id = p.id
            WHERE v.jornada_id = $1
            ORDER BY v.created_at DESC
        `;
        const ventas = await pool.query(ventasQuery, [id]);

        res.json({ jornada: jornada.rows[0], ventas: ventas.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. Agregar Venta a una Jornada
router.post('/:id/ventas', auth, async (req, res) => {
    const { id } = req.params; // ID de la jornada
    const { plan_id, cliente_nombre, monto, metodo_pago, codigo_ficha } = req.body;
    
    try {
        const result = await pool.query(
            `INSERT INTO ventas (jornada_id, plan_id, cliente_nombre, monto, metodo_pago, codigo_ficha) 
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [id, plan_id, cliente_nombre, monto, metodo_pago, codigo_ficha]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. Eliminar Venta
router.delete('/ventas/:id', auth, async (req, res) => {
    try {
        await pool.query('DELETE FROM ventas WHERE id = $1', [req.params.id]);
        res.json({ message: "Venta eliminada" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;