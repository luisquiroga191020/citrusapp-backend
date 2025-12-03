const router = require('express').Router();
const pool = require('../db');
const auth = require('../middleware/auth');

router.get('/', auth, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM planes ORDER BY nombre ASC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/', auth, async (req, res) => {
    // Ahora recibimos servicio y tipo
    const { nombre, servicio, tipo } = req.body; 
    try {
        const result = await pool.query(
            'INSERT INTO planes (nombre, servicio, tipo) VALUES ($1, $2, $3) RETURNING *',
            [nombre, servicio, tipo]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/:id', auth, async (req, res) => {
    const { id } = req.params;
    const { nombre, servicio, tipo } = req.body;
    try {
        await pool.query(
            'UPDATE planes SET nombre = $1, servicio = $2, tipo = $3 WHERE id = $4',
            [nombre, servicio, tipo, id]
        );
        res.json({ message: "Plan actualizado" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/:id', auth, async (req, res) => {
    try {
        await pool.query('DELETE FROM planes WHERE id = $1', [req.params.id]);
        res.json({ message: "Plan eliminado" });
    } catch (err) {
        res.status(500).json({ error: "No se puede eliminar (tiene ventas asociadas)" });
    }
});

module.exports = router;