const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");
const verifyRole = require("../middleware/roles");

// Listar Formas de Pago
router.get("/", auth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM formas_pago ORDER BY nombre ASC"
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Crear Forma de Pago
router.post("/", auth, verifyRole(["Administrador", "Lider"]), async (req, res) => {
  const { nombre, tipo } = req.body;
  // tipo debe ser: 'Efectivo', 'Débito' o 'Crédito'
  try {
    const result = await pool.query(
      "INSERT INTO formas_pago (nombre, tipo) VALUES ($1, $2) RETURNING *",
      [nombre, tipo]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Editar
router.put("/:id", auth, verifyRole(["Administrador", "Lider"]), async (req, res) => {
  const { id } = req.params;
  const { nombre, tipo } = req.body;
  try {
    await pool.query(
      "UPDATE formas_pago SET nombre = $1, tipo = $2 WHERE id = $3",
      [nombre, tipo, id]
    );
    res.json({ message: "Actualizado correctamente" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Eliminar
router.delete("/:id", auth, verifyRole(["Administrador", "Lider"]), async (req, res) => {
  try {
    await pool.query("DELETE FROM formas_pago WHERE id = $1", [req.params.id]);
    res.json({ message: "Eliminado correctamente" });
  } catch (err) {
    res.status(500).json({ error: "No se puede eliminar (usado en ventas)" });
  }
});

module.exports = router;
