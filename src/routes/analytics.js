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
                (SELECT COALESCE(SUM(v.monto) FILTER (WHERE v.estado IN ('CARGADO', 'PENDIENTE')), 0)
                 FROM ventas v
                 JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id
                 JOIN jornadas j ON jp.jornada_id = j.id
                 ${ventasFichasJoinPeriodos}
                 WHERE ${ventasFichasWhereClause}
                 ${zonaConditionVentasFichas}
                ) as ventas_mes,

                (SELECT COALESCE(SUM(v.monto), 0)
                 FROM ventas v
                 JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id
                 JOIN jornadas j ON jp.jornada_id = j.id
                 ${ventasFichasJoinPeriodos}
                 WHERE ${ventasFichasWhereClause}
                 ${zonaConditionVentasFichas}
                ) as ventas_planillada_mes,

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
                (SELECT COALESCE(SUM(
                    CASE 
                        WHEN p.dias_operativos > 0 THEN 
                          (pp.objetivo::float / p.dias_operativos) * (p.dias_operativos - (
                             SELECT COUNT(DISTINCT jp_sub.id) 
                             FROM jornada_promotores jp_sub 
                             JOIN jornadas j_sub ON jp_sub.jornada_id = j_sub.id
                             JOIN tipo_novedad tn_sub ON jp_sub.tipo_novedad_id = tn_sub.id
                             WHERE jp_sub.promotor_id = pp.promotor_id 
                               AND j_sub.periodo_id = p.id 
                               AND tn_sub.operativo = 'NO'
                          ))
                        ELSE pp.objetivo::float
                    END
                ), 0)
                 FROM periodo_promotores pp
                 JOIN periodos p ON pp.periodo_id = p.id
                 WHERE ${objetivoWhereClause}
                 ${zonaConditionObjetivo}
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
                pr.id,
                pr.nombre_completo,
                pr.foto_url,
                COALESCE(MAX(pp.objetivo), 0) as objetivo,
                COALESCE(SUM(v.monto) FILTER (WHERE v.estado IN ('CARGADO', 'PENDIENTE')), 0) as venta_real,
                COALESCE(SUM(v.monto), 0) as venta_planillada,
                                COUNT(v.id) as fichas,
                COUNT(v.id) FILTER (WHERE v.estado = 'RECHAZADO') as fichas_rechazadas,
                (COALESCE(SUM(v.monto) FILTER (WHERE v.estado IN ('CARGADO', 'PENDIENTE')), 0) - COALESCE(MAX(pp.objetivo), 0)) as delta,
                CASE
                    WHEN COALESCE(MAX(pp.objetivo), 0) > 0 THEN (COALESCE(SUM(v.monto) FILTER (WHERE v.estado IN ('CARGADO', 'PENDIENTE')), 0) / MAX(pp.objetivo)::float) * 100
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
                pr.id,
                pr.nombre_completo,
                pr.foto_url,
                
                -- CÁLCULO OBJETIVO REAL
                CASE 
                    WHEN p.dias_operativos > 0 THEN 
                      (pp.objetivo::float / p.dias_operativos) * (p.dias_operativos - COUNT(DISTINCT jp.id) FILTER (WHERE tn.operativo = 'NO'))
                    ELSE 
                      pp.objetivo::float 
                END as objetivo,

                COALESCE(SUM(v.monto) FILTER (WHERE v.estado IN ('CARGADO', 'PENDIENTE')), 0) as venta_real,
                COALESCE(SUM(v.monto), 0) as venta_planillada,
                COUNT(v.id) as fichas,
                COUNT(v.id) FILTER (WHERE v.estado = 'RECHAZADO') as fichas_rechazadas,
                COUNT(DISTINCT jp.id) FILTER (WHERE tn.operativo = 'NO') as dias_no_operativos,
                
                -- DELTA SOBRE OBJETIVO REAL
                (COALESCE(SUM(v.monto) FILTER (WHERE v.estado IN ('CARGADO', 'PENDIENTE')), 0) - (
                    CASE 
                        WHEN p.dias_operativos > 0 THEN 
                          (pp.objetivo::float / p.dias_operativos) * (p.dias_operativos - COUNT(DISTINCT jp.id) FILTER (WHERE tn.operativo = 'NO'))
                        ELSE 
                          pp.objetivo::float 
                    END
                )) as delta,
                
                -- AVANCE SOBRE OBJETIVO REAL
                CASE
                    WHEN (
                        CASE 
                            WHEN p.dias_operativos > 0 THEN 
                              (pp.objetivo::float / p.dias_operativos) * (p.dias_operativos - COUNT(DISTINCT jp.id) FILTER (WHERE tn.operativo = 'NO'))
                            ELSE 
                              pp.objetivo::float 
                        END
                    ) > 0 THEN 
                        (COALESCE(SUM(v.monto) FILTER (WHERE v.estado IN ('CARGADO', 'PENDIENTE')), 0) / (
                            CASE 
                                WHEN p.dias_operativos > 0 THEN 
                                  (pp.objetivo::float / p.dias_operativos) * (p.dias_operativos - COUNT(DISTINCT jp.id) FILTER (WHERE tn.operativo = 'NO'))
                                ELSE 
                                  pp.objetivo::float 
                            END
                        )::float) * 100
                    ELSE 0
                END as avance_porcentaje,
                
                pp.tipo_jornada,
                z.nombre as nombre_zona
            FROM periodos p
            JOIN periodo_promotores pp ON pp.periodo_id = p.id
            JOIN promotores pr ON pp.promotor_id = pr.id
            LEFT JOIN jornadas j ON j.periodo_id = p.id
            LEFT JOIN jornada_promotores jp ON (jp.jornada_id = j.id AND jp.promotor_id = pr.id)
            LEFT JOIN tipo_novedad tn ON jp.tipo_novedad_id = tn.id
            LEFT JOIN ventas v ON v.jornada_promotor_id = jp.id
            LEFT JOIN zonas z ON p.zona_id = z.id
            WHERE ${whereClause}
            GROUP BY pr.id, pr.nombre_completo, pr.foto_url, pp.objetivo, pp.tipo_jornada, z.nombre, p.dias_operativos
            ORDER BY venta_real DESC
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

// --- HELPERS ESTADÍSTICOS (Reutilizados de periodos.js) ---
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

function calculateMannWhitney(groupA, groupB) {
  const n1 = groupA.length;
  const n2 = groupB.length;
  if (n1 === 0 || n2 === 0)
    return { u: 0, z: null, p_value: null, conclusion: "Datos insuficientes" };

  const combined = [
    ...groupA.map((v) => ({ val: Number(v), group: "A" })),
    ...groupB.map((v) => ({ val: Number(v), group: "B" })),
  ].sort((a, b) => a.val - b.val);

  let rankSumA = 0;
  combined.forEach((item, index) => {
    if (item.group === "A") rankSumA += index + 1;
  });

  const u1 = n1 * n2 + (n1 * (n1 + 1)) / 2 - rankSumA;
  const u2 = n1 * n2 - u1;
  const u = Math.min(u1, u2);

  let conclusion = "Rendimiento similar (por hora)";
  let p_value = null;
  let z = null;

  if (n1 > 5 && n2 > 5) {
    const mu = (n1 * n2) / 2;
    const sigma = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);
    if (sigma !== 0) {
      z = (u - mu) / sigma;
      p_value = getPFromZ(z);
      if (p_value < 0.05) {
        conclusion = "Diferencia SIGNIFICATIVA de Eficiencia";
      }
    }
  }
  return { u, z, p_value, conclusion };
}

// 5. DISTRIBUCIÓN DE EFICIENCIA (Cross-Zone)
router.get("/eficiencia", auth, async (req, res) => {
  try {
    const { rol, zona_id } = req.user;
    const { startDate, endDate } = req.query;

    const filter = buildDateFilter(startDate, endDate);
    let whereClause = filter.sql;
    let params = [...filter.params];

    if (rol === "Lider") {
      whereClause += ` AND j.zona_id = $${params.length + 1}`;
      params.push(zona_id);
    }

    const query = `
      WITH ventas_por_turno AS (
          SELECT 
              pp.tipo_jornada,
              jp.promotor_id,
              SUM(v.monto) FILTER (WHERE v.estado IN ('CARGADO', 'PENDIENTE')) as venta_diaria_total,
              CASE 
                  WHEN pp.tipo_jornada = 'Full Time' THEN SUM(v.monto) FILTER (WHERE v.estado IN ('CARGADO', 'PENDIENTE')) / 9.0
                  WHEN pp.tipo_jornada = 'Part Time' THEN SUM(v.monto) FILTER (WHERE v.estado IN ('CARGADO', 'PENDIENTE')) / 6.0
                  ELSE SUM(v.monto) FILTER (WHERE v.estado IN ('CARGADO', 'PENDIENTE')) / 8.0 
              END as venta_hora
          FROM ventas v
          JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id
          JOIN jornadas j ON jp.jornada_id = j.id
          JOIN periodos p ON j.periodo_id = p.id
          JOIN periodo_promotores pp ON (pp.periodo_id = p.id AND pp.promotor_id = jp.promotor_id)
          WHERE ${whereClause}
          GROUP BY pp.tipo_jornada, jp.promotor_id, jp.id
      )
      SELECT 
          tipo_jornada,
          COUNT(DISTINCT promotor_id) as n_promotores,
          COUNT(*) as n_muestras,
          COALESCE(AVG(venta_hora), 0) as promedio_hora,
          COALESCE(MIN(venta_hora), 0) as min,
          COALESCE(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY venta_hora), 0) as q1,
          COALESCE(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY venta_hora), 0) as mediana,
          COALESCE(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY venta_hora), 0) as q3,
          COALESCE(MAX(venta_hora), 0) as max,
          json_agg(venta_hora) as raw_data
      FROM ventas_por_turno
      GROUP BY tipo_jornada
    `;

    const result = await pool.query(query, params);

    // Preparar respuesta estructurada
    const fullStats = result.rows.find(
      (r) => r.tipo_jornada === "Full Time",
    ) || {
      min: 0,
      q1: 0,
      mediana: 0,
      q3: 0,
      max: 0,
      raw_data: [],
      n_muestras: 0,
      promedio_hora: 0,
    };
    const partStats = result.rows.find(
      (r) => r.tipo_jornada === "Part Time",
    ) || {
      min: 0,
      q1: 0,
      mediana: 0,
      q3: 0,
      max: 0,
      raw_data: [],
      n_muestras: 0,
      promedio_hora: 0,
    };

    const mannWhitney = calculateMannWhitney(
      fullStats.raw_data || [],
      partStats.raw_data || [],
    );

    res.json({
      full: fullStats,
      part: partStats,
      mann_whitney: mannWhitney,
    });
  } catch (err) {
    console.error("Error en /eficiencia:", err);
    res.status(500).json({ error: err.message });
  }
});

// 6. MAPA DE STANDS - Visualización geográfica de ventas
router.get("/mapa-stands", auth, async (req, res) => {
  try {
    const { rol, zona_id } = req.user;
    const { periodo_id, stand_id, plan_id, forma_pago_id, promotor_id } =
      req.query;

    const params = [];
    let whereConditions = [];
    let joinPeriodos = "";

    // 1. Filtro de Periodo
    if (periodo_id) {
      whereConditions.push(`j.periodo_id = $${params.length + 1}`);
      params.push(periodo_id);
    } else {
      // Default: Periodos Activos
      whereConditions.push(`p.estado = 'Activo'`);
      joinPeriodos = `JOIN periodos p ON j.periodo_id = p.id`;
    }

    // 2. Filtro de Zona (Permisos)
    if (rol === "Lider") {
      whereConditions.push(`s.zona_id = $${params.length + 1}`);
      params.push(zona_id);
    }

    // 3. Filtro de Stand (Opcional)
    if (stand_id) {
      whereConditions.push(`s.id = $${params.length + 1}`);
      params.push(stand_id);
    }

    // 4. Filtro de Plan (Opcional)
    if (plan_id) {
      whereConditions.push(`v.plan_id = $${params.length + 1}`);
      params.push(plan_id);
    }

    // 5. Filtro de Forma de Pago (Opcional)
    if (forma_pago_id) {
      whereConditions.push(`v.forma_pago_id = $${params.length + 1}`);
      params.push(forma_pago_id);
    }

    // 6. Filtro de Promotor (Opcional)
    if (promotor_id) {
      whereConditions.push(`jp.promotor_id = $${params.length + 1}`);
      params.push(promotor_id);
    }

    // Solo stands con ubicación válida
    whereConditions.push(`s.ubicacion_lat IS NOT NULL`);
    whereConditions.push(`s.ubicacion_lng IS NOT NULL`);

    const whereClause =
      whereConditions.length > 0
        ? `WHERE ${whereConditions.join(" AND ")}`
        : "";

    const query = `
      SELECT 
        s.id,
        s.nombre,
        s.ubicacion_lat,
        s.ubicacion_lng,
        z.nombre as zona_nombre,
        COALESCE(SUM(v.monto) FILTER (WHERE v.estado IN ('CARGADO', 'PENDIENTE')), 0) as total_ventas,
        COALESCE(SUM(v.monto), 0) as total_ventas_planilladas,
        COUNT(v.id) as total_fichas,
        COUNT(DISTINCT jp.promotor_id) as total_promotores
      FROM stands s
      JOIN zonas z ON s.zona_id = z.id
      LEFT JOIN jornada_promotores jp ON s.id = ANY(jp.stands_ids)
      LEFT JOIN jornadas j ON jp.jornada_id = j.id
      ${joinPeriodos}
      LEFT JOIN ventas v ON v.jornada_promotor_id = jp.id
      ${whereClause}
      GROUP BY s.id, s.nombre, s.ubicacion_lat, s.ubicacion_lng, z.nombre
      HAVING s.ubicacion_lat IS NOT NULL AND s.ubicacion_lng IS NOT NULL
      ORDER BY total_ventas DESC
    `;

    const result = await pool.query(query, params);

    // Obtener lista de periodos para el selector (filtrado por zona si es Líder)
    let periodosQuery = `SELECT id, nombre, estado FROM periodos`;
    let periodosParams = [];
    if (rol === "Lider") {
      periodosQuery += ` WHERE zona_id = $1`;
      periodosParams.push(zona_id);
    }
    periodosQuery += ` ORDER BY fecha_inicio DESC`;
    const periodosResult = await pool.query(periodosQuery, periodosParams);

    // Obtener listas para filtros
    let standsQuery = `SELECT id, nombre FROM stands WHERE ubicacion_lat IS NOT NULL AND ubicacion_lng IS NOT NULL`;
    let standsParams = [];
    if (rol === "Lider") {
      standsQuery += ` AND zona_id = $1`;
      standsParams.push(zona_id);
    }
    standsQuery += ` ORDER BY nombre`;
    const standsResult = await pool.query(standsQuery, standsParams);

    const planesResult = await pool.query(
      `SELECT id, nombre FROM planes ORDER BY nombre`,
    );
    const formasPagoResult = await pool.query(
      `SELECT id, nombre FROM formas_pago ORDER BY nombre`,
    );

    let promotoresQuery = `SELECT DISTINCT pr.id, pr.nombre_completo FROM promotores pr`;
    let promotoresParams = [];
    if (rol === "Lider") {
      promotoresQuery += ` WHERE pr.zona_id = $1`;
      promotoresParams.push(zona_id);
    }
    promotoresQuery += ` ORDER BY pr.nombre_completo`;
    const promotoresResult = await pool.query(
      promotoresQuery,
      promotoresParams,
    );

    res.json({
      stands: result.rows,
      filtros: {
        periodos: periodosResult.rows,
        stands: standsResult.rows,
        planes: planesResult.rows,
        formas_pago: formasPagoResult.rows,
        promotores: promotoresResult.rows,
      },
    });
  } catch (err) {
    console.error("Error en /mapa-stands:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
