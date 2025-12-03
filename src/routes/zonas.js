const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");

router.get("/", auth, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM zonas ORDER BY nombre ASC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/", auth, async (req, res) => {
  const { nombre, color_identificador } = req.body; // <--- Agregado
  try {
    const result = await pool.query(
      "INSERT INTO zonas (nombre, color_identificador) VALUES ($1, $2) RETURNING *",
      [nombre, color_identificador]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/:id", auth, async (req, res) => {
  const { id } = req.params;
  const { nombre, color_identificador } = req.body; // <--- Agregado
  try {
    await pool.query(
      "UPDATE zonas SET nombre = $1, color_identificador = $2 WHERE id = $3",
      [nombre, color_identificador, id]
    );
    res.json({ message: "Zona actualizada" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/:id", auth, async (req, res) => {
  try {
    await pool.query("DELETE FROM zonas WHERE id = $1", [req.params.id]);
    res.json({ message: "Zona eliminada" });
  } catch (err) {
    res
      .status(500)
      .json({ error: "No se puede eliminar (tiene datos asociados)" });
  }
});

module.exports = router;
