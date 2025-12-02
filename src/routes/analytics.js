const router = require('express').Router();
const pool = require('../db');
const auth = require('../middleware/auth');

// 1. Ranking de Promotores (Mes Actual)
// Calcula: Venta Real, Objetivo, Avance % y Delta $
router.get('/ranking', auth, async (req, res) => {
    try {
        const query = `
            SELECT 
                u.nombre_completo,
                p.foto_url,
                COALESCE(p.objetivo_mensual, 0) as objetivo,
                COALESCE(SUM(v.monto), 0) as venta_real,
                (COALESCE(SUM(v.monto), 0) - COALESCE(p.objetivo_mensual, 0)) as delta,
                CASE 
                    WHEN p.objetivo_mensual > 0 THEN (COALESCE(SUM(v.monto), 0) / p.objetivo_mensual) * 100
                    ELSE 0 
                END as avance_porcentaje
            FROM promotores_info p
            JOIN usuarios u ON p.usuario_id = u.id
            LEFT JOIN jornadas j ON j.promotor_id = p.id
            LEFT JOIN ventas v ON v.jornada_id = j.id 
                AND v.created_at >= date_trunc('month', CURRENT_DATE) -- Solo mes actual
            GROUP BY p.id, u.nombre_completo, p.foto_url, p.objetivo_mensual
            ORDER BY venta_real DESC
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Ventas de los últimos 7 días (Para gráfico de líneas)
router.get('/semanal', auth, async (req, res) => {
    try {
        const query = `
            SELECT 
                TO_CHAR(date_trunc('day', v.created_at), 'DD/MM') as dia,
                SUM(v.monto) as total
            FROM ventas v
            WHERE v.created_at >= NOW() - INTERVAL '7 days'
            GROUP BY 1
            ORDER BY 1 ASC
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Distribución por Plan (Para gráfico de torta)
router.get('/planes', auth, async (req, res) => {
    try {
        const query = `
            SELECT p.nombre, COUNT(v.id) as cantidad
            FROM ventas v
            JOIN planes p ON v.plan_id = p.id
            WHERE v.created_at >= date_trunc('month', CURRENT_DATE)
            GROUP BY p.nombre
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;