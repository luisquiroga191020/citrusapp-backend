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
        "SELECT p.*, z.nombre as zona_nombre FROM promotores p LEFT JOIN zonas z ON p.zona_id = z.id ORDER BY p.activo DESC, p.nombre_completo",
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
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
        [req.params.zona_id],
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

// PERFORMANCE HISTÓRICO
router.get(
  "/:id/performance",
  auth,
  verifyRole(["Administrador", "Lider", "Visualizador"]),
  async (req, res) => {
    try {
      // Obtenemos todos los periodos donde el promotor trabajó (sin agrupar por zona)
      const periodosQuery = `
            SELECT DISTINCT
              p.id as periodo_id,
              p.nombre as periodo,
              p.estado,
              pp.objetivo,
              p.fecha_inicio,
              p.dias_operativos
            FROM jornada_promotores jp
            JOIN jornadas j ON jp.jornada_id = j.id
            JOIN periodos p ON j.periodo_id = p.id
            LEFT JOIN periodo_promotores pp ON (pp.periodo_id = p.id AND pp.promotor_id = jp.promotor_id)
            WHERE jp.promotor_id = $1
            ORDER BY p.fecha_inicio DESC
        `;
      const periodosResult = await pool.query(periodosQuery, [req.params.id]);

      // Para cada periodo, obtenemos totales y jornadas con sus ventas
      const periodosConJornadas = await Promise.all(
        periodosResult.rows.map(async (periodo) => {
          // Calcular totales para todo el periodo (todas las zonas)
          const totalesQuery = `
            SELECT 
              COALESCE(SUM(v.monto), 0) as venta_real,
              COUNT(DISTINCT v.id) as total_fichas
            FROM jornada_promotores jp
            JOIN jornadas j ON jp.jornada_id = j.id
            LEFT JOIN ventas v ON v.jornada_promotor_id = jp.id
            WHERE jp.promotor_id = $1 
              AND j.periodo_id = $2
          `;
          const totalesResult = await pool.query(totalesQuery, [
            req.params.id,
            periodo.periodo_id,
          ]);

          // Calcular días no operativos (Novedades con operativo = 'NO')
          const noOperativosQuery = `
            SELECT COUNT(*) as dias
            FROM jornada_promotores jp
            JOIN jornadas j ON jp.jornada_id = j.id
            JOIN tipo_novedad tn ON jp.tipo_novedad_id = tn.id
            WHERE jp.promotor_id = $1 
              AND j.periodo_id = $2
              AND tn.operativo = 'NO'
          `;
          const noOperativosResult = await pool.query(noOperativosQuery, [
            req.params.id,
            periodo.periodo_id,
          ]);
          const dias_no_operativos = parseInt(
            noOperativosResult.rows[0].dias || 0,
          );
          const dias_operativos_periodo = periodo.dias_operativos || 0;

          let objetivo = periodo.objetivo || 0;
          let objetivo_real = objetivo;

          if (dias_operativos_periodo > 0) {
            const dias_efectivos = Math.max(
              0,
              dias_operativos_periodo - dias_no_operativos,
            );
            objetivo_real =
              (objetivo / dias_operativos_periodo) * dias_efectivos;
          }

          const venta_real = totalesResult.rows[0].venta_real;
          const total_fichas = totalesResult.rows[0].total_fichas;
          const delta = venta_real - objetivo_real; // Delta sobre objetivo real

          // Obtener jornadas para este periodo
          const jornadasQuery = `
            SELECT 
              j.id as jornada_id,
              j.fecha,
              jp.id as jornada_promotor_id,
              z.nombre as zona_nombre,
              (SELECT string_agg(s.nombre, ', ') 
               FROM stands s 
               WHERE s.id = ANY(jp.stands_ids)) as stand_nombre,
              tn.nombre as tipo_novedad,
              COUNT(v.id) as fichas,
              COALESCE(SUM(v.monto), 0) as venta_dia
            FROM jornadas j
            INNER JOIN jornada_promotores jp ON jp.jornada_id = j.id AND jp.promotor_id = $1
            LEFT JOIN zonas z ON z.id = jp.zona_id
            LEFT JOIN ventas v ON v.jornada_promotor_id = jp.id
            LEFT JOIN tipo_novedad tn ON tn.id = jp.tipo_novedad_id
            WHERE j.periodo_id = $2
            GROUP BY j.id, j.fecha, jp.id, z.nombre, jp.stands_ids, tn.nombre
            ORDER BY j.fecha DESC
          `;
          const jornadasResult = await pool.query(jornadasQuery, [
            req.params.id,
            periodo.periodo_id,
          ]);

          // Para cada jornada, obtener las ventas individuales
          const jornadasConVentas = await Promise.all(
            jornadasResult.rows.map(async (jornada) => {
              const ventasQuery = `
                SELECT 
                  v.id,
                  v.monto,
                  v.codigo_ficha,
                  v.created_at,
                  pl.nombre as plan_nombre,
                  fp.nombre as forma_pago
                FROM ventas v
                JOIN planes pl ON v.plan_id = pl.id
                JOIN formas_pago fp ON v.forma_pago_id = fp.id
                WHERE v.jornada_promotor_id = $1
                ORDER BY v.created_at DESC
              `;
              const ventasResult = await pool.query(ventasQuery, [
                jornada.jornada_promotor_id,
              ]);

              return {
                ...jornada,
                ventas: ventasResult.rows,
              };
            }),
          );

          return {
            periodo_id: periodo.periodo_id,
            periodo: periodo.periodo,
            estado: periodo.estado,
            objetivo: objetivo,
            objetivo_real: objetivo_real, // Nuevo campo
            dias_operativos: dias_operativos_periodo,
            dias_no_operativos: dias_no_operativos,
            venta_real: venta_real,
            delta: delta,
            total_fichas: total_fichas,
            jornadas: jornadasConVentas,
          };
        }),
      );

      res.json(periodosConJornadas);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
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
      [codigo, nombre_completo, foto_url, zona_id, objetivo_base, tipo_jornada],
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
        ],
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
