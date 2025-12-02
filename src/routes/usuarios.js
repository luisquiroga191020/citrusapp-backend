const router = require('express').Router();
const pool = require('../db');
const bcrypt = require('bcryptjs'); // Necesario para la contraseña
const auth = require('../middleware/auth');

// 1. Listar Usuarios
router.get('/', auth, async (req, res) => {
    try {
        // No devolvemos el password_hash por seguridad
        const result = await pool.query('SELECT id, email, nombre_completo, rol, activo, created_at FROM usuarios ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Crear Usuario (Desde el panel de admin)
router.post('/', auth, async (req, res) => {
    const { email, password, nombre_completo, rol } = req.body;
    
    try {
        // Encriptar password
        const hash = await bcrypt.hash(password, 10);
        
        const result = await pool.query(
            "INSERT INTO usuarios (email, password_hash, nombre_completo, rol) VALUES ($1, $2, $3, $4) RETURNING id, email, nombre_completo, rol",
            [email, hash, nombre_completo, rol]
        );
        res.json(result.rows[0]);
    } catch (err) {
        // Error típico: Email duplicado (código 23505 en Postgres)
        if (err.code === '23505') {
            return res.status(400).json({ error: "El email ya está registrado" });
        }
        res.status(500).json({ error: err.message });
    }
});

// 3. Editar Usuario (Sin cambiar password)
router.put('/:id', auth, async (req, res) => {
    const { id } = req.params;
    const { email, nombre_completo, rol, activo } = req.body;
    
    try {
        await pool.query(
            'UPDATE usuarios SET email = $1, nombre_completo = $2, rol = $3, activo = $4 WHERE id = $5',
            [email, nombre_completo, rol, activo, id]
        );
        res.json({ message: "Usuario actualizado" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. Eliminar Usuario
router.delete('/:id', auth, async (req, res) => {
    try {
        await pool.query('DELETE FROM usuarios WHERE id = $1', [req.params.id]);
        res.json({ message: "Usuario eliminado" });
    } catch (err) {
        res.status(500).json({ error: "No se puede eliminar (tiene datos asociados)" });
    }
});

module.exports = router;