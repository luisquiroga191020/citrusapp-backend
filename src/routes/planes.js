const router = require('express').Router();
const pool = require('../db');
const auth = require('../middleware/auth');

// Listar Planes
router.get('/', auth, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM planes ORDER BY nombre ASC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Crear Plan
router.post('/', auth, async (req, res) => {
    const { nombre, comision_base } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO planes (nombre, comision_base) VALUES ($1, $2) RETURNING *',
            [nombre, comision_base]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Editar Plan
router.put('/:id', auth, async (req, res) => {
    const { id } = req.params;
    const { nombre, comision_base } = req.body;
    try {
        await pool.query(
            'UPDATE planes SET nombre = $1, comision_base = $2 WHERE id = $3',
            [nombre, comision_base, id]
        );
        res.json({ message: "Plan actualizado" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Borrar Plan
router.delete('/:id', auth, async (req, res) => {
    try {
        await pool.query('DELETE FROM planes WHERE id = $1', [req.params.id]);
        res.json({ message: "Plan eliminado" });
    } catch (err) {
        res.status(500).json({ error: "No se puede eliminar (tiene ventas asociadas)" });
    }
});

module.exports = router;