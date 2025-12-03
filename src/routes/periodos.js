const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");
const verifyRole = require("../middleware/roles");

// Crear Periodo con Promotores asignados
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

      // Validar zona si es Lider
      if (req.user.rol === "Lider" && req.user.zona_id !== zona_id) {
        throw new Error("No puedes crear periodos en otra zona");
      }

      // 1. Crear Periodo
      const periodRes = await client.query(
        `INSERT INTO periodos (nombre, zona_id, fecha_inicio, fecha_fin, dias_operativos, estado) 
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [nombre, zona_id, fecha_inicio, fecha_fin, dias_operativos, estado]
      );
      const periodoId = periodRes.rows[0].id;

      // 2. Asignar Promotores (Loop)
      // promotores es un array: [{id: 'uuid', tipo_jornada: 'Full Time', objetivo: 500000}, ...]
      for (const p of promotores) {
        await client.query(
          `INSERT INTO periodo_promotores (periodo_id, promotor_id, tipo_jornada, objetivo)
                 VALUES ($1, $2, $3, $4)`,
          [periodoId, p.id, p.tipo_jornada, p.objetivo]
        );
      }

      await client.query("COMMIT");
      res.json({ message: "Periodo creado exitosamente", id: periodoId });
    } catch (e) {
      await client.query("ROLLBACK");
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  }
);

// Obtener Periodo Activo para una Zona (Para crear Jornada)
router.get("/activo/:zona_id", auth, async (req, res) => {
  const { zona_id } = req.params;
  try {
    // Buscar periodo activo donde la fecha actual esté en rango
    const query = `
            SELECT p.* 
            FROM periodos p
            WHERE p.zona_id = $1 
            AND p.estado = 'Activo'
            AND CURRENT_DATE BETWEEN p.fecha_inicio AND p.fecha_fin
            LIMIT 1
        `;
    const result = await pool.query(query, [zona_id]);

    if (result.rows.length === 0) return res.json(null); // No hay periodo activo

    const periodo = result.rows[0];

    // Obtener los promotores asignados a este periodo
    const promotoresQuery = `
            SELECT pp.*, pr.nombre_completo, pr.codigo
            FROM periodo_promotores pp
            JOIN promotores pr ON pp.promotor_id = pr.id
            WHERE pp.periodo_id = $1
        `;
    const promotoresRes = await pool.query(promotoresQuery, [periodo.id]);

    res.json({ ...periodo, promotores: promotoresRes.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
