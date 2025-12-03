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
