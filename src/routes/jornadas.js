const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");
const verifyRole = require("../middleware/roles");

// 1. LISTAR JORNADAS
router.get("/", auth, async (req, res) => {
  try {
    const { rol, zona_id } = req.user;
    let query = `
            SELECT j.id, j.fecha, j.created_at, z.nombre as zona_nombre, p.nombre as periodo_nombre,
            (SELECT COALESCE(SUM(v.monto), 0) FROM ventas v JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id WHERE jp.jornada_id = j.id) as total_ventas,
            (SELECT COUNT(*) FROM jornada_promotores jp WHERE jp.jornada_id = j.id) as promotores_activos
            FROM jornadas j
            JOIN zonas z ON j.zona_id = z.id
            JOIN periodos p ON j.periodo_id = p.id
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
});

// 2. DETALLE JORNADA
router.get("/:id", auth, async (req, res) => {
  try {
    const cabecera = await pool.query(
      `
            SELECT j.*, z.nombre as zona_nombre, p.nombre as periodo_nombre 
            FROM jornadas j 
            JOIN zonas z ON j.zona_id = z.id 
            JOIN periodos p ON j.periodo_id = p.id 
            WHERE j.id = $1`,
      [req.params.id]
    );

    if (cabecera.rows.length === 0)
      return res.status(404).json({ error: "No existe" });

    const promotores = await pool.query(
      `
            SELECT jp.id as jornada_promotor_id, jp.promotor_id, jp.stand_id, pr.nombre_completo, pr.foto_url, s.nombre as stand_nombre,
            (SELECT COALESCE(SUM(monto),0) FROM ventas v WHERE v.jornada_promotor_id = jp.id) as venta_hoy
            FROM jornada_promotores jp
            JOIN promotores pr ON jp.promotor_id = pr.id
            LEFT JOIN stands s ON jp.stand_id = s.id
            WHERE jp.jornada_id = $1 ORDER BY pr.nombre_completo`,
      [req.params.id]
    );

    const ventas = await pool.query(
      `
            SELECT v.*, pl.nombre as plan_nombre, fp.nombre as forma_pago, pr.nombre_completo as promotor, pr.id as promotor_id
            FROM ventas v
            JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id
            JOIN promotores pr ON jp.promotor_id = pr.id
            JOIN planes pl ON v.plan_id = pl.id
            JOIN formas_pago fp ON v.forma_pago_id = fp.id
            WHERE jp.jornada_id = $1 ORDER BY v.created_at DESC`,
      [req.params.id]
    );

    res.json({
      jornada: cabecera.rows[0],
      promotores: promotores.rows,
      ventas: ventas.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

      if (req.user.rol === "Lider" && req.user.zona_id !== zona_id)
        throw new Error("Sin permisos.");

      // Validar duplicado fecha/zona
      const check = await client.query(
        `SELECT id FROM jornadas WHERE zona_id=$1 AND fecha=$2`,
        [zona_id, fecha]
      );
      if (check.rows.length > 0)
        throw new Error("Ya existe una jornada para esta fecha y zona.");

      const jRes = await client.query(
        `INSERT INTO jornadas (fecha, periodo_id, zona_id, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
        [fecha, periodo_id, zona_id, req.user.id]
      );

      for (const a of asignaciones) {
        await client.query(
          `INSERT INTO jornada_promotores (jornada_id, promotor_id, stand_id) VALUES ($1, $2, $3)`,
          [jRes.rows[0].id, a.promotor_id, a.stand_id]
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
  }
);

// 4. EDITAR JORNADA (ESTRUCTURA: Promotores y Stands)
router.put(
  "/:id",
  auth,
  verifyRole(["Administrador", "Lider"]),
  async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { id } = req.params;
      const { fecha, asignaciones } = req.body; // asignaciones: [{promotor_id, stand_id}]

      // 1. Actualizar fecha
      await client.query("UPDATE jornadas SET fecha = $1 WHERE id = $2", [
        fecha,
        id,
      ]);

      // 2. Sincronizar Promotores (Difícil: No borrar todo porque perdemos ventas)

      // A. Obtener asignaciones actuales en BD
      const actualesRes = await client.query(
        "SELECT promotor_id, id FROM jornada_promotores WHERE jornada_id = $1",
        [id]
      );
      const actualesMap = new Map(
        actualesRes.rows.map((r) => [r.promotor_id, r.id])
      ); // Map: promotor_id -> jornada_promotor_id

      const nuevosPromotoresIds = new Set(
        asignaciones.map((a) => a.promotor_id)
      );

      // B. BORRAR los que ya no están (Esto borra sus ventas en cascada)
      for (const [promotor_id, jp_id] of actualesMap) {
        if (!nuevosPromotoresIds.has(promotor_id)) {
          await client.query("DELETE FROM jornada_promotores WHERE id = $1", [
            jp_id,
          ]);
        }
      }

      // C. INSERTAR o ACTUALIZAR
      for (const asign of asignaciones) {
        if (actualesMap.has(asign.promotor_id)) {
          // Ya existe: Actualizamos Stand por si cambió
          const jp_id = actualesMap.get(asign.promotor_id);
          await client.query(
            "UPDATE jornada_promotores SET stand_id = $1 WHERE id = $2",
            [asign.stand_id, jp_id]
          );
        } else {
          // Nuevo: Insertamos
          await client.query(
            "INSERT INTO jornada_promotores (jornada_id, promotor_id, stand_id) VALUES ($1, $2, $3)",
            [id, asign.promotor_id, asign.stand_id]
          );
        }
      }

      await client.query("COMMIT");
      res.json({ message: "Jornada actualizada" });
    } catch (e) {
      await client.query("ROLLBACK");
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  }
);

// 5. CREAR VENTA
router.post("/ventas", auth, async (req, res) => {
  const { jornada_promotor_id, plan_id, forma_pago_id, monto, codigo_ficha } =
    req.body;
  try {
    await pool.query(
      `INSERT INTO ventas (jornada_promotor_id, plan_id, forma_pago_id, monto, codigo_ficha) VALUES ($1, $2, $3, $4, $5)`,
      [jornada_promotor_id, plan_id, forma_pago_id, monto, codigo_ficha]
    );
    res.json({ message: "Registrada" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 6. EDITAR VENTA (NUEVO)
router.put("/ventas/:id", auth, async (req, res) => {
  const { plan_id, forma_pago_id, monto, codigo_ficha } = req.body;
  try {
    await pool.query(
      `UPDATE ventas SET plan_id=$1, forma_pago_id=$2, monto=$3, codigo_ficha=$4 WHERE id=$5`,
      [plan_id, forma_pago_id, monto, codigo_ficha, req.params.id]
    );
    res.json({ message: "Venta actualizada" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 7. BORRAR VENTA
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
  }
);

module.exports = router;
