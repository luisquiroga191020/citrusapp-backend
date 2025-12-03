const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");
const verifyRole = require("../middleware/roles");

// ================================================================
// 1. LISTAR TODOS LOS PERIODOS (Para la vista de Gestión)
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
// 2. CREAR PERIODO + ASIGNAR PROMOTORES (Transacción)
// ================================================================
router.post(
  "/",
  auth,
  verifyRole(["Administrador", "Lider"]),
  async (req, res) => {
    const client = await pool.connect(); // Usamos cliente para transacción
    try {
      await client.query("BEGIN"); // Iniciar transacción

      const {
        nombre,
        zona_id,
        fecha_inicio,
        fecha_fin,
        dias_operativos,
        estado,
        promotores,
      } = req.body;
      // 'promotores' es un array: [{ id, objetivo, tipo_jornada }, ...]

      // Validación de seguridad para Lider (No puede crear en otra zona)
      if (req.user.rol === "Lider" && req.user.zona_id !== zona_id) {
        throw new Error("No tienes permisos para crear periodos en esta zona.");
      }

      // A. Insertar el Periodo
      const periodRes = await client.query(
        `INSERT INTO periodos (nombre, zona_id, fecha_inicio, fecha_fin, dias_operativos, estado) 
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [nombre, zona_id, fecha_inicio, fecha_fin, dias_operativos, estado]
      );
      const periodoId = periodRes.rows[0].id;

      // B. Asignar Promotores (Loop)
      if (promotores && promotores.length > 0) {
        for (const p of promotores) {
          await client.query(
            `INSERT INTO periodo_promotores (periodo_id, promotor_id, tipo_jornada, objetivo)
                     VALUES ($1, $2, $3, $4)`,
            [periodoId, p.id, p.tipo_jornada, p.objetivo]
          );
        }
      }

      await client.query("COMMIT"); // Confirmar cambios
      res.json({ message: "Periodo creado exitosamente", id: periodoId });
    } catch (e) {
      await client.query("ROLLBACK"); // Deshacer cambios si falla
      console.error(e);
      res.status(500).json({ error: e.message || "Error al crear periodo" });
    } finally {
      client.release();
    }
  }
);

// ================================================================
// 3. OBTENER PERIODO ACTIVO POR ZONA (Para iniciar Jornada)
// ================================================================
router.get("/activo/:zona_id", auth, async (req, res) => {
  const { zona_id } = req.params;
  try {
    // A. Buscar periodo activo donde la fecha actual esté en rango
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

    // B. Obtener los promotores asignados a este periodo (con sus datos maestros)
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

    // Devolvemos el periodo con la lista de promotores lista para usar
    res.json({ ...periodo, promotores: promotoresRes.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ================================================================
// 4. ELIMINAR PERIODO
// ================================================================
router.delete(
  "/:id",
  auth,
  verifyRole(["Administrador", "Lider"]),
  async (req, res) => {
    try {
      // Al borrar el periodo, se borran los periodo_promotores por el ON DELETE CASCADE de la DB.
      // Pero si hay jornadas creadas, fallará (lo cual es correcto para integridad).
      await pool.query("DELETE FROM periodos WHERE id = $1", [req.params.id]);
      res.json({ message: "Periodo eliminado correctamente" });
    } catch (err) {
      res
        .status(500)
        .json({
          error:
            "No se puede eliminar: Probablemente ya existan jornadas cargadas en este periodo.",
        });
    }
  }
);

module.exports = router;
