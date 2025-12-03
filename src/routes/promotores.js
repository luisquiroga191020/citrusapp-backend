const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");

// Listar Promotores (Ahora con Zona)
router.get("/", auth, async (req, res) => {
  try {
    const query = `
            SELECT p.*, z.nombre as zona_nombre 
            FROM promotores p
            LEFT JOIN zonas z ON p.zona_id = z.id
            ORDER BY p.nombre_completo ASC
        `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Listar Promotores por Zona (Para usar en Periodos)
router.get("/zona/:zona_id", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM promotores WHERE zona_id = $1 ORDER BY nombre_completo ASC`,
      [req.params.zona_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Crear Promotor (Con Zona y Objetivo Base)
router.post("/", auth, async (req, res) => {
  const { codigo, nombre_completo, foto_url, zona_id, objetivo_base } =
    req.body;
  try {
    const result = await pool.query(
      "INSERT INTO promotores (codigo, nombre_completo, foto_url, zona_id, objetivo_base) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [codigo, nombre_completo, foto_url, zona_id, objetivo_base]
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505")
      return res.status(400).json({ error: "El código ya existe" });
    res.status(500).json({ error: err.message });
  }
});

// Editar Promotor
router.put("/:id", auth, async (req, res) => {
  const { id } = req.params;
  const { codigo, nombre_completo, foto_url, zona_id, objetivo_base } =
    req.body;
  try {
    await pool.query(
      "UPDATE promotores SET codigo = $1, nombre_completo = $2, foto_url = $3, zona_id = $4, objetivo_base = $5 WHERE id = $6",
      [codigo, nombre_completo, foto_url, zona_id, objetivo_base, id]
    );
    res.json({ message: "Promotor actualizado" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Eliminar (Igual que antes)
router.delete("/:id", auth, async (req, res) => {
  try {
    await pool.query("DELETE FROM promotores WHERE id = $1", [req.params.id]);
    res.json({ message: "Promotor eliminado" });
  } catch (err) {
    res.status(500).json({ error: "No se puede eliminar (tiene historial)" });
  }
});

module.exports = router;
