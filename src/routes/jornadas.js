const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");
const verifyRole = require("../middleware/roles");

// 1. LISTAR JORNADAS
router.get(
  "/",
  auth,
  verifyRole(["Administrador", "Lider", "Visualizador"]),
  async (req, res) => {
    try {
      const { rol, zona_id } = req.user;
      let query = `
            SELECT 
                j.id, j.fecha, j.created_at, 
                z.nombre as zona_nombre, 
                p.nombre as periodo_nombre,
                u.nombre_completo as creador,
                (SELECT COALESCE(SUM(v.monto), 0) FROM ventas v JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id WHERE jp.jornada_id = j.id) as total_ventas,
                (SELECT COUNT(*) FROM jornada_promotores jp WHERE jp.jornada_id = j.id) as promotores_activos,
                (SELECT COUNT(*) FROM ventas v JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id WHERE jp.jornada_id = j.id) as total_fichas
            FROM jornadas j
            JOIN zonas z ON j.zona_id = z.id
            JOIN periodos p ON j.periodo_id = p.id
            JOIN usuarios u ON j.created_by = u.id
        `;
      const params = [];
      if (rol === "Lider") {
        query += " WHERE j.zona_id = $1";
        params.push(zona_id);
      }
      query += " ORDER BY j.fecha DESC";
      const result = await pool.query(query, params);
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

// 2. DETALLE JORNADA
router.get(
  "/:id",
  auth,
  verifyRole(["Administrador", "Lider", "Visualizador"]),
  async (req, res) => {
    try {
      const cabecera = await pool.query(
        `SELECT j.*, z.nombre as zona_nombre, p.nombre as periodo_nombre 
       FROM jornadas j JOIN zonas z ON j.zona_id = z.id JOIN periodos p ON j.periodo_id = p.id 
       WHERE j.id = $1`,
        [req.params.id],
      );

      if (cabecera.rows.length === 0)
        return res.status(404).json({ error: "No existe la jornada" });

      // AQUÍ ESTÁ EL CAMBIO: Traemos los nombres de los stands desde el array de IDs
      const promotores = await pool.query(
        `SELECT 
            jp.id as jornada_promotor_id, 
            jp.promotor_id, 
            jp.stands_ids, -- Array de IDs
            jp.tipo_novedad_id,
            pr.nombre_completo, 
            pr.foto_url, 
            pp.tipo_jornada,
            pp.objetivo as objetivo_mensual,
            -- Subquery para traer nombres de stands concatenados
            (SELECT string_agg(s.nombre, ', ') 
             FROM stands s 
             WHERE s.id = ANY(jp.stands_ids)) as stand_nombre,
             
            (SELECT COALESCE(SUM(monto),0) FROM ventas v WHERE v.jornada_promotor_id = jp.id) as venta_hoy,
            (SELECT COUNT(*)::int FROM ventas v WHERE v.jornada_promotor_id = jp.id) as fichas_hoy
       FROM jornada_promotores jp
       JOIN promotores pr ON jp.promotor_id = pr.id
       JOIN jornadas j ON jp.jornada_id = j.id
       LEFT JOIN periodo_promotores pp ON (pp.periodo_id = j.periodo_id AND pp.promotor_id = jp.promotor_id)
       WHERE jp.jornada_id = $1 
       ORDER BY pr.nombre_completo`,
        [req.params.id],
      );

      const ventas = await pool.query(
        `SELECT v.*, pl.nombre as plan_nombre, fp.nombre as forma_pago, fp.tipo as forma_pago_tipo, pr.nombre_completo as promotor, pr.id as promotor_id
       FROM ventas v
       JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id
       JOIN promotores pr ON jp.promotor_id = pr.id
       JOIN planes pl ON v.plan_id = pl.id
       JOIN formas_pago fp ON v.forma_pago_id = fp.id
       WHERE jp.jornada_id = $1 ORDER BY v.created_at DESC`,
        [req.params.id],
      );

      res.json({
        jornada: cabecera.rows[0],
        promotores: promotores.rows,
        ventas: ventas.rows,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

// 3. CREAR JORNADA
router.post(
  "/",
  auth,
  verifyRole(["Administrador", "Lider"]),
  async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { fecha, periodo_id, zona_id, asignaciones } = req.body;
      // asignaciones ahora trae: { promotor_id, stands_ids: [] }

      if (req.user.rol === "Lider" && req.user.zona_id !== zona_id)
        throw new Error("Sin permisos.");

      const check = await client.query(
        `SELECT id FROM jornadas WHERE zona_id=$1 AND fecha=$2`,
        [zona_id, fecha],
      );
      if (check.rows.length > 0)
        throw new Error("Ya existe una jornada para esta fecha.");

      const jRes = await client.query(
        `INSERT INTO jornadas (fecha, periodo_id, zona_id, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
        [fecha, periodo_id, zona_id, req.user.id],
      );

      for (const a of asignaciones) {
        // Obtener la zona actual del promotor para guardarla como snapshot histórico
        const promotorZona = await client.query(
          `SELECT zona_id FROM promotores WHERE id = $1`,
          [a.promotor_id],
        );
        const promotor_zona_id = promotorZona.rows[0]?.zona_id || null;

        // Guardamos el array de stands Y la zona del promotor en ese momento
        await client.query(
          `INSERT INTO jornada_promotores (jornada_id, promotor_id, stands_ids, zona_id, tipo_novedad_id) VALUES ($1, $2, $3, $4, $5)`,
          [
            jRes.rows[0].id,
            a.promotor_id,
            a.stands_ids,
            promotor_zona_id,
            a.tipo_novedad_id || null,
          ],
        );
      }
      await client.query("COMMIT");
      res.json({ id: jRes.rows[0].id });
    } catch (e) {
      await client.query("ROLLBACK");
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  },
);

// 4. EDITAR JORNADA
router.put(
  "/:id",
  auth,
  verifyRole(["Administrador", "Lider"]),
  async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { id } = req.params;
      const { fecha, asignaciones } = req.body;

      await client.query("UPDATE jornadas SET fecha = $1 WHERE id = $2", [
        fecha,
        id,
      ]);

      const actualesRes = await client.query(
        "SELECT promotor_id, id FROM jornada_promotores WHERE jornada_id = $1",
        [id],
      );
      const actualesMap = new Map(
        actualesRes.rows.map((r) => [r.promotor_id, r.id]),
      );
      const nuevosPromotoresIds = new Set(
        asignaciones.map((a) => a.promotor_id),
      );

      // Borrar removidos
      for (const [promotor_id, jp_id] of actualesMap) {
        if (!nuevosPromotoresIds.has(promotor_id)) {
          await client.query("DELETE FROM jornada_promotores WHERE id = $1", [
            jp_id,
          ]);
        }
      }

      // Upsert
      for (const asign of asignaciones) {
        if (actualesMap.has(asign.promotor_id)) {
          const jp_id = actualesMap.get(asign.promotor_id);
          // Actualizamos solo stands_ids y tipo_novedad_id, NO la zona (preservamos el historial)
          await client.query(
            "UPDATE jornada_promotores SET stands_ids = $1, tipo_novedad_id = $2 WHERE id = $3",
            [asign.stands_ids, asign.tipo_novedad_id || null, jp_id],
          );
        } else {
          // Nuevo promotor agregado: obtener su zona actual
          const promotorZona = await client.query(
            `SELECT zona_id FROM promotores WHERE id = $1`,
            [asign.promotor_id],
          );
          const promotor_zona_id = promotorZona.rows[0]?.zona_id || null;

          await client.query(
            "INSERT INTO jornada_promotores (jornada_id, promotor_id, stands_ids, zona_id, tipo_novedad_id) VALUES ($1, $2, $3, $4, $5)",
            [
              id,
              asign.promotor_id,
              asign.stands_ids,
              promotor_zona_id,
              asign.tipo_novedad_id || null,
            ],
          );
        }
      }

      await client.query("COMMIT");
      res.json({ message: "Actualizado" });
    } catch (e) {
      await client.query("ROLLBACK");
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  },
);

router.post(
  "/ventas",
  auth,
  verifyRole(["Administrador", "Lider"]),
  async (req, res) => {
    const {
      jornada_promotor_id,
      plan_id,
      forma_pago_id,
      monto,
      codigo_ficha,
      tipo,
    } = req.body;
    try {
      await pool.query(
        `INSERT INTO ventas (jornada_promotor_id, plan_id, forma_pago_id, monto, codigo_ficha, tipo, estado) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          jornada_promotor_id,
          plan_id,
          forma_pago_id,
          monto,
          codigo_ficha,
          tipo || "individual",
          "CARGADO",
        ],
      );
      res.json({ message: "Registrada" });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

router.put(
  "/ventas/:id",
  auth,
  verifyRole(["Administrador", "Lider"]),
  async (req, res) => {
    const { plan_id, forma_pago_id, monto, codigo_ficha, tipo, estado } =
      req.body;
    try {
      if (req.user.rol === "Administrador") {
        await pool.query(
          `UPDATE ventas SET plan_id=$1, forma_pago_id=$2, monto=$3, codigo_ficha=$4, tipo=$5, estado=$6 WHERE id=$7`,
          [
            plan_id,
            forma_pago_id,
            monto,
            codigo_ficha,
            tipo || "individual",
            estado,
            req.params.id,
          ],
        );
      } else {
        await pool.query(
          `UPDATE ventas SET plan_id=$1, forma_pago_id=$2, monto=$3, codigo_ficha=$4, tipo=$5 WHERE id=$6`,
          [
            plan_id,
            forma_pago_id,
            monto,
            codigo_ficha,
            tipo || "individual",
            req.params.id,
          ],
        );
      }
      res.json({ message: "Actualizada" });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

router.delete(
  "/ventas/:id",
  auth,
  verifyRole(["Administrador", "Lider"]),
  async (req, res) => {
    try {
      await pool.query("DELETE FROM ventas WHERE id = $1", [req.params.id]);
      res.json({ message: "Eliminada" });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

router.put(
  "/promotores/:jp_id/novedad",
  auth,
  verifyRole(["Administrador"]),
  async (req, res) => {
    const { tipo_novedad_id } = req.body;
    try {
      await pool.query(
        "UPDATE jornada_promotores SET tipo_novedad_id = $1 WHERE id = $2",
        [tipo_novedad_id || null, req.params.jp_id],
      );
      res.json({ message: "Novedad actualizada" });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

module.exports = router;
