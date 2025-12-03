const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");

// Listar Stands
router.get("/", auth, async (req, res) => {
  try {
    const query = `
            SELECT s.*, z.nombre as zona_nombre, l.nombre as localidad_nombre
            FROM stands s
            JOIN zonas z ON s.zona_id = z.id
            JOIN localidades l ON s.localidad_id = l.id
            ORDER BY s.nombre ASC
        `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Filtrar Stands por Zona (Para asignar en Jornadas)
router.get("/zona/:zona_id", auth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM stands WHERE zona_id = $1 ORDER BY nombre ASC",
      [req.params.zona_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Crear Stand
router.post("/", auth, async (req, res) => {
  const { nombre, zona_id, localidad_id, ubicacion_lat, ubicacion_lng } =
    req.body;
  try {
    const result = await pool.query(
      "INSERT INTO stands (nombre, zona_id, localidad_id, ubicacion_lat, ubicacion_lng) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [nombre, zona_id, localidad_id, ubicacion_lat, ubicacion_lng]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Editar
router.put("/:id", auth, async (req, res) => {
  const { id } = req.params;
  const { nombre, zona_id, localidad_id, ubicacion_lat, ubicacion_lng } =
    req.body;
  try {
    await pool.query(
      "UPDATE stands SET nombre = $1, zona_id = $2, localidad_id = $3, ubicacion_lat = $4, ubicacion_lng = $5 WHERE id = $6",
      [nombre, zona_id, localidad_id, ubicacion_lat, ubicacion_lng, id]
    );
    res.json({ message: "Actualizado correctamente" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Eliminar
router.delete("/:id", auth, async (req, res) => {
  try {
    await pool.query("DELETE FROM stands WHERE id = $1", [req.params.id]);
    res.json({ message: "Eliminado correctamente" });
  } catch (err) {
    res
      .status(500)
      .json({ error: "No se puede eliminar (tiene historial de jornadas)" });
  }
});

module.exports = router;
