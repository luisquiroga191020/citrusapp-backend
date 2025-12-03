const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");

// Listar Promotores
router.get("/", auth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM promotores ORDER BY nombre_completo ASC"
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Crear Promotor
router.post("/", auth, async (req, res) => {
  const { codigo, nombre_completo, foto_url } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO promotores (codigo, nombre_completo, foto_url) VALUES ($1, $2, $3) RETURNING *",
      [codigo, nombre_completo, foto_url]
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505")
      return res.status(400).json({ error: "El código de promotor ya existe" });
    res.status(500).json({ error: err.message });
  }
});

// Editar
router.put("/:id", auth, async (req, res) => {
  const { id } = req.params;
  const { codigo, nombre_completo, foto_url } = req.body;
  try {
    await pool.query(
      "UPDATE promotores SET codigo = $1, nombre_completo = $2, foto_url = $3 WHERE id = $4",
      [codigo, nombre_completo, foto_url, id]
    );
    res.json({ message: "Promotor actualizado" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Borrar
router.delete("/:id", auth, async (req, res) => {
  try {
    await pool.query("DELETE FROM promotores WHERE id = $1", [req.params.id]);
    res.json({ message: "Promotor eliminado" });
  } catch (err) {
    res.status(500).json({ error: "No se puede eliminar (tiene historial)" });
  }
});

module.exports = router;
