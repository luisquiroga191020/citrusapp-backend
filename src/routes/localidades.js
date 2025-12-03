const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");

// Listar Localidades (Incluye nombre de la Zona)
router.get("/", auth, async (req, res) => {
  try {
    const query = `
            SELECT l.*, z.nombre as zona_nombre 
            FROM localidades l
            JOIN zonas z ON l.zona_id = z.id
            ORDER BY l.nombre ASC
        `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Filtrar Localidades por Zona (Útil para selects en cascada)
router.get("/zona/:zona_id", auth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM localidades WHERE zona_id = $1 ORDER BY nombre ASC",
      [req.params.zona_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Crear Localidad
router.post("/", auth, async (req, res) => {
  const { nombre, departamento, zona_id } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO localidades (nombre, departamento, zona_id) VALUES ($1, $2, $3) RETURNING *",
      [nombre, departamento, zona_id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Editar
router.put("/:id", auth, async (req, res) => {
  const { id } = req.params;
  const { nombre, departamento, zona_id } = req.body;
  try {
    await pool.query(
      "UPDATE localidades SET nombre = $1, departamento = $2, zona_id = $3 WHERE id = $4",
      [nombre, departamento, zona_id, id]
    );
    res.json({ message: "Actualizado correctamente" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Eliminar
router.delete("/:id", auth, async (req, res) => {
  try {
    await pool.query("DELETE FROM localidades WHERE id = $1", [req.params.id]);
    res.json({ message: "Eliminado correctamente" });
  } catch (err) {
    res
      .status(500)
      .json({ error: "No se puede eliminar (tiene stands asociados)" });
  }
});

module.exports = router;
