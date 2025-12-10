const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");
const verifyRole = require("../middleware/roles");

// Helper: Validar que no haya otro periodo activo en la zona
const checkPeriodoActivo = async (zona_id, excludeId = null) => {
  let query = `SELECT id FROM periodos WHERE zona_id = $1 AND estado = 'Activo'`;
  const params = [zona_id];
  if (excludeId) {
    query += ` AND id != $2`;
    params.push(excludeId);
  }
  const res = await pool.query(query, params);
  if (res.rows.length > 0)
    throw new Error(
      "Ya existe un periodo ACTIVO en esta zona. Desactívalo primero."
    );
};

// 1. LISTAR
router.get("/", auth, async (req, res) => {
  try {
    const { rol, zona_id } = req.user;
    let query = `SELECT p.*, z.nombre as zona_nombre FROM periodos p JOIN zonas z ON p.zona_id = z.id`;
    const params = [];
    if (rol === "Lider") {
      query += ` WHERE p.zona_id = $1`;
      params.push(zona_id);
    }
    query += ` ORDER BY p.fecha_inicio DESC`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. DASHBOARD DETALLE DEL PERIODO (KPIs Complejos)
router.get("/:id/dashboard", auth, async (req, res) => {
  const { id } = req.params;
  try {
    const query = `
            SELECT 
                p.nombre, p.dias_operativos, z.nombre as zona,
                (SELECT COUNT(*) FROM jornadas WHERE periodo_id = p.id) as dias_trabajados,
                -- Totales
                COALESCE(SUM(v.monto), 0) as total_ventas,
                COUNT(v.id) as total_fichas,
                -- Por Pago
                COALESCE(SUM(v.monto) FILTER (WHERE fp.tipo = 'Efectivo'), 0) as ventas_efectivo,
                COALESCE(SUM(v.monto) FILTER (WHERE fp.tipo != 'Efectivo'), 0) as ventas_debito,
                COUNT(v.id) FILTER (WHERE fp.tipo = 'Efectivo') as fichas_efectivo,
                COUNT(v.id) FILTER (WHERE fp.tipo != 'Efectivo') as fichas_debito,
                -- Por Tipo Jornada (Cruzando con la asignación del periodo)
                COALESCE(SUM(v.monto) FILTER (WHERE pp.tipo_jornada = 'Part Time'), 0) as ventas_part_time,
                COALESCE(SUM(v.monto) FILTER (WHERE pp.tipo_jornada = 'Full Time'), 0) as ventas_full_time,
                COUNT(v.id) FILTER (WHERE pp.tipo_jornada = 'Part Time') as fichas_part_time,
                COUNT(v.id) FILTER (WHERE pp.tipo_jornada = 'Full Time') as fichas_full_time
            FROM periodos p
            JOIN zonas z ON p.zona_id = z.id
            LEFT JOIN jornadas j ON j.periodo_id = p.id
            LEFT JOIN jornada_promotores jp ON jp.jornada_id = j.id
            LEFT JOIN periodo_promotores pp ON (pp.periodo_id = p.id AND pp.promotor_id = jp.promotor_id)
            LEFT JOIN ventas v ON v.jornada_promotor_id = jp.id
            LEFT JOIN formas_pago fp ON v.forma_pago_id = fp.id
            WHERE p.id = $1
            GROUP BY p.id, z.nombre
        `;
    const result = await pool.query(query, [id]);
    if (result.rows.length === 0)
      return res.status(404).json({ error: "No encontrado" });

    const data = result.rows[0];
    data.avg_importe_ficha =
      data.total_fichas > 0
        ? Math.round(data.total_ventas / data.total_fichas)
        : 0;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// DASHBOARD ANALÍTICO COMPLETO DEL PERIODO
// ================================================================
router.get("/:id/analytics", auth, async (req, res) => {
  const { id } = req.params;
  try {
    // 1. DATOS BÁSICOS DEL PERIODO
    const periodoRes = await pool.query(
      `
            SELECT p.*, z.nombre as zona_nombre 
            FROM periodos p 
            JOIN zonas z ON p.zona_id = z.id 
            WHERE p.id = $1`,
      [id]
    );

    if (periodoRes.rows.length === 0)
      return res.status(404).json({ error: "Periodo no encontrado" });
    const periodo = periodoRes.rows[0];

    // 2. TOTALES GENERALES (Ventas, Fichas, Tipos de Pago)
    const totalesQuery = `
            SELECT 
                COALESCE(SUM(v.monto), 0) as total_ventas,
                COUNT(v.id) as total_fichas,
                -- Desglose Pago
                COALESCE(SUM(v.monto) FILTER (WHERE fp.tipo = 'Efectivo'), 0) as venta_efectivo,
                COALESCE(SUM(v.monto) FILTER (WHERE fp.tipo != 'Efectivo'), 0) as venta_debito,
                COUNT(v.id) FILTER (WHERE fp.tipo = 'Efectivo') as fichas_efectivo,
                COUNT(v.id) FILTER (WHERE fp.tipo != 'Efectivo') as fichas_debito
            FROM ventas v
            JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id
            JOIN jornadas j ON jp.jornada_id = j.id
            JOIN formas_pago fp ON v.forma_pago_id = fp.id
            WHERE j.periodo_id = $1
        `;
    const totales = (await pool.query(totalesQuery, [id])).rows[0];

    // 3. SEGMENTACIÓN POR TIPO DE JORNADA (Full Time vs Part Time)
    // Cruzamos con periodo_promotores para saber qué tipo tenía el promotor EN ESTE PERIODO
    const segmentacionQuery = `
            SELECT 
                pp.tipo_jornada,
                COUNT(DISTINCT pp.promotor_id) as cantidad_promotores,
                COALESCE(SUM(v.monto), 0) as venta_total,
                COUNT(v.id) as fichas_total
            FROM periodo_promotores pp
            LEFT JOIN jornada_promotores jp ON (jp.promotor_id = pp.promotor_id)
            LEFT JOIN jornadas j ON (jp.jornada_id = j.id AND j.periodo_id = pp.periodo_id)
            LEFT JOIN ventas v ON v.jornada_promotor_id = jp.id
            WHERE pp.periodo_id = $1
            GROUP BY pp.tipo_jornada
        `;
    const segmentacionRes = await pool.query(segmentacionQuery, [id]);

    // Formatear segmentación para fácil uso en front
    const segmentacion = {
      full_time: segmentacionRes.rows.find(
        (r) => r.tipo_jornada === "Full Time"
      ) || { cantidad_promotores: 0, venta_total: 0, fichas_total: 0 },
      part_time: segmentacionRes.rows.find(
        (r) => r.tipo_jornada === "Part Time"
      ) || { cantidad_promotores: 0, venta_total: 0, fichas_total: 0 },
    };

    // 4. LISTA DE PROMOTORES CON PERFORMANCE
    const promotoresQuery = `
            SELECT 
                pr.nombre_completo, pr.foto_url, pr.codigo,
                pp.tipo_jornada, pp.objetivo,
                COALESCE(SUM(v.monto), 0) as venta_real,
                COUNT(v.id) as cantidad_fichas,
                (COALESCE(SUM(v.monto), 0) - pp.objetivo) as delta,
                CASE WHEN pp.objetivo > 0 THEN (COALESCE(SUM(v.monto), 0) / pp.objetivo::float) * 100 ELSE 0 END as avance
            FROM periodo_promotores pp
            JOIN promotores pr ON pp.promotor_id = pr.id
            LEFT JOIN jornada_promotores jp ON (jp.promotor_id = pp.promotor_id)
            LEFT JOIN jornadas j ON (jp.jornada_id = j.id AND j.periodo_id = pp.periodo_id)
            LEFT JOIN ventas v ON v.jornada_promotor_id = jp.id
            WHERE pp.periodo_id = $1
            GROUP BY pr.id, pp.id
            ORDER BY venta_real DESC
        `;
    const promotores = (await pool.query(promotoresQuery, [id])).rows;

    // 5. LISTADO DE JORNADAS DEL PERIODO
    const jornadasQuery = `
            SELECT j.*, u.nombre_completo as creador,
            (SELECT COUNT(*) FROM jornada_promotores WHERE jornada_id = j.id) as asistencias,
            (SELECT COALESCE(SUM(monto),0) FROM ventas v JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id WHERE jp.jornada_id = j.id) as venta_dia
            FROM jornadas j
            JOIN usuarios u ON j.created_by = u.id
            WHERE j.periodo_id = $1
            ORDER BY j.fecha DESC
        `;
    const jornadas = (await pool.query(jornadasQuery, [id])).rows;

    // 6. DATOS TOP (Plan y Pago más usados)
    const topPlan = await pool.query(
      `
            SELECT p.nombre, COUNT(*) as cantidad 
            FROM ventas v 
            JOIN planes p ON v.plan_id = p.id 
            JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id
            JOIN jornadas j ON jp.jornada_id = j.id
            WHERE j.periodo_id = $1 
            GROUP BY p.nombre ORDER BY cantidad DESC LIMIT 1
        `,
      [id]
    );

    const topPago = await pool.query(
      `
            SELECT fp.nombre, COUNT(*) as cantidad 
            FROM ventas v 
            JOIN formas_pago fp ON v.forma_pago_id = fp.id 
            JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id
            JOIN jornadas j ON jp.jornada_id = j.id
            WHERE j.periodo_id = $1 
            GROUP BY fp.nombre ORDER BY cantidad DESC LIMIT 1
        `,
      [id]
    );

    // 7. COMPARATIVA CON PERIODO ANTERIOR (Misma zona)
    const prevPeriodo = await pool.query(
      `
            SELECT id, nombre FROM periodos 
            WHERE zona_id = $1 AND fecha_inicio < $2 
            ORDER BY fecha_inicio DESC LIMIT 1
        `,
      [periodo.zona_id, periodo.fecha_inicio]
    );

    let comparativa = {
      hay_previo: false,
      venta_anterior: 0,
      diff_porcentaje: 0,
    };

    if (prevPeriodo.rows.length > 0) {
      const prevId = prevPeriodo.rows[0].id;
      const ventaPrev = await pool.query(
        `
                SELECT COALESCE(SUM(v.monto), 0) as total 
                FROM ventas v 
                JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id
                JOIN jornadas j ON jp.jornada_id = j.id
                WHERE j.periodo_id = $1
            `,
        [prevId]
      );

      const totalPrev = Number(ventaPrev.rows[0].total);
      const totalActual = Number(totales.total_ventas);

      comparativa.hay_previo = true;
      comparativa.nombre_anterior = prevPeriodo.rows[0].nombre;
      comparativa.venta_anterior = totalPrev;
      if (totalPrev > 0) {
        comparativa.diff_porcentaje =
          ((totalActual - totalPrev) / totalPrev) * 100;
      } else {
        comparativa.diff_porcentaje = 100;
      }
    }

    // --- CONSTRUCCIÓN DEL OBJETO FINAL ---
    const metaGlobal = promotores.reduce(
      (sum, p) => sum + Number(p.objetivo),
      0
    );
    const diasCargados = jornadas.length;
    const promedioFicha =
      totales.total_fichas > 0
        ? Math.round(totales.total_ventas / totales.total_fichas)
        : 0;

    res.json({
      info: periodo,
      kpis: {
        meta_global: metaGlobal,
        total_ventas: totales.total_ventas,
        total_fichas: totales.total_fichas,
        promedio_ficha: promedioFicha,
        avance_global:
          metaGlobal > 0 ? (totales.total_ventas / metaGlobal) * 100 : 0,
        dias_cargados: diasCargados,
        dias_operativos: periodo.dias_operativos,
        porcentaje_dias: (diasCargados / periodo.dias_operativos) * 100,
      },
      desglose_pago: {
        efectivo: {
          monto: totales.venta_efectivo,
          fichas: totales.fichas_efectivo,
        },
        debito: { monto: totales.venta_debito, fichas: totales.fichas_debito },
      },
      segmentacion,
      promotores,
      jornadas,
      tops: {
        plan: topPlan.rows[0] || { nombre: "N/A", cantidad: 0 },
        pago: topPago.rows[0] || { nombre: "N/A", cantidad: 0 },
      },
      comparativa,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 3. CREAR
router.post(
  "/",
  auth,
  verifyRole(["Administrador", "Lider"]),
  async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const {
        nombre,
        zona_id,
        fecha_inicio,
        fecha_fin,
        dias_operativos,
        estado,
        promotores,
      } = req.body;

      if (req.user.rol === "Lider" && req.user.zona_id !== zona_id)
        throw new Error("Sin permisos.");
      if (estado === "Activo") await checkPeriodoActivo(zona_id);

      const periodRes = await client.query(
        `INSERT INTO periodos (nombre, zona_id, fecha_inicio, fecha_fin, dias_operativos, estado) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [nombre, zona_id, fecha_inicio, fecha_fin, dias_operativos, estado]
      );
      const pid = periodRes.rows[0].id;

      if (promotores) {
        for (const p of promotores) {
          await client.query(
            `INSERT INTO periodo_promotores (periodo_id, promotor_id, tipo_jornada, objetivo) VALUES ($1, $2, $3, $4)`,
            [pid, p.id, p.tipo_jornada, p.objetivo]
          );
        }
      }
      await client.query("COMMIT");
      res.json({ message: "Creado", id: pid });
    } catch (e) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: e.message });
    } finally {
      client.release();
    }
  }
);

// 4. GET ACTIVO (Esencial para Jornadas)
router.get("/activo/:zona_id", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM periodos WHERE zona_id = $1 AND estado = 'Activo' LIMIT 1`,
      [req.params.zona_id]
    );
    if (result.rows.length === 0) return res.json(null);

    const p = result.rows[0];
    const promRes = await pool.query(
      `
            SELECT pp.promotor_id, pp.tipo_jornada, pp.objetivo, pr.nombre_completo 
            FROM periodo_promotores pp JOIN promotores pr ON pp.promotor_id = pr.id 
            WHERE pp.periodo_id = $1 ORDER BY pr.nombre_completo ASC`,
      [p.id]
    );

    res.json({ ...p, promotores: promRes.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 5. GET DETALLE PARA EDICIÓN
router.get("/:id", auth, async (req, res) => {
  try {
    const pRes = await pool.query("SELECT * FROM periodos WHERE id = $1", [
      req.params.id,
    ]);
    if (pRes.rows.length === 0)
      return res.status(404).json({ error: "No existe" });
    const promRes = await pool.query(
      `
            SELECT pp.promotor_id as id, pp.tipo_jornada, pp.objetivo, pr.nombre_completo 
            FROM periodo_promotores pp JOIN promotores pr ON pp.promotor_id = pr.id 
            WHERE pp.periodo_id = $1`,
      [req.params.id]
    );
    res.json({ ...pRes.rows[0], promotores: promRes.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 6. EDITAR (PUT)
router.put(
  "/:id",
  auth,
  verifyRole(["Administrador", "Lider"]),
  async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const {
        nombre,
        zona_id,
        fecha_inicio,
        fecha_fin,
        dias_operativos,
        estado,
        promotores,
      } = req.body;

      if (estado === "Activo") await checkPeriodoActivo(zona_id, req.params.id);

      await client.query(
        `UPDATE periodos SET nombre=$1, zona_id=$2, fecha_inicio=$3, fecha_fin=$4, dias_operativos=$5, estado=$6 WHERE id=$7`,
        [
          nombre,
          zona_id,
          fecha_inicio,
          fecha_fin,
          dias_operativos,
          estado,
          req.params.id,
        ]
      );

      await client.query(
        "DELETE FROM periodo_promotores WHERE periodo_id = $1",
        [req.params.id]
      );
      if (promotores) {
        for (const p of promotores) {
          await client.query(
            `INSERT INTO periodo_promotores (periodo_id, promotor_id, tipo_jornada, objetivo) VALUES ($1, $2, $3, $4)`,
            [req.params.id, p.id, p.tipo_jornada, p.objetivo]
          );
        }
      }
      await client.query("COMMIT");
      res.json({ message: "Actualizado" });
    } catch (e) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: e.message });
    } finally {
      client.release();
    }
  }
);

// 7. ELIMINAR
router.delete(
  "/:id",
  auth,
  verifyRole(["Administrador", "Lider"]),
  async (req, res) => {
    try {
      await pool.query("DELETE FROM periodos WHERE id = $1", [req.params.id]);
      res.json({ message: "Eliminado" });
    } catch (e) {
      res.status(500).json({ error: "No se puede eliminar (tiene datos)" });
    }
  }
);

module.exports = router;
