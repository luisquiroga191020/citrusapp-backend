const router = require("express").Router();
const pool = require("../db");
const bcrypt = require("bcryptjs");
const auth = require("../middleware/auth");

router.get("/", auth, async (req, res) => {
  try {
    // Traemos también el nombre de la zona para mostrarlo en la tabla
    const query = `
            SELECT u.id, u.email, u.nombre_completo, u.rol, u.activo, u.zona_id, z.nombre as nombre_zona
            FROM usuarios u
            LEFT JOIN zonas z ON u.zona_id = z.id
            ORDER BY u.nombre_completo ASC
        `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/", auth, async (req, res) => {
  const { email, password, nombre_completo, rol, zona_id } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    // Insertamos zona_id (puede ser null si es admin)
    const result = await pool.query(
      "INSERT INTO usuarios (email, password_hash, nombre_completo, rol, zona_id) VALUES ($1, $2, $3, $4, $5) RETURNING id, email",
      [email, hash, nombre_completo, rol, zona_id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505")
      return res.status(400).json({ error: "Email ya registrado" });
    res.status(500).json({ error: err.message });
  }
});

router.put("/:id", auth, async (req, res) => {
  const { id } = req.params;
  const { email, nombre_completo, rol, activo, zona_id } = req.body;
  try {
    await pool.query(
      "UPDATE usuarios SET email = $1, nombre_completo = $2, rol = $3, activo = $4, zona_id = $5 WHERE id = $6",
      [email, nombre_completo, rol, activo, zona_id, id]
    );
    res.json({ message: "Usuario actualizado" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/:id", auth, async (req, res) => {
  try {
    await pool.query("DELETE FROM usuarios WHERE id = $1", [req.params.id]);
    res.json({ message: "Eliminado" });
  } catch (err) {
    res.status(500).json({ error: "No se puede eliminar." });
  }
});

module.exports = router;
