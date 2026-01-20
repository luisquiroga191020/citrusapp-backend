const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");
const verifyRole = require("../middleware/roles");

// 1. LISTAR STANDS (Con array de localidades)
router.get(
  "/",
  auth,
  verifyRole(["Administrador", "Lider", "Visualizador"]),
  async (req, res) => {
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
  },
);

// 2. FILTRAR POR ZONA
router.get(
  "/zona/:zona_id",
  auth,
  verifyRole(["Administrador", "Lider", "Visualizador"]),
  async (req, res) => {
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
  },
);

// 3. CREAR STAND
router.post("/", auth, verifyRole(["Administrador"]), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { nombre, zona_id, localidades_ids, ubicacion_lat, ubicacion_lng } =
      req.body;

    const standRes = await client.query(
      "INSERT INTO stands (nombre, zona_id, ubicacion_lat, ubicacion_lng) VALUES ($1, $2, $3, $4) RETURNING id",
      [nombre, zona_id, ubicacion_lat, ubicacion_lng],
    );
    const standId = standRes.rows[0].id;

    if (localidades_ids && localidades_ids.length > 0) {
      for (const locId of localidades_ids) {
        await client.query(
          "INSERT INTO stand_localidades (stand_id, localidad_id) VALUES ($1, $2)",
          [standId, locId],
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
router.put("/:id", auth, verifyRole(["Administrador"]), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { id } = req.params;
    const { nombre, zona_id, localidades_ids, ubicacion_lat, ubicacion_lng } =
      req.body;

    await client.query(
      "UPDATE stands SET nombre = $1, zona_id = $2, ubicacion_lat = $3, ubicacion_lng = $4 WHERE id = $5",
      [nombre, zona_id, ubicacion_lat, ubicacion_lng, id],
    );

    await client.query("DELETE FROM stand_localidades WHERE stand_id = $1", [
      id,
    ]);

    if (localidades_ids && localidades_ids.length > 0) {
      for (const locId of localidades_ids) {
        await client.query(
          "INSERT INTO stand_localidades (stand_id, localidad_id) VALUES ($1, $2)",
          [id, locId],
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

// 6. ANALYTICS - Detalle jerárquico de ventas por stand
router.get(
  "/:id/analytics",
  auth,
  verifyRole(["Administrador", "Lider", "Visualizador"]),
  async (req, res) => {
    try {
      const { id } = req.params;

      // Información del stand
      const standRes = await pool.query(
        `SELECT s.*, z.nombre as zona_nombre 
       FROM stands s 
       JOIN zonas z ON s.zona_id = z.id 
       WHERE s.id = $1`,
        [id],
      );

      if (standRes.rows.length === 0) {
        return res.status(404).json({ error: "Stand no encontrado" });
      }

      const stand = standRes.rows[0];

      // Obtener jornadas con totales DEL PERIODO ACTIVO
      const jornadasRes = await pool.query(
        `SELECT 
        j.id as jornada_id,
        j.fecha,
        COALESCE(SUM(v.monto), 0) as total_ventas,
        COUNT(v.id) as total_fichas
      FROM jornadas j
      JOIN jornada_promotores jp ON jp.jornada_id = j.id
      LEFT JOIN ventas v ON v.jornada_promotor_id = jp.id
      WHERE $1 = ANY(jp.stands_ids)
        AND j.periodo_id IN (SELECT id FROM periodos WHERE zona_id = $2 AND estado = 'Activo')
      GROUP BY j.id, j.fecha
      ORDER BY j.fecha DESC`,
        [id, stand.zona_id],
      );

      // Para cada jornada, obtener promotores
      const jornadas = await Promise.all(
        jornadasRes.rows.map(async (jornada) => {
          const promotoresRes = await pool.query(
            `SELECT 
            jp.promotor_id,
            pr.nombre_completo,
            pr.foto_url,
            COALESCE(SUM(v.monto), 0) as venta_total,
            COUNT(v.id) as fichas
          FROM jornada_promotores jp
          JOIN promotores pr ON pr.id = jp.promotor_id
          LEFT JOIN ventas v ON v.jornada_promotor_id = jp.id
          WHERE jp.jornada_id = $1 AND $2 = ANY(jp.stands_ids)
          GROUP BY jp.promotor_id, pr.nombre_completo, pr.foto_url
          ORDER BY pr.nombre_completo`,
            [jornada.jornada_id, id],
          );

          // Para cada promotor, obtener ventas
          const promotores = await Promise.all(
            promotoresRes.rows.map(async (promotor) => {
              const ventasRes = await pool.query(
                `SELECT 
                v.id as venta_id,
                v.codigo_ficha,
                v.monto,
                v.tipo,
                v.created_at,
                p.nombre as plan_nombre,
                fp.nombre as forma_pago,
                fp.tipo as forma_pago_tipo
              FROM ventas v
              JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id
              JOIN planes p ON v.plan_id = p.id
              JOIN formas_pago fp ON v.forma_pago_id = fp.id
              WHERE jp.jornada_id = $1 
                AND jp.promotor_id = $2 
                AND $3 = ANY(jp.stands_ids)
              ORDER BY v.created_at ASC`,
                [jornada.jornada_id, promotor.promotor_id, id],
              );

              return {
                ...promotor,
                ventas: ventasRes.rows,
              };
            }),
          );

          return {
            ...jornada,
            promotores,
          };
        }),
      );

      // Calcular totales generales DEL PERIODO ACTIVO
      const totalesRes = await pool.query(
        `SELECT 
        COALESCE(SUM(v.monto), 0) as total_ventas,
        COUNT(v.id) as total_fichas,
        COUNT(DISTINCT j.id) as total_jornadas
      FROM jornadas j
      JOIN jornada_promotores jp ON jp.jornada_id = j.id
      LEFT JOIN ventas v ON v.jornada_promotor_id = jp.id
      WHERE $1 = ANY(jp.stands_ids)
        AND j.periodo_id IN (SELECT id FROM periodos WHERE zona_id = $2 AND estado = 'Activo')`,
        [id, stand.zona_id],
      );

      // Obtener nombre del periodo activo para el header
      const periodoActivoRes = await pool.query(
        `SELECT nombre FROM periodos WHERE zona_id = $1 AND estado = 'Activo' LIMIT 1`,
        [stand.zona_id],
      );

      res.json({
        stand,
        periodo_activo: periodoActivoRes.rows[0]?.nombre || null,
        jornadas,
        totales: totalesRes.rows[0],
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  },
);

// 5. ELIMINAR
router.delete("/:id", auth, verifyRole(["Administrador"]), async (req, res) => {
  try {
    await pool.query("DELETE FROM stands WHERE id = $1", [req.params.id]);
    res.json({ message: "Eliminado correctamente" });
  } catch (err) {
    res.status(500).json({ error: "No se puede eliminar (tiene historial)" });
  }
});

module.exports = router;
