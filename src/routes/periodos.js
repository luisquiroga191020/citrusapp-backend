const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");
const verifyRole = require("../middleware/roles");

// ================================================================
// 1. LISTAR PERIODOS (Vista Gestión)
// ================================================================
router.get("/", auth, async (req, res) => {
  try {
    const { rol, zona_id } = req.user;
    let query = `
            SELECT p.*, z.nombre as zona_nombre 
            FROM periodos p
            JOIN zonas z ON p.zona_id = z.id
        `;

    const params = [];

    // Si es Líder, solo ve los periodos de su zona
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

// ================================================================
// 2. OBTENER UN PERIODO POR ID (Para editar)
// ================================================================
router.get("/:id", auth, async (req, res) => {
  try {
    // Datos del periodo
    const periodoRes = await pool.query(
      "SELECT * FROM periodos WHERE id = $1",
      [req.params.id]
    );
    if (periodoRes.rows.length === 0)
      return res.status(404).json({ error: "Periodo no encontrado" });

    // Promotores asignados a este periodo
    const promotoresRes = await pool.query(
      `
            SELECT pp.promotor_id as id, pp.tipo_jornada, pp.objetivo, pr.nombre_completo 
            FROM periodo_promotores pp
            JOIN promotores pr ON pp.promotor_id = pr.id
            WHERE pp.periodo_id = $1
        `,
      [req.params.id]
    );

    res.json({ ...periodoRes.rows[0], promotores: promotoresRes.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// 3. OBTENER PERIODO ACTIVO POR ZONA (Para iniciar Jornada)
// ================================================================
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

    if (result.rows.length === 0) return res.json(null); // No hay periodo activo hoy

    const periodo = result.rows[0];

    // Obtener los promotores asignados a este periodo con sus datos
    const promotoresQuery = `
            SELECT 
                pp.promotor_id, 
                pp.tipo_jornada, 
                pp.objetivo,
                pr.nombre_completo, 
                pr.codigo
            FROM periodo_promotores pp
            JOIN promotores pr ON pp.promotor_id = pr.id
            WHERE pp.periodo_id = $1
            ORDER BY pr.nombre_completo ASC
        `;
    const promotoresRes = await pool.query(promotoresQuery, [periodo.id]);

    res.json({ ...periodo, promotores: promotoresRes.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ================================================================
// 4. CREAR PERIODO (Transacción)
// ================================================================
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

      // Validación Lider
      if (req.user.rol === "Lider" && req.user.zona_id !== zona_id) {
        throw new Error("No tienes permisos para esta zona.");
      }

      const periodRes = await client.query(
        `INSERT INTO periodos (nombre, zona_id, fecha_inicio, fecha_fin, dias_operativos, estado) 
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [nombre, zona_id, fecha_inicio, fecha_fin, dias_operativos, estado]
      );
      const periodoId = periodRes.rows[0].id;

      if (promotores && promotores.length > 0) {
        for (const p of promotores) {
          await client.query(
            `INSERT INTO periodo_promotores (periodo_id, promotor_id, tipo_jornada, objetivo)
                     VALUES ($1, $2, $3, $4)`,
            [periodoId, p.id, p.tipo_jornada, p.objetivo]
          );
        }
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

// ================================================================
// 5. EDITAR PERIODO (Transacción: Update + Re-insert Promotores)
// ================================================================
router.put(
  "/:id",
  auth,
  verifyRole(["Administrador", "Lider"]),
  async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { id } = req.params;
      const {
        nombre,
        zona_id,
        fecha_inicio,
        fecha_fin,
        dias_operativos,
        estado,
        promotores,
      } = req.body;

      // Validación Lider
      if (req.user.rol === "Lider" && req.user.zona_id !== zona_id) {
        throw new Error("No tienes permisos para esta zona.");
      }

      // 1. Actualizar Periodo
      await client.query(
        `UPDATE periodos SET nombre=$1, zona_id=$2, fecha_inicio=$3, fecha_fin=$4, dias_operativos=$5, estado=$6 WHERE id=$7`,
        [nombre, zona_id, fecha_inicio, fecha_fin, dias_operativos, estado, id]
      );

      // 2. Actualizar Promotores (Borrar viejos e insertar nuevos)
      // Nota: Esto fallará si ya hay jornadas cargadas vinculadas a un promotor que intentas quitar.
      // Postgres lanzará error de Foreign Key, lo cual es correcto para integridad de datos.

      // Borramos asignaciones previas
      await client.query(
        "DELETE FROM periodo_promotores WHERE periodo_id = $1",
        [id]
      );

      // Insertamos las nuevas (que pueden ser las mismas editadas)
      if (promotores && promotores.length > 0) {
        for (const p of promotores) {
          await client.query(
            `INSERT INTO periodo_promotores (periodo_id, promotor_id, tipo_jornada, objetivo)
                     VALUES ($1, $2, $3, $4)`,
            [id, p.id, p.tipo_jornada, p.objetivo]
          );
        }
      }

      await client.query("COMMIT");
      res.json({ message: "Periodo actualizado exitosamente" });
    } catch (e) {
      await client.query("ROLLBACK");
      console.error(e);
      // Manejo de error de clave foránea más amigable
      if (e.code === "23503") {
        res
          .status(400)
          .json({
            error:
              "No se puede quitar un promotor que ya tiene jornadas/ventas cargadas en este periodo.",
          });
      } else {
        res.status(500).json({ error: e.message });
      }
    } finally {
      client.release();
    }
  }
);

// ================================================================
// 6. ELIMINAR PERIODO
// ================================================================
router.delete(
  "/:id",
  auth,
  verifyRole(["Administrador", "Lider"]),
  async (req, res) => {
    try {
      await pool.query("DELETE FROM periodos WHERE id = $1", [req.params.id]);
      res.json({ message: "Periodo eliminado correctamente" });
    } catch (err) {
      res
        .status(500)
        .json({
          error:
            "No se puede eliminar: Probablemente ya existan jornadas cargadas.",
        });
    }
  }
);

module.exports = router;
