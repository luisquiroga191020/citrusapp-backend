const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");
const verifyRole = require("../middleware/roles");

// --- HELPER 1: Calcular P-Valor desde Z (NECESARIO) ---
function getPFromZ(z) {
  if (z < 0) z = -z;
  const p = 1 / (1 + 0.2316419 * z);
  const d = 0.3989422804014337 * Math.exp((-z * z) / 2);
  const prob =
    d *
    p *
    (0.31938153 +
      p *
        (-0.356563782 +
          p * (1.781477937 + p * (-1.821255978 + 1.330274429 * p))));
  return 2 * prob; // Dos colas
}

// --- HELPER 2: Cálculo Estadístico Prueba U de Mann-Whitney ---
function calculateMannWhitney(groupA, groupB) {
  const n1 = groupA.length;
  const n2 = groupB.length;

  // Si no hay datos suficientes, devolvemos nulos
  if (n1 === 0 || n2 === 0)
    return { u: 0, z: null, p_value: null, conclusion: "Datos insuficientes" };

  // 1. Unir y Ranquear
  const combined = [
    ...groupA.map((v) => ({ val: Number(v), group: "A" })),
    ...groupB.map((v) => ({ val: Number(v), group: "B" })),
  ].sort((a, b) => a.val - b.val);

  let rankSumA = 0;
  combined.forEach((item, index) => {
    if (item.group === "A") rankSumA += index + 1;
  });

  // 2. Calcular U
  const u1 = n1 * n2 + (n1 * (n1 + 1)) / 2 - rankSumA;
  const u2 = n1 * n2 - u1;
  const u = Math.min(u1, u2);

  let conclusion = "Rendimiento similar (por hora)";
  let p_value = null;
  let z = null;

  // 3. Interpretación Estadística (Solo si n > 5)
  if (n1 > 5 && n2 > 5) {
    const mu = (n1 * n2) / 2;
    const sigma = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);

    // Evitar división por cero
    if (sigma !== 0) {
      z = (u - mu) / sigma;
      p_value = getPFromZ(z); // Llamada al Helper 1

      if (p_value < 0.05) {
        conclusion = "Diferencia SIGNIFICATIVA de Eficiencia";
      }
    }
  }

  return { u, z, p_value, conclusion };
}

// --- HELPER 3: Validar Periodo Activo ---
const checkPeriodoActivo = async (zona_id, excludeId = null) => {
  let query = `SELECT id FROM periodos WHERE zona_id = $1 AND estado = 'Activo'`;
  const params = [zona_id];
  if (excludeId) {
    query += ` AND id != $2`;
    params.push(excludeId);
  }
  const res = await pool.query(query, params);
  if (res.rows.length > 0)
    throw new Error("Ya existe un periodo ACTIVO en esta zona.");
};

// ================================================================
// 1. LISTAR PERIODOS
// ================================================================
router.get(
  "/",
  auth,
  verifyRole(["Administrador", "Lider", "Visualizador"]),
  async (req, res) => {
    try {
      const { rol, zona_id } = req.user;
      let query = `
            SELECT p.*, z.nombre as zona_nombre 
            FROM periodos p
            JOIN zonas z ON p.zona_id = z.id
        `;
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
  }
);

// ================================================================
// 2. DASHBOARD ANALÍTICO AVANZADO (Detalle Periodo)
// ================================================================
router.get(
  "/:id/analytics",
  auth,
  verifyRole(["Administrador", "Lider", "Visualizador"]),
  async (req, res) => {
    const { id } = req.params;
    try {
      // A. INFO PERIODO
      const periodoRes = await pool.query(
        `SELECT p.*, z.nombre as zona_nombre FROM periodos p JOIN zonas z ON p.zona_id = z.id WHERE p.id = $1`,
        [id]
      );
      if (periodoRes.rows.length === 0)
        return res.status(404).json({ error: "Periodo no encontrado" });
      const periodo = periodoRes.rows[0];

      // B. KPIS GENERALES + DESGLOSE PAGO
      const totalesQuery = `
            SELECT 
                COALESCE(SUM(v.monto), 0) as total_ventas,
                COUNT(v.id) as total_fichas,
                COUNT(DISTINCT v.jornada_promotor_id) as dias_hombre_trabajados,
                COALESCE(SUM(v.monto) FILTER (WHERE fp.tipo = 'Efectivo'), 0) as venta_efectivo,
                COALESCE(SUM(v.monto) FILTER (WHERE fp.tipo = 'Débito'), 0) as venta_debito,
                COALESCE(SUM(v.monto) FILTER (WHERE fp.tipo = 'Crédito'), 0) as venta_credito,
                COUNT(v.id) FILTER (WHERE fp.tipo = 'Efectivo') as fichas_efectivo,
                COUNT(v.id) FILTER (WHERE fp.tipo = 'Débito') as fichas_debito,
                COUNT(v.id) FILTER (WHERE fp.tipo = 'Crédito') as fichas_credito,
                CASE WHEN COUNT(v.id) > 0 THEN SUM(v.monto) / COUNT(v.id) ELSE 0 END as ticket_promedio,
                CASE WHEN COUNT(DISTINCT v.jornada_promotor_id) > 0 THEN SUM(v.monto) / COUNT(DISTINCT v.jornada_promotor_id) ELSE 0 END as venta_promedio_diaria_promotor
            FROM ventas v
            JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id
            JOIN jornadas j ON jp.jornada_id = j.id
            JOIN formas_pago fp ON v.forma_pago_id = fp.id
            WHERE j.periodo_id = $1
        `;
      const totales = (await pool.query(totalesQuery, [id])).rows[0];

      // C. SEGMENTACIÓN & ESTADÍSTICA (NORMALIZADA POR HORA)
      const statsQuery = `
            WITH ventas_por_turno AS (
                SELECT 
                    pp.tipo_jornada,
                    SUM(v.monto) as venta_diaria_total,
                    CASE 
                        WHEN pp.tipo_jornada = 'Full Time' THEN SUM(v.monto) / 9.0
                        WHEN pp.tipo_jornada = 'Part Time' THEN SUM(v.monto) / 6.0
                        ELSE SUM(v.monto) / 8.0 
                    END as venta_hora
                FROM ventas v
                JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id
                JOIN jornadas j ON jp.jornada_id = j.id
                JOIN periodo_promotores pp ON (pp.periodo_id = j.periodo_id AND pp.promotor_id = jp.promotor_id)
                WHERE j.periodo_id = $1
                GROUP BY pp.tipo_jornada, jp.id
            )
            SELECT 
                tipo_jornada,
                COUNT(*) as n_muestras,
                SUM(venta_diaria_total) as venta_total_absoluta,
                AVG(venta_hora) as promedio_hora,
                MIN(venta_hora) as min,
                PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY venta_hora) as q1,
                PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY venta_hora) as mediana,
                PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY venta_hora) as q3,
                MAX(venta_hora) as max,
                json_agg(venta_hora) as raw_data
            FROM ventas_por_turno
            GROUP BY tipo_jornada
        `;
      const statsRes = await pool.query(statsQuery, [id]);

      const fullStats = statsRes.rows.find(
        (r) => r.tipo_jornada === "Full Time"
      ) || {
        venta_total_absoluta: 0,
        min: 0,
        q1: 0,
        mediana: 0,
        q3: 0,
        max: 0,
        raw_data: [],
      };
      const partStats = statsRes.rows.find(
        (r) => r.tipo_jornada === "Part Time"
      ) || {
        venta_total_absoluta: 0,
        min: 0,
        q1: 0,
        mediana: 0,
        q3: 0,
        max: 0,
        raw_data: [],
      };

      const mannWhitney = calculateMannWhitney(
        fullStats.raw_data || [],
        partStats.raw_data || []
      );

      const segmentacion = {
        full_time: {
          venta_total: fullStats.venta_total_absoluta,
          cantidad_promotores: await getCountPromotores(id, "Full Time"),
          fichas_total: await getCountFichas(id, "Full Time"),
        },
        part_time: {
          venta_total: partStats.venta_total_absoluta,
          cantidad_promotores: await getCountPromotores(id, "Part Time"),
          fichas_total: await getCountFichas(id, "Part Time"),
        },
      };

      // D. HISTORIAL JORNADAS
      const jornadasQuery = `
            SELECT j.id, j.fecha, u.nombre_completo as creador,
            (SELECT COUNT(*) FROM jornada_promotores WHERE jornada_id = j.id) as asistencias,
            (SELECT COALESCE(SUM(monto),0) FROM ventas v JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id WHERE jp.jornada_id = j.id) as venta_dia,
            (SELECT COUNT(*) FROM ventas v JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id WHERE jp.jornada_id = j.id) as fichas_dia
            FROM jornadas j JOIN usuarios u ON j.created_by = u.id WHERE j.periodo_id = $1 ORDER BY j.fecha DESC
        `;
      const jornadas = (await pool.query(jornadasQuery, [id])).rows;

      // E. PROMOTORES
      const promotores = (
        await pool.query(
          `
            SELECT pr.id, pr.nombre_completo, pr.foto_url, pp.tipo_jornada, pp.objetivo, 
            COALESCE(SUM(v.monto), 0) as venta_real, COUNT(v.id) as cantidad_fichas,
            (COALESCE(SUM(v.monto), 0) - pp.objetivo) as delta, 
            CASE WHEN pp.objetivo > 0 THEN (COALESCE(SUM(v.monto), 0) / pp.objetivo::float) * 100 ELSE 0 END as avance
            FROM periodo_promotores pp JOIN promotores pr ON pp.promotor_id = pr.id 
            LEFT JOIN jornadas j ON (j.periodo_id = pp.periodo_id)
            LEFT JOIN jornada_promotores jp ON (jp.jornada_id = j.id AND jp.promotor_id = pp.promotor_id) 
            LEFT JOIN ventas v ON v.jornada_promotor_id = jp.id
            WHERE pp.periodo_id = $1 GROUP BY pr.id, pp.id ORDER BY venta_real DESC
        `,
          [id]
        )
      ).rows;

      // F. TOPS & SEMANAL & DIARIO
      const topPlan = (
        await pool.query(
          `SELECT p.nombre, COUNT(*) as cantidad, SUM(v.monto) as monto FROM ventas v JOIN planes p ON v.plan_id = p.id JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id JOIN jornadas j ON jp.jornada_id = j.id WHERE j.periodo_id = $1 GROUP BY p.nombre ORDER BY cantidad DESC LIMIT 1`,
          [id]
        )
      ).rows[0];
      const topPago = (
        await pool.query(
          `SELECT fp.nombre, COUNT(*) as cantidad FROM ventas v JOIN formas_pago fp ON v.forma_pago_id = fp.id JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id JOIN jornadas j ON jp.jornada_id = j.id WHERE j.periodo_id = $1 GROUP BY fp.nombre ORDER BY cantidad DESC LIMIT 1`,
          [id]
        )
      ).rows[0];
      const semanal = (
        await pool.query(
          `SELECT TO_CHAR(j.fecha, 'Day') as nombre_dia, SUM(v.monto) as venta, COUNT(v.id) as fichas FROM ventas v JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id JOIN jornadas j ON jp.jornada_id = j.id WHERE j.periodo_id = $1 GROUP BY 1, EXTRACT(ISODOW FROM j.fecha) ORDER BY EXTRACT(ISODOW FROM j.fecha)`,
          [id]
        )
      ).rows;
      const diario = (
        await pool.query(
          `SELECT TO_CHAR(j.fecha, 'YYYY-MM-DD') as fecha, COALESCE(SUM(v.monto), 0) as total, COUNT(v.id) as fichas FROM ventas v JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id JOIN jornadas j ON jp.jornada_id = j.id WHERE j.periodo_id = $1 GROUP BY j.fecha ORDER BY j.fecha ASC`,
          [id]
        )
      ).rows;

      // G. COMPARATIVA
      const prevPeriodo = await pool.query(
        `SELECT id, nombre FROM periodos WHERE zona_id = $1 AND fecha_inicio < $2 ORDER BY fecha_inicio DESC LIMIT 1`,
        [periodo.zona_id, periodo.fecha_inicio]
      );
      let comparativa = { existe: false, diferencia: 0 };
      if (prevPeriodo.rows.length > 0) {
        const vPrev = await pool.query(
          `SELECT COALESCE(SUM(v.monto), 0) as total FROM ventas v JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id JOIN jornadas j ON jp.jornada_id = j.id WHERE j.periodo_id = $1`,
          [prevPeriodo.rows[0].id]
        );
        const actual = Number(totales.total_ventas);
        const anterior = Number(vPrev.rows[0].total);
        comparativa = {
          existe: true,
          nombre: prevPeriodo.rows[0].nombre,
          anterior,
          diferencia:
            anterior > 0 ? ((actual - anterior) / anterior) * 100 : 100,
        };
      }

      // --- RESPUESTA ---
      const metaGlobal = promotores.reduce(
        (sum, p) => sum + Number(p.objetivo),
        0
      );
      const diasCargados = jornadas.length;

      res.json({
        info: periodo,
        kpis: {
          ...totales,
          meta_global: metaGlobal,
          avance_global:
            metaGlobal > 0 ? (totales.total_ventas / metaGlobal) * 100 : 0,
          dias_cargados: diasCargados,
          dias_operativos: periodo.dias_operativos,
        },
        desglose_pago: {
          efectivo: {
            monto: totales.venta_efectivo,
            fichas: totales.fichas_efectivo,
          },
          debito: {
            monto: totales.venta_debito,
            fichas: totales.fichas_debito,
          },
          credito: {
            monto: totales.venta_credito,
            fichas: totales.fichas_credito,
          },
        },
        estadistica: {
          full: fullStats,
          part: partStats,
          mann_whitney: mannWhitney,
        },
        segmentacion,
        tops: { plan: topPlan, pago: topPago },
        semanal,
        ventas_diarias: diario,
        promotores,
        jornadas,
        comparativa,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  }
);

async function getCountPromotores(periodoId, tipo) {
  const res = await pool.query(
    "SELECT COUNT(*) FROM periodo_promotores WHERE periodo_id = $1 AND tipo_jornada = $2",
    [periodoId, tipo]
  );
  return parseInt(res.rows[0].count);
}
async function getCountFichas(periodoId, tipo) {
  const res = await pool.query(
    `SELECT COUNT(v.id) FROM ventas v JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id JOIN periodo_promotores pp ON (pp.promotor_id = jp.promotor_id AND pp.periodo_id = $1) WHERE pp.tipo_jornada = $2`,
    [periodoId, tipo]
  );
  return parseInt(res.rows[0].count);
}

// ... RUTAS BÁSICAS (Copiarlas si no están) ...
router.get(
  "/:id",
  auth,
  verifyRole(["Administrador", "Lider", "Visualizador"]),
  async (req, res) => {
    try {
      const pRes = await pool.query("SELECT * FROM periodos WHERE id = $1", [
        req.params.id,
      ]);
      if (pRes.rows.length === 0)
        return res.status(404).json({ error: "No existe" });
      const promRes = await pool.query(
        `SELECT pp.promotor_id as id, pp.tipo_jornada, pp.objetivo, pr.nombre_completo FROM periodo_promotores pp JOIN promotores pr ON pp.promotor_id = pr.id WHERE pp.periodo_id = $1`,
        [req.params.id]
      );
      res.json({ ...pRes.rows[0], promotores: promRes.rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

router.get(
  "/activo/:zona_id",
  auth,
  verifyRole(["Administrador", "Lider", "Visualizador"]),
  async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT * FROM periodos WHERE zona_id = $1 AND estado = 'Activo' LIMIT 1`,
        [req.params.zona_id]
      );
      if (result.rows.length === 0) return res.json(null);
      const p = result.rows[0];
      const promRes = await pool.query(
        `SELECT pp.promotor_id, pp.tipo_jornada, pp.objetivo, pr.nombre_completo, pr.codigo, pr.foto_url FROM periodo_promotores pp JOIN promotores pr ON pp.promotor_id = pr.id WHERE pp.periodo_id = $1 AND pr.activo = true ORDER BY pr.nombre_completo`,
        [p.id]
      );
      res.json({ ...p, promotores: promRes.rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

router.post("/", auth, verifyRole(["Administrador"]), async (req, res) => {
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
});

router.put("/:id", auth, verifyRole(["Administrador"]), async (req, res) => {
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
    await client.query("DELETE FROM periodo_promotores WHERE periodo_id = $1", [
      req.params.id,
    ]);
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
});

router.delete("/:id", auth, verifyRole(["Administrador"]), async (req, res) => {
  try {
    await pool.query("DELETE FROM periodos WHERE id = $1", [req.params.id]);
    res.json({ message: "Eliminado" });
  } catch (e) {
    res.status(500).json({ error: "No se puede eliminar" });
  }
});

module.exports = router;
