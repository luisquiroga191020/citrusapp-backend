const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");

// 1. Listar todas las zonas
router.get("/", auth, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM zonas ORDER BY nombre ASC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Crear una zona
router.post("/", auth, async (req, res) => {
  const { nombre } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO zonas (nombre) VALUES ($1) RETURNING *",
      [nombre]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Editar una zona
router.put("/:id", auth, async (req, res) => {
  const { id } = req.params;
  const { nombre } = req.body;
  try {
    await pool.query("UPDATE zonas SET nombre = $1 WHERE id = $2", [
      nombre,
      id,
    ]);
    res.json({ message: "Zona actualizada correctamente" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Eliminar una zona
router.delete("/:id", auth, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM zonas WHERE id = $1", [id]);
    res.json({ message: "Zona eliminada correctamente" });
  } catch (err) {
    // Error común: La zona está siendo usada por usuarios, periodos o stands
    if (err.code === "23503") {
      return res
        .status(400)
        .json({
          error:
            "No se puede eliminar la zona porque tiene datos asociados (Usuarios, Periodos o Stands).",
        });
    }
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
