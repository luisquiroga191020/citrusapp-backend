const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");
const verifyRole = require("../middleware/roles");

// 1. RESUMEN GLOBAL (KPIs)
router.get("/dashboard", auth, async (req, res) => {
  try {
    const { zona_id, rol } = req.user;

    // Filtro de zona para líderes
    const zonaFilter = rol === "Lider" ? `AND z.id = '${zona_id}'` : "";
    const zonaFilterJoin =
      rol === "Lider"
        ? `JOIN jornadas j ON v.jornada_id = j.id WHERE j.zona_id = '${zona_id}' AND`
        : "WHERE";

    const query = `
            SELECT
                -- 1. Ventas del Mes Actual
                (SELECT COALESCE(SUM(monto), 0) 
                 FROM ventas v 
                 LEFT JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id
                 LEFT JOIN jornadas j ON jp.jornada_id = j.id
                 WHERE v.created_at >= date_trunc('month', CURRENT_DATE)
                 ${rol === "Lider" ? `AND j.zona_id = '${zona_id}'` : ""}
                ) as ventas_mes,

                -- 2. Fichas del Mes
                (SELECT COUNT(*) 
                 FROM ventas v 
                 LEFT JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id
                 LEFT JOIN jornadas j ON jp.jornada_id = j.id
                 WHERE v.created_at >= date_trunc('month', CURRENT_DATE)
                 ${rol === "Lider" ? `AND j.zona_id = '${zona_id}'` : ""}
                ) as fichas_mes,

                -- 3. Promotores Activos HOY
                (SELECT COUNT(DISTINCT jp.promotor_id) 
                 FROM jornada_promotores jp 
                 JOIN jornadas j ON jp.jornada_id = j.id 
                 WHERE j.fecha = CURRENT_DATE
                 ${rol === "Lider" ? `AND j.zona_id = '${zona_id}'` : ""}
                ) as activos_hoy,

                -- 4. Objetivo Global del Periodo Activo
                (SELECT COALESCE(SUM(pp.objetivo), 0) 
                 FROM periodo_promotores pp 
                 JOIN periodos p ON pp.periodo_id = p.id 
                 WHERE p.estado = 'Activo' 
                 AND CURRENT_DATE BETWEEN p.fecha_inicio AND p.fecha_fin
                 ${rol === "Lider" ? `AND p.zona_id = '${zona_id}'` : ""}
                ) as objetivo_global
        `;

    const result = await pool.query(query);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. RANKING (Actualizado con filtros de zona)
router.get("/ranking", auth, async (req, res) => {
  try {
    const { rol, zona_id } = req.user;

    let query = `
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
                            j.tipo as tipo_jornada,
                            z.nombre as nombre_zona
                        FROM promotores pr
                        JOIN periodo_promotores pp ON pp.promotor_id = pr.id
                        JOIN periodos p ON pp.periodo_id = p.id
                        LEFT JOIN jornada_promotores jp ON jp.promotor_id = pr.id
                        LEFT JOIN jornadas j ON (jp.jornada_id = j.id AND j.periodo_id = p.id)
                        LEFT JOIN ventas v ON v.jornada_promotor_id = jp.id
                        LEFT JOIN zonas z ON j.zona_id = z.id
                        WHERE p.estado = 'Activo'
                    `;
            
                if (rol === "Lider") {
                  query += ` AND z.id = '${zona_id}'`;
                }
            
                query += `
                        GROUP BY pr.id, pr.nombre_completo, pr.foto_url, pp.objetivo, COALESCE(j.tipo, 'N/A'), COALESCE(z.nombre, 'Sin Zona')
                        ORDER BY venta_real DESC
                        LIMIT 10
                    
        `;

    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. GRÁFICO SEMANAL
router.get("/semanal", auth, async (req, res) => {
  try {
    const { rol, zona_id } = req.user;
    let query = `
            SELECT TO_CHAR(v.created_at, 'DD/MM') as dia, SUM(v.monto) as total
            FROM ventas v
            LEFT JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id
            LEFT JOIN jornadas j ON jp.jornada_id = j.id
            WHERE v.created_at >= CURRENT_DATE - INTERVAL '7 days'
        `;
    if (rol === "Lider") query += ` AND j.zona_id = '${zona_id}'`;

    query += ` GROUP BY 1 ORDER BY MIN(v.created_at) ASC`;

    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. GRÁFICO PLANES
router.get("/planes", auth, async (req, res) => {
  try {
    const { rol, zona_id } = req.user;
    let query = `
            SELECT pl.nombre, COUNT(v.id) as cantidad
            FROM ventas v
            JOIN planes pl ON v.plan_id = pl.id
            LEFT JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id
            LEFT JOIN jornadas j ON jp.jornada_id = j.id
            WHERE v.created_at >= date_trunc('month', CURRENT_DATE)
        `;
    if (rol === "Lider") query += ` AND j.zona_id = '${zona_id}'`;

    query += ` GROUP BY pl.nombre`;

    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
