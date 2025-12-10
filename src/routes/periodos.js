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
// DASHBOARD ANALÍTICO AVANZADO (Caja y Bigotes + Top 3 + Semanal)
// ================================================================
router.get("/:id/analytics", auth, async (req, res) => {
  const { id } = req.params;
  try {
    // 1. INFO PERIODO
    const periodoRes = await pool.query(
      `SELECT p.*, z.nombre as zona_nombre FROM periodos p JOIN zonas z ON p.zona_id = z.id WHERE p.id = $1`,
      [id]
    );
    if (periodoRes.rows.length === 0)
      return res.status(404).json({ error: "Periodo no encontrado" });
    const periodo = periodoRes.rows[0];

    // 2. KPIS GENERALES & COMPARATIVA
    const totalesQuery = `
            SELECT 
                COALESCE(SUM(v.monto), 0) as total_ventas,
                COUNT(v.id) as total_fichas,
                COUNT(DISTINCT v.jornada_promotor_id) as dias_hombre_trabajados, -- Cantidad de turnos reales que vendieron
                COALESCE(SUM(v.monto) FILTER (WHERE fp.tipo = 'Efectivo'), 0) as venta_efectivo,
                COALESCE(SUM(v.monto) FILTER (WHERE fp.tipo != 'Efectivo'), 0) as venta_debito,
                -- Promedios
                CASE WHEN COUNT(v.id) > 0 THEN SUM(v.monto) / COUNT(v.id) ELSE 0 END as ticket_promedio,
                CASE WHEN COUNT(DISTINCT v.jornada_promotor_id) > 0 THEN SUM(v.monto) / COUNT(DISTINCT v.jornada_promotor_id) ELSE 0 END as venta_promedio_diaria_promotor
            FROM ventas v
            JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id
            JOIN jornadas j ON jp.jornada_id = j.id
            JOIN formas_pago fp ON v.forma_pago_id = fp.id
            WHERE j.periodo_id = $1
        `;
    const totales = (await pool.query(totalesQuery, [id])).rows[0];

    // 3. SEGMENTACIÓN & ESTADÍSTICA (CAJA Y BIGOTES)
    // Calculamos cuartiles para Full Time vs Part Time
    const estadisticaQuery = `
            WITH ventas_por_turno AS (
                SELECT 
                    pp.tipo_jornada,
                    SUM(v.monto) as venta_turno -- Venta total de ese promotor en ese día
                FROM ventas v
                JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id
                JOIN jornadas j ON jp.jornada_id = j.id
                JOIN periodo_promotores pp ON (pp.periodo_id = j.periodo_id AND pp.promotor_id = jp.promotor_id)
                WHERE j.periodo_id = $1
                GROUP BY pp.tipo_jornada, jp.id
            )
            SELECT 
                tipo_jornada,
                COUNT(*) as cantidad_turnos,
                SUM(venta_turno) as venta_total,
                MIN(venta_turno) as min,
                PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY venta_turno) as q1,
                PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY venta_turno) as mediana,
                PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY venta_turno) as q3,
                MAX(venta_turno) as max
            FROM ventas_por_turno
            GROUP BY tipo_jornada
        `;
    const estadisticaRes = await pool.query(estadisticaQuery, [id]);

    // Estructurar para el front
    const estadistica = {
      full: estadisticaRes.rows.find((r) => r.tipo_jornada === "Full Time") || {
        venta_total: 0,
        min: 0,
        q1: 0,
        mediana: 0,
        q3: 0,
        max: 0,
      },
      part: estadisticaRes.rows.find((r) => r.tipo_jornada === "Part Time") || {
        venta_total: 0,
        min: 0,
        q1: 0,
        mediana: 0,
        q3: 0,
        max: 0,
      },
    };

    // 4. ANÁLISIS SEMANAL (Día de la semana)
    const semanalQuery = `
            SELECT 
                TO_CHAR(j.fecha, 'Day') as nombre_dia,
                EXTRACT(ISODOW FROM j.fecha) as num_dia,
                SUM(v.monto) as venta,
                COUNT(v.id) as fichas
            FROM ventas v
            JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id
            JOIN jornadas j ON jp.jornada_id = j.id
            WHERE j.periodo_id = $1
            GROUP BY 1, 2
            ORDER BY 2 ASC
        `;
    const semanal = (await pool.query(semanalQuery, [id])).rows;

    // 5. TOP 3 PLANES (Sin Iconos, solo data)
    const topPlanes = await pool.query(
      `
            SELECT p.nombre, COUNT(*) as cantidad, SUM(v.monto) as monto 
            FROM ventas v 
            JOIN planes p ON v.plan_id = p.id 
            JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id
            JOIN jornadas j ON jp.jornada_id = j.id
            WHERE j.periodo_id = $1 
            GROUP BY p.nombre ORDER BY cantidad DESC LIMIT 3
        `,
      [id]
    );

    // 6. LISTADO PROMOTORES (Performance)
    const promotoresQuery = `
            SELECT 
                pr.nombre_completo, pr.foto_url,
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

    // 7. COMPARATIVA PERIODO ANTERIOR
    const prevPeriodo = await pool.query(
      `
            SELECT id, nombre FROM periodos 
            WHERE zona_id = $1 AND fecha_inicio < $2 
            ORDER BY fecha_inicio DESC LIMIT 1
        `,
      [periodo.zona_id, periodo.fecha_inicio]
    );

    let comparativa = { existe: false, diferencia: 0 };
    if (prevPeriodo.rows.length > 0) {
      const vPrev = await pool.query(
        `
                SELECT COALESCE(SUM(v.monto), 0) as total FROM ventas v 
                JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id
                JOIN jornadas j ON jp.jornada_id = j.id WHERE j.periodo_id = $1
            `,
        [prevPeriodo.rows[0].id]
      );
      const actual = Number(totales.total_ventas);
      const anterior = Number(vPrev.rows[0].total);
      comparativa = {
        existe: true,
        nombre: prevPeriodo.rows[0].nombre,
        anterior,
        diferencia: anterior > 0 ? ((actual - anterior) / anterior) * 100 : 100,
      };
    }

    // --- RESPUESTA ---
    const metaGlobal = promotores.reduce(
      (sum, p) => sum + Number(p.objetivo),
      0
    );
    const diasCargados = await pool.query(
      "SELECT COUNT(*) FROM jornadas WHERE periodo_id = $1",
      [id]
    );

    res.json({
      info: periodo,
      kpis: {
        ...totales,
        meta_global: metaGlobal,
        avance_global:
          metaGlobal > 0 ? (totales.total_ventas / metaGlobal) * 100 : 0,
        dias_cargados: parseInt(diasCargados.rows[0].count),
        dias_operativos: periodo.dias_operativos,
      },
      estadistica, // Datos para Caja y Bigotes
      semanal, // Datos para gráfico barras
      top_planes: topPlanes.rows,
      promotores,
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
