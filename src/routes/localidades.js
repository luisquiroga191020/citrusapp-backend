const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");

// 1. LISTAR
router.get("/", auth, async (req, res) => {
  try {
    const query = `
            SELECT l.*, z.nombre as zona_nombre 
            FROM localidades l
            LEFT JOIN zonas z ON l.zona_id = z.id
            ORDER BY l.nombre ASC
        `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. FILTRAR POR ZONA
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

// 3. CREAR (Sin campo oficina suelto)
router.post("/", auth, async (req, res) => {
  const {
    nombre,
    departamento,
    zona_id,
    presencia,
    poblacion,
    certificados_activos,
    viviendas,
    latitud,
    longitud,
  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO localidades 
            (nombre, departamento, zona_id, presencia, poblacion, certificados_activos, viviendas, latitud, longitud) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
            RETURNING *`,
      [
        nombre,
        departamento,
        zona_id,
        presencia,
        poblacion,
        certificados_activos,
        viviendas,
        latitud,
        longitud,
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. EDITAR
router.put("/:id", auth, async (req, res) => {
  const { id } = req.params;
  const {
    nombre,
    departamento,
    zona_id,
    presencia,
    poblacion,
    certificados_activos,
    viviendas,
    latitud,
    longitud,
  } = req.body;

  try {
    await pool.query(
      `UPDATE localidades SET 
                nombre = $1, departamento = $2, zona_id = $3, 
                presencia = $4, poblacion = $5, 
                certificados_activos = $6, viviendas = $7, 
                latitud = $8, longitud = $9
             WHERE id = $10`,
      [
        nombre,
        departamento,
        zona_id,
        presencia,
        poblacion,
        certificados_activos,
        viviendas,
        latitud,
        longitud,
        id,
      ]
    );
    res.json({ message: "Actualizado correctamente" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. ELIMINAR
router.delete("/:id", auth, async (req, res) => {
  try {
    await pool.query("DELETE FROM localidades WHERE id = $1", [req.params.id]);
    res.json({ message: "Eliminado correctamente" });
  } catch (err) {
    res
      .status(500)
      .json({ error: "No se puede eliminar (tiene datos asociados)" });
  }
});

module.exports = router;
