const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");
const verifyRole = require("../middleware/roles");

// HELPER: Construir clausula WHERE para fechas vs periodo activo
const buildDateFilter = (startDate, endDate) => {
  if (startDate && endDate) {
    // Filtro por Rango de Fechas (ignora estado de periodo)
    // Se asume join con tablas: jornadas j
    return {
      sql: `j.fecha BETWEEN $1 AND $2`,
      params: [startDate, endDate],
      isDateRange: true,
    };
  } else {
    // Filtro por Defecto: Periodos Activos
    // Se asume join con: periodos p
    return {
      sql: `p.estado = 'Activo'`,
      params: [],
      isDateRange: false,
    };
  }
};

// 1. RESUMEN GLOBAL (KPIs)
router.get("/dashboard", auth, async (req, res) => {
  try {
    const { zona_id, rol } = req.user;
    const { startDate, endDate } = req.query;

    const isFiltered = startDate && endDate;
    const globalParams = [];

    // --- 1. CONFIG: Ventas & Fichas ---
    let ventasFichasWhereClause;
    let ventasFichasJoinPeriodos = "";

    if (isFiltered) {
      // Index $1, $2
      ventasFichasWhereClause = `j.fecha BETWEEN $${
        globalParams.length + 1
      } AND $${globalParams.length + 2}`;
      globalParams.push(startDate, endDate);
    } else {
      ventasFichasWhereClause = `p.estado = 'Activo'`;
      ventasFichasJoinPeriodos = `JOIN periodos p ON j.periodo_id = p.id`;
    }

    let zonaConditionVentasFichas = "";
    if (rol === "Lider") {
      zonaConditionVentasFichas = `AND j.zona_id = $${globalParams.length + 1}`;
      globalParams.push(zona_id);
    }

    // --- 2. CONFIG: Activos Hoy ---
    // Note: Activos Hoy is always based on CURRENT_DATE, but might need Zona filter
    let activosHoyZonaCondition = "";
    if (rol === "Lider") {
      activosHoyZonaCondition = `AND j.zona_id = $${globalParams.length + 1}`;
      globalParams.push(zona_id);
    }

    // --- 3. CONFIG: Objetivo Global ---
    let objetivoWhereClause;

    if (isFiltered) {
      // Overlap logic: Start <= RangeEnd AND End >= RangeStart
      objetivoWhereClause = `p.fecha_inicio <= $${
        globalParams.length + 1
      } AND p.fecha_fin >= $${globalParams.length + 2}`;
      globalParams.push(endDate, startDate);
    } else {
      // Default: Active periods containing today
      objetivoWhereClause = `p.estado = 'Activo' AND CURRENT_DATE BETWEEN p.fecha_inicio AND p.fecha_fin`;
    }

    let zonaConditionObjetivo = "";
    if (rol === "Lider") {
      zonaConditionObjetivo = `AND p.zona_id = $${globalParams.length + 1}`;
      globalParams.push(zona_id);
    }

    const query = `
            SELECT
                -- 1. Ventas
                (SELECT COALESCE(SUM(v.monto), 0)
                 FROM ventas v
                 JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id
                 JOIN jornadas j ON jp.jornada_id = j.id
                 ${ventasFichasJoinPeriodos}
                 WHERE ${ventasFichasWhereClause}
                 ${zonaConditionVentasFichas}
                ) as ventas_mes,

                -- 2. Fichas
                (SELECT COUNT(*)
                 FROM ventas v
                 JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id
                 JOIN jornadas j ON jp.jornada_id = j.id
                 ${ventasFichasJoinPeriodos}
                 WHERE ${ventasFichasWhereClause}
                 ${zonaConditionVentasFichas}
                ) as fichas_mes,

                -- 3. Promotores Activos HOY
                (SELECT COUNT(DISTINCT jp.promotor_id)
                 FROM jornada_promotores jp
                 JOIN jornadas j ON jp.jornada_id = j.id
                 WHERE j.fecha = CURRENT_DATE
                 ${activosHoyZonaCondition}
                ) as activos_hoy,

                -- 4. Objetivo Global
                (SELECT COALESCE(SUM(pp.objetivo), 0)
                 FROM periodo_promotores pp
                 JOIN periodos p ON pp.periodo_id = p.id
                 WHERE ${objetivoWhereClause}
                 ${zonaConditionObjetivo}
                 -- Evitar duplicar objetivos si un promotor está en el mismo periodo multiple veces (poco probable por diseño pero safeproof)
                 -- Group by logic is not needed if we sum pp.objetivo directly assuming uniqueness in periodo_promotores
                ) as objetivo_global
        `;

    const result = await pool.query(query, globalParams);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. RANKING
router.get("/ranking", auth, async (req, res) => {
  try {
    const { rol, zona_id } = req.user;
    const { startDate, endDate } = req.query;

    const filter = buildDateFilter(startDate, endDate);

    let query;
    let params = [];

    if (filter.isDateRange) {
      // For custom date range, we focus on sales within the range.
      // Objectives are harder to define for arbitrary ranges, so we'll use MAX(pp.objetivo)
      // which is an approximation if a promoter has multiple objectives in overlapping periods.
      query = `
            SELECT
                pr.nombre_completo,
                pr.foto_url,
                COALESCE(MAX(pp.objetivo), 0) as objetivo,
                COALESCE(SUM(v.monto), 0) as venta_real,
                (COALESCE(SUM(v.monto), 0) - COALESCE(MAX(pp.objetivo), 0)) as delta,
                CASE
                    WHEN COALESCE(MAX(pp.objetivo), 0) > 0 THEN (COALESCE(SUM(v.monto), 0) / MAX(pp.objetivo)::float) * 100
                    ELSE 0
                END as avance_porcentaje,
                MAX(pp.tipo_jornada) as tipo_jornada,
                MAX(z.nombre) as nombre_zona
            FROM ventas v
            JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id
            JOIN jornadas j ON jp.jornada_id = j.id
            JOIN periodos p ON j.periodo_id = p.id
            JOIN periodo_promotores pp ON (pp.periodo_id = p.id AND pp.promotor_id = jp.promotor_id)
            JOIN promotores pr ON jp.promotor_id = pr.id
            JOIN zonas z ON p.zona_id = z.id
            WHERE j.fecha BETWEEN $1 AND $2
            ${rol === "Lider" ? `AND p.zona_id = $3` : ""}
            GROUP BY pr.id, pr.nombre_completo, pr.foto_url
            ORDER BY venta_real DESC
            LIMIT 10
         `;
      params = [startDate, endDate];
      if (rol === "Lider") params.push(zona_id);
    } else {
      // Default: Active Period
      let whereClause = `p.estado = 'Activo'`;
      if (rol === "Lider") {
        whereClause += ` AND p.zona_id = $1`;
        params.push(zona_id);
      }

      query = `
            SELECT
                pr.nombre_completo,
                pr.foto_url,
                pp.objetivo,
                COALESCE(SUM(v.monto), 0) as venta_real,
                (COALESCE(SUM(v.monto), 0) - COALESCE(pp.objetivo, 0)) as delta,
                CASE
                    WHEN pp.objetivo > 0 THEN (COALESCE(SUM(v.monto), 0) / pp.objetivo::float) * 100
                    ELSE 0
                END as avance_porcentaje,
                pp.tipo_jornada,
                z.nombre as nombre_zona
            FROM periodos p
            JOIN periodo_promotores pp ON pp.periodo_id = p.id
            JOIN promotores pr ON pp.promotor_id = pr.id
            LEFT JOIN jornadas j ON j.periodo_id = p.id
            LEFT JOIN jornada_promotores jp ON (jp.jornada_id = j.id AND jp.promotor_id = pr.id)
            LEFT JOIN ventas v ON v.jornada_promotor_id = jp.id
            LEFT JOIN zonas z ON p.zona_id = z.id
            WHERE ${whereClause}
            GROUP BY pr.id, pr.nombre_completo, pr.foto_url, pp.objetivo, pp.tipo_jornada, z.nombre
            ORDER BY venta_real DESC
            LIMIT 10
        `;
    }

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. GRÁFICO SEMANAL (O "Evolución Temporal")
router.get("/semanal", auth, async (req, res) => {
  try {
    const { rol, zona_id } = req.user;
    const { startDate, endDate } = req.query;

    let whereClause;
    let params = [];

    if (startDate && endDate) {
      whereClause = `j.fecha BETWEEN $1 AND $2`;
      params = [startDate, endDate];
    } else {
      whereClause = `j.fecha >= CURRENT_DATE - INTERVAL '7 days'`;
    }

    if (rol === "Lider") {
      whereClause += ` AND j.zona_id = $${params.length + 1}`;
      params.push(zona_id);
    }

    let query = `
            SELECT TO_CHAR(j.fecha, 'DD/MM') as dia, SUM(v.monto) as total
            FROM ventas v
            JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id
            JOIN jornadas j ON jp.jornada_id = j.id
            WHERE ${whereClause}
            GROUP BY j.fecha
            ORDER BY j.fecha ASC
    `;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. GRÁFICO PLANES
router.get("/planes", auth, async (req, res) => {
  try {
    const { rol, zona_id } = req.user;
    const { startDate, endDate } = req.query;

    let whereClause;
    let params = [];
    let joinPeriodos = "";

    if (startDate && endDate) {
      whereClause = `j.fecha BETWEEN $1 AND $2`;
      params = [startDate, endDate];
    } else {
      // Active Period Default
      whereClause = `p.estado = 'Activo'`;
      joinPeriodos = `JOIN periodos p ON j.periodo_id = p.id`;
    }

    if (rol === "Lider") {
      whereClause += ` AND j.zona_id = $${params.length + 1}`;
      params.push(zona_id);
    }

    let query = `
            SELECT pl.nombre, COUNT(v.id) as cantidad
            FROM ventas v
            JOIN planes pl ON v.plan_id = pl.id
            JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id
            JOIN jornadas j ON jp.jornada_id = j.id
            ${joinPeriodos}
            WHERE ${whereClause}
            GROUP BY pl.nombre
    `;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
