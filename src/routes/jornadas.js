const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");
const verifyRole = require("../middleware/roles");

// ==========================================
// 1. LISTAR JORNADAS (Historial)
// ==========================================
router.get("/", auth, async (req, res) => {
  try {
    const { rol, zona_id } = req.user;
    let query = `
            SELECT 
                j.id, 
                j.fecha, 
                j.created_at,
                z.nombre as zona_nombre,
                p.nombre as periodo_nombre,
                u.nombre_completo as creador,
                -- Subconsulta: Total Dinero de la jornada
                (
                    SELECT COALESCE(SUM(v.monto), 0)
                    FROM ventas v
                    JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id
                    WHERE jp.jornada_id = j.id
                ) as total_ventas,
                -- Subconsulta: Total Fichas de la jornada
                (
                    SELECT COUNT(v.id)
                    FROM ventas v
                    JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id
                    WHERE jp.jornada_id = j.id
                ) as total_fichas,
                -- Subconsulta: Cantidad de promotores trabajando ese día
                (
                    SELECT COUNT(*)
                    FROM jornada_promotores jp
                    WHERE jp.jornada_id = j.id
                ) as promotores_activos
            FROM jornadas j
            JOIN zonas z ON j.zona_id = z.id
            JOIN periodos p ON j.periodo_id = p.id
            JOIN usuarios u ON j.created_by = u.id
        `;

    const params = [];

    // FILTRO DE SEGURIDAD: Si es Lider, solo ve su zona
    if (rol === "Lider") {
      query += " WHERE j.zona_id = $1";
      params.push(zona_id);
    }

    query += " ORDER BY j.fecha DESC, j.created_at DESC";

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al listar jornadas" });
  }
});

// ==========================================
// 2. CREAR JORNADA (Operativa Diaria)
// ==========================================
router.post(
  "/",
  auth,
  verifyRole(["Administrador", "Lider"]),
  async (req, res) => {
    const client = await pool.connect();
    try {
      const { fecha, periodo_id, zona_id, asignaciones } = req.body;
      // asignaciones espera ser un array: [{ promotor_id: uuid, stand_id: uuid }, ...]

      // Validación de seguridad para Lider
      if (req.user.rol === "Lider" && req.user.zona_id !== zona_id) {
        throw new Error(
          "No puedes crear jornadas en una zona que no es la tuya."
        );
      }

      await client.query("BEGIN"); // Iniciar transacción

      // 1. Insertar la Cabecera de la Jornada
      const jornadaRes = await client.query(
        `INSERT INTO jornadas (fecha, periodo_id, zona_id, created_by) 
             VALUES ($1, $2, $3, $4) RETURNING id`,
        [fecha, periodo_id, zona_id, req.user.id]
      );
      const jornadaId = jornadaRes.rows[0].id;

      // 2. Insertar los Promotores y sus Stands para este día
      if (asignaciones && asignaciones.length > 0) {
        for (const asign of asignaciones) {
          // Solo insertamos si vienen los datos necesarios
          if (asign.promotor_id && asign.stand_id) {
            await client.query(
              `INSERT INTO jornada_promotores (jornada_id, promotor_id, stand_id)
                         VALUES ($1, $2, $3)`,
              [jornadaId, asign.promotor_id, asign.stand_id]
            );
          }
        }
      }

      await client.query("COMMIT"); // Confirmar transacción
      res.json({ message: "Jornada creada exitosamente", id: jornadaId });
    } catch (err) {
      await client.query("ROLLBACK"); // Cancelar si algo falla
      console.error(err);
      // Manejar error de duplicado (Unique constraint)
      if (err.code === "23505") {
        return res.status(400).json({
          error:
            "Ya existe una jornada o asignación duplicada para esta fecha.",
        });
      }
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  }
);

// ==========================================
// 3. DETALLE JORNADA (Para cargar ventas)
// ==========================================
router.get("/:id", auth, async (req, res) => {
  const { id } = req.params; // ID de la Jornada
  try {
    // A. Datos Generales
    const cabeceraQuery = `
            SELECT j.*, z.nombre as zona_nombre, p.nombre as periodo_nombre
            FROM jornadas j
            JOIN zonas z ON j.zona_id = z.id
            JOIN periodos p ON j.periodo_id = p.id
            WHERE j.id = $1
        `;
    const cabeceraRes = await pool.query(cabeceraQuery, [id]);

    if (cabeceraRes.rows.length === 0)
      return res.status(404).json({ error: "Jornada no encontrada" });

    // B. Promotores trabajando hoy (Pivot Table) + Sus totales
    // Esta query es vital para la UI de carga de ventas
    const promotoresQuery = `
            SELECT 
                jp.id as jornada_promotor_id, -- ESTE ID ES EL QUE SE USA PARA INSERTAR VENTA
                pr.nombre_completo,
                pr.foto_url,
                s.nombre as stand_nombre,
                pp.tipo_jornada,
                pp.objetivo as objetivo_mensual,
                -- Totales individuales del día
                (SELECT COUNT(*) FROM ventas v WHERE v.jornada_promotor_id = jp.id) as fichas_hoy,
                (SELECT COALESCE(SUM(monto),0) FROM ventas v WHERE v.jornada_promotor_id = jp.id) as venta_hoy
            FROM jornada_promotores jp
            JOIN promotores pr ON jp.promotor_id = pr.id
            JOIN stands s ON jp.stand_id = s.id
            -- Traemos datos del periodo para saber si es FullTime/PartTime
            JOIN jornadas j ON jp.jornada_id = j.id
            JOIN periodo_promotores pp ON (pp.periodo_id = j.periodo_id AND pp.promotor_id = jp.promotor_id)
            WHERE jp.jornada_id = $1
            ORDER BY pr.nombre_completo ASC
        `;
    const promotoresRes = await pool.query(promotoresQuery, [id]);

    // C. Listado de Ventas (Detalle completo para tabla inferior)
    const ventasQuery = `
            SELECT 
                v.id, v.codigo_ficha, v.monto, v.created_at,
                pl.nombre as plan_nombre,
                fp.nombre as forma_pago,
                pr.nombre_completo as promotor
            FROM ventas v
            JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id
            JOIN promotores pr ON jp.promotor_id = pr.id
            JOIN planes pl ON v.plan_id = pl.id
            JOIN formas_pago fp ON v.forma_pago_id = fp.id
            WHERE jp.jornada_id = $1
            ORDER BY v.created_at DESC
        `;
    const ventasRes = await pool.query(ventasQuery, [id]);

    res.json({
      jornada: cabeceraRes.rows[0],
      promotores: promotoresRes.rows,
      ventas: ventasRes.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 4. REGISTRAR VENTA
// ==========================================
router.post("/ventas", auth, async (req, res) => {
  // Nota: Recibimos jornada_promotor_id, NO el id del promotor ni de la jornada directos.
  // Esto asegura integridad referencial (solo se vende si trabajó ese día).
  const { jornada_promotor_id, plan_id, forma_pago_id, monto, codigo_ficha } =
    req.body;

  try {
    const result = await pool.query(
      `INSERT INTO ventas (jornada_promotor_id, plan_id, forma_pago_id, monto, codigo_ficha)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [jornada_promotor_id, plan_id, forma_pago_id, monto, codigo_ficha]
    );
    res.json({ message: "Venta registrada", id: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al registrar la venta" });
  }
});

// ==========================================
// 5. ELIMINAR VENTA
// ==========================================
router.delete(
  "/ventas/:id",
  auth,
  verifyRole(["Administrador", "Lider"]),
  async (req, res) => {
    try {
      await pool.query("DELETE FROM ventas WHERE id = $1", [req.params.id]);
      res.json({ message: "Venta eliminada correctamente" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
