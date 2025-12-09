const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");
const verifyRole = require("../middleware/roles");

// ... (Las rutas GET, POST, PUT, DELETE para el ABM de periodos se mantienen igual que antes) ...
// ... (Aquí iría el código del ABM que te pasé en la respuesta anterior) ...

// ================================================================
// NUEVO: DASHBOARD DETALLADO DEL PERIODO
// ================================================================
router.get("/:id/dashboard", auth, async (req, res) => {
  const { id } = req.params;
  try {
    // --- 1. DATOS DEL PERIODO ACTUAL ---
    const periodoActualRes = await pool.query(
      "SELECT * FROM periodos WHERE id = $1",
      [id]
    );
    if (periodoActualRes.rows.length === 0)
      return res.status(404).json({ error: "Periodo no encontrado" });
    const periodoActual = periodoActualRes.rows[0];

    // --- 2. KPI's PRINCIPALES DEL PERIODO ACTUAL ---
    const kpiQuery = `
            SELECT 
                (SELECT COUNT(DISTINCT j.fecha) FROM jornadas j WHERE j.periodo_id = p.id) as dias_cargados,
                COALESCE(SUM(v.monto), 0)::int as total_ventas,
                COUNT(v.id)::int as total_fichas,
                -- Desglose por pago
                COALESCE(SUM(v.monto) FILTER (WHERE fp.tipo = 'Efectivo'), 0)::int as ventas_efectivo,
                COALESCE(SUM(v.monto) FILTER (WHERE fp.tipo != 'Efectivo'), 0)::int as ventas_debito,
                COUNT(v.id) FILTER (WHERE fp.tipo = 'Efectivo')::int as fichas_efectivo,
                COUNT(v.id) FILTER (WHERE fp.tipo != 'Efectivo')::int as fichas_debito,
                -- Desglose por tipo de jornada
                COALESCE(SUM(v.monto) FILTER (WHERE pp.tipo_jornada = 'Part Time'), 0)::int as ventas_part_time,
                COALESCE(SUM(v.monto) FILTER (WHERE pp.tipo_jornada = 'Full Time'), 0)::int as ventas_full_time,
                COUNT(v.id) FILTER (WHERE pp.tipo_jornada = 'Part Time')::int as fichas_part_time,
                COUNT(v.id) FILTER (WHERE pp.tipo_jornada = 'Full Time')::int as fichas_full_time
            FROM periodos p
            LEFT JOIN jornadas j ON j.periodo_id = p.id
            LEFT JOIN jornada_promotores jp ON jp.jornada_id = j.id
            LEFT JOIN ventas v ON v.jornada_promotor_id = jp.id
            LEFT JOIN formas_pago fp ON v.forma_pago_id = fp.id
            LEFT JOIN periodo_promotores pp ON (pp.periodo_id = p.id AND pp.promotor_id = jp.promotor_id)
            WHERE p.id = $1
            GROUP BY p.id
        `;
    const kpiRes = await pool.query(kpiQuery, [id]);
    const kpis = kpiRes.rows[0] || {};
    kpis.avg_importe_ficha =
      kpis.total_fichas > 0
        ? Math.round(kpis.total_ventas / kpis.total_fichas)
        : 0;

    // --- 3. LISTA DE PROMOTORES ASIGNADOS AL PERIODO (con sus totales) ---
    const promotoresQuery = `
            SELECT 
                pr.id, pr.nombre_completo, pr.foto_url,
                pp.objetivo, pp.tipo_jornada,
                COALESCE(SUM(v.monto), 0)::int as venta_total_periodo,
                COUNT(v.id)::int as fichas_total_periodo
            FROM periodo_promotores pp
            JOIN promotores pr ON pp.promotor_id = pr.id
            LEFT JOIN jornada_promotores jp ON jp.promotor_id = pr.id AND jp.jornada_id IN (SELECT id FROM jornadas WHERE periodo_id = pp.periodo_id)
            LEFT JOIN ventas v ON v.jornada_promotor_id = jp.id
            WHERE pp.periodo_id = $1
            GROUP BY pr.id, pp.objetivo, pp.tipo_jornada
            ORDER BY venta_total_periodo DESC
        `;
    const promotoresRes = await pool.query(promotoresQuery, [id]);

    // --- 4. LISTA DE JORNADAS DEL PERIODO ---
    const jornadasQuery = `
            SELECT 
                j.id, j.fecha,
                (SELECT COUNT(*) FROM jornada_promotores WHERE jornada_id = j.id) as promotores_activos,
                (SELECT COALESCE(SUM(monto), 0)::int FROM ventas v JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id WHERE jp.jornada_id = j.id) as venta_del_dia
            FROM jornadas j
            WHERE j.periodo_id = $1
            ORDER BY j.fecha DESC
        `;
    const jornadasRes = await pool.query(jornadasQuery, [id]);

    // --- 5. COMPARACIÓN CON PERIODO ANTERIOR ---
    let kpisAnterior = null;
    // Buscamos el periodo de la misma zona que terminó justo antes de que este empezara
    const periodoAnteriorRes = await pool.query(
      `
            SELECT id FROM periodos 
            WHERE zona_id = $1 AND fecha_fin < $2 
            ORDER BY fecha_fin DESC 
            LIMIT 1
        `,
      [periodoActual.zona_id, periodoActual.fecha_inicio]
    );

    if (periodoAnteriorRes.rows.length > 0) {
      const idAnterior = periodoAnteriorRes.rows[0].id;
      const kpiAnteriorRes = await pool.query(kpiQuery, [idAnterior]); // Reutilizamos la query de KPIs
      kpisAnterior = kpiAnteriorRes.rows[0];
      if (kpisAnterior) {
        kpisAnterior.avg_importe_ficha =
          kpisAnterior.total_fichas > 0
            ? Math.round(kpisAnterior.total_ventas / kpisAnterior.total_fichas)
            : 0;
      }
    }

    // --- RESPUESTA FINAL ---
    res.json({
      periodo: periodoActual,
      kpis: kpis,
      promotores: promotoresRes.rows,
      jornadas: jornadasRes.rows,
      comparacion: kpisAnterior, // Será null si no hay periodo anterior
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
