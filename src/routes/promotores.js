const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");
const verifyRole = require("../middleware/roles");

// Listar
router.get(
  "/",
  auth,
  verifyRole(["Administrador", "Lider", "Visualizador"]),
  async (req, res) => {
    try {
      const result = await pool.query(
        "SELECT p.*, z.nombre as zona_nombre FROM promotores p LEFT JOIN zonas z ON p.zona_id = z.id ORDER BY p.activo DESC, p.nombre_completo"
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// Listar por Zona
router.get(
  "/zona/:zona_id",
  auth,
  verifyRole(["Administrador", "Lider", "Visualizador"]),
  async (req, res) => {
    try {
      const result = await pool.query(
        "SELECT * FROM promotores WHERE zona_id = $1 AND activo = true ORDER BY nombre_completo",
        [req.params.zona_id]
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// PERFORMANCE HISTÓRICO
router.get(
  "/:id/performance",
  auth,
  verifyRole(["Administrador", "Lider", "Visualizador"]),
  async (req, res) => {
    try {
      // Primero obtenemos los periodos con sus totales
      const periodosQuery = `
            SELECT 
              p.id as periodo_id,
              p.nombre as periodo, 
              pp.objetivo, 
              COALESCE(SUM(v.monto),0) as venta_real,
              (COALESCE(SUM(v.monto),0) - pp.objetivo) as delta,
              COUNT(v.id) as total_fichas
            FROM periodo_promotores pp
            JOIN periodos p ON pp.periodo_id = p.id
            LEFT JOIN jornada_promotores jp ON (jp.promotor_id = pp.promotor_id AND jp.jornada_id IN (SELECT id FROM jornadas WHERE periodo_id = p.id))
            LEFT JOIN ventas v ON v.jornada_promotor_id = jp.id
            WHERE pp.promotor_id = $1
            GROUP BY p.id, p.nombre, pp.objetivo, p.fecha_inicio
            ORDER BY p.fecha_inicio DESC
        `;
      const periodosResult = await pool.query(periodosQuery, [req.params.id]);

      // Para cada periodo, obtenemos el detalle de jornadas
      const periodosConJornadas = await Promise.all(
        periodosResult.rows.map(async (periodo) => {
          const jornadasQuery = `
            SELECT 
              j.id as jornada_id,
              j.fecha,
              (SELECT asistencia FROM jornada_promotores WHERE jornada_id = j.id AND promotor_id = $1 LIMIT 1) as asistencia,
              COUNT(v.id) as fichas,
              COALESCE(SUM(v.monto), 0) as venta_dia
            FROM jornadas j
            LEFT JOIN jornada_promotores jp ON jp.jornada_id = j.id AND jp.promotor_id = $1
            LEFT JOIN ventas v ON v.jornada_promotor_id = jp.id
            WHERE j.periodo_id = $2
            GROUP BY j.id, j.fecha
            ORDER BY j.fecha DESC
          `;
          const jornadasResult = await pool.query(jornadasQuery, [
            req.params.id,
            periodo.periodo_id,
          ]);

          return {
            ...periodo,
            jornadas: jornadasResult.rows,
          };
        })
      );

      res.json(periodosConJornadas);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// Crear
router.post("/", auth, verifyRole(["Administrador"]), async (req, res) => {
  const {
    codigo,
    nombre_completo,
    foto_url,
    zona_id,
    objetivo_base,
    tipo_jornada,
  } = req.body;
  try {
    await pool.query(
      "INSERT INTO promotores (codigo, nombre_completo, foto_url, zona_id, objetivo_base, tipo_jornada, activo) VALUES ($1, $2, $3, $4, $5, $6, true)",
      [codigo, nombre_completo, foto_url, zona_id, objetivo_base, tipo_jornada]
    );
    res.json({ message: "Creado" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Editar
router.put("/:id", auth, verifyRole(["Administrador"]), async (req, res) => {
  const {
    codigo,
    nombre_completo,
    foto_url,
    zona_id,
    objetivo_base,
    tipo_jornada,
    activo,
  } = req.body;
  try {
    // Si solo se envía activo (para reactivar), solo actualizar ese campo
    if (activo !== undefined && Object.keys(req.body).length === 1) {
      await pool.query("UPDATE promotores SET activo=$1 WHERE id=$2", [
        activo,
        req.params.id,
      ]);
    } else {
      // Actualización completa
      await pool.query(
        "UPDATE promotores SET codigo=$1, nombre_completo=$2, foto_url=$3, zona_id=$4, objetivo_base=$5, tipo_jornada=$6 WHERE id=$7",
        [
          codigo,
          nombre_completo,
          foto_url,
          zona_id,
          objetivo_base,
          tipo_jornada,
          req.params.id,
        ]
      );
    }
    res.json({ message: "Actualizado" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Borrar
router.delete("/:id", auth, verifyRole(["Administrador"]), async (req, res) => {
  try {
    await pool.query("DELETE FROM promotores WHERE id = $1", [req.params.id]);
    res.json({ message: "Eliminado permanentemente", type: "hard_delete" });
  } catch (err) {
    // Si falla por restricción de llave foránea (código 23503 en Postgres), hacemos soft delete
    if (err.code === "23503") {
      try {
        await pool.query("UPDATE promotores SET activo = false WHERE id = $1", [
          req.params.id,
        ]);
        return res.status(200).json({
          message: "Desactivado (Soft Delete) por historial asociado",
          type: "soft_delete",
        });
      } catch (updateErr) {
        return res.status(500).json({ error: updateErr.message });
      }
    }
    res.status(500).json({ error: "No se puede eliminar: " + err.message });
  }
});

module.exports = router;
