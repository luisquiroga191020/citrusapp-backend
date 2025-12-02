const router = require('express').Router();
const pool = require('../db');
const auth = require('../middleware/auth');

// Listar todas las zonas
router.get('/', auth, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM zonas ORDER BY nombre ASC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Crear zona
router.post('/', auth, async (req, res) => {
    const { nombre, color } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO zonas (nombre, color_identificador) VALUES ($1, $2) RETURNING *',
            [nombre, color]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Actualizar zona
router.put('/:id', auth, async (req, res) => {
    const { id } = req.params;
    const { nombre, color } = req.body;
    try {
        await pool.query(
            'UPDATE zonas SET nombre = $1, color_identificador = $2 WHERE id = $3',
            [nombre, color, id]
        );
        res.json({ message: "Actualizado" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Borrar zona
router.delete('/:id', auth, async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM zonas WHERE id = $1', [id]);
        res.json({ message: "Eliminado" });
    } catch (err) {
        res.status(500).json({ error: "No se puede eliminar: Probablemente tenga datos asociados." });
    }
});

module.exports = router;