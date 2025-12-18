const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");
const verifyRole = require("../middleware/roles");

// 1. LISTAR STANDS (Con array de localidades)
router.get("/", auth, async (req, res) => {
  try {
    const query = `
            SELECT 
                s.*, 
                z.nombre as zona_nombre,
                array_remove(array_agg(l.nombre), NULL) as nombres_localidades,
                array_remove(array_agg(l.id), NULL) as ids_localidades
            FROM stands s
            JOIN zonas z ON s.zona_id = z.id
            LEFT JOIN stand_localidades sl ON s.id = sl.stand_id
            LEFT JOIN localidades l ON sl.localidad_id = l.id
            GROUP BY s.id, z.nombre
            ORDER BY s.nombre ASC
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
    const query = `
            SELECT 
                s.*, 
                array_remove(array_agg(l.nombre), NULL) as nombres_localidades
            FROM stands s
            LEFT JOIN stand_localidades sl ON s.id = sl.stand_id
            LEFT JOIN localidades l ON sl.localidad_id = l.id
            WHERE s.zona_id = $1
            GROUP BY s.id
            ORDER BY s.nombre ASC
        `;
    const result = await pool.query(query, [req.params.zona_id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. CREAR STAND
router.post("/", auth, verifyRole(["Administrador", "Lider"]), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { nombre, zona_id, localidades_ids, ubicacion_lat, ubicacion_lng } =
      req.body;

    const standRes = await client.query(
      "INSERT INTO stands (nombre, zona_id, ubicacion_lat, ubicacion_lng) VALUES ($1, $2, $3, $4) RETURNING id",
      [nombre, zona_id, ubicacion_lat, ubicacion_lng]
    );
    const standId = standRes.rows[0].id;

    if (localidades_ids && localidades_ids.length > 0) {
      for (const locId of localidades_ids) {
        await client.query(
          "INSERT INTO stand_localidades (stand_id, localidad_id) VALUES ($1, $2)",
          [standId, locId]
        );
      }
    }

    await client.query("COMMIT");
    res.json({ message: "Stand creado", id: standId });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 4. EDITAR STAND
router.put("/:id", auth, verifyRole(["Administrador", "Lider"]), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { id } = req.params;
    const { nombre, zona_id, localidades_ids, ubicacion_lat, ubicacion_lng } =
      req.body;

    await client.query(
      "UPDATE stands SET nombre = $1, zona_id = $2, ubicacion_lat = $3, ubicacion_lng = $4 WHERE id = $5",
      [nombre, zona_id, ubicacion_lat, ubicacion_lng, id]
    );

    await client.query("DELETE FROM stand_localidades WHERE stand_id = $1", [
      id,
    ]);

    if (localidades_ids && localidades_ids.length > 0) {
      for (const locId of localidades_ids) {
        await client.query(
          "INSERT INTO stand_localidades (stand_id, localidad_id) VALUES ($1, $2)",
          [id, locId]
        );
      }
    }

    await client.query("COMMIT");
    res.json({ message: "Stand actualizado" });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 5. ELIMINAR
router.delete("/:id", auth, verifyRole(["Administrador", "Lider"]), async (req, res) => {
  try {
    await pool.query("DELETE FROM stands WHERE id = $1", [req.params.id]);
    res.json({ message: "Eliminado correctamente" });
  } catch (err) {
    res.status(500).json({ error: "No se puede eliminar (tiene historial)" });
  }
});

module.exports = router;
