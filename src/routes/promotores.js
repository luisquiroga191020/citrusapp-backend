const router = require('express').Router();
const pool = require('../db');
const auth = require('../middleware/auth');

// Listar Promotores (con datos de Usuario y Zona)
router.get('/', auth, async (req, res) => {
    try {
        const query = `
            SELECT p.id, p.objetivo_mensual, p.foto_url,
                   u.nombre_completo, u.email,
                   z.nombre as nombre_zona, z.id as zona_id
            FROM promotores_info p
            JOIN usuarios u ON p.usuario_id = u.id
            LEFT JOIN zonas z ON p.zona_id = z.id
            ORDER BY u.nombre_completo ASC
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Crear Promotor (Requiere que el Usuario ya exista, simplificado por ahora)
router.post('/', auth, async (req, res) => {
    const { usuario_id, zona_id, objetivo_mensual } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO promotores_info (usuario_id, zona_id, objetivo_mensual) VALUES ($1, $2, $3) RETURNING *',
            [usuario_id, zona_id, objetivo_mensual]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Editar Promotor
router.put('/:id', auth, async (req, res) => {
    const { id } = req.params;
    const { zona_id, objetivo_mensual } = req.body;
    try {
        await pool.query(
            'UPDATE promotores_info SET zona_id = $1, objetivo_mensual = $2 WHERE id = $3',
            [zona_id, objetivo_mensual, id]
        );
        res.json({ message: "Actualizado" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Necesitamos un endpoint para listar usuarios que NO son promotores aún (para el select)
router.get('/disponibles', auth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, nombre_completo FROM usuarios 
            WHERE rol = 'promotor' 
            AND id NOT IN (SELECT usuario_id FROM promotores_info)
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;