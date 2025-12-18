const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");
const verifyRole = require("../middleware/roles");

// 1. OBTENER PLANIFICACIÓN DE UNA FECHA Y ZONA
router.get("/", auth, async (req, res) => {
  const { fecha, zona_id } = req.query;
  try {
    // Si es lider, forzamos su zona
    const zonaFinal = req.user.rol === "Lider" ? req.user.zona_id : zona_id;

    if (!zonaFinal || !fecha)
      return res.status(400).json({ error: "Faltan parámetros" });

    // A. Obtener asignaciones (Promotores en Stands)
    const asignaciones = await pool.query(
      `
            SELECT pv.*, p.nombre_completo, p.foto_url, p.codigo
            FROM planificacion_visual pv
            JOIN promotores p ON pv.promotor_id = p.id
            WHERE pv.fecha = $1 AND pv.zona_id = $2
        `,
      [fecha, zonaFinal]
    );

    // B. Obtener notas de los stands
    const notasStands = await pool.query(
      `
            SELECT ns.stand_id, ns.nota
            FROM planificacion_notas_stand ns
            JOIN stands s ON ns.stand_id = s.id
            WHERE ns.fecha = $1 AND s.zona_id = $2
        `,
      [fecha, zonaFinal]
    );

    res.json({
      asignaciones: asignaciones.rows,
      notasStands: notasStands.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 2. GUARDAR PLANIFICACIÓN (Transacción completa)
router.post("/", auth, verifyRole(["Administrador", "Lider"]), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { fecha, zona_id, asignaciones, notasStands } = req.body;

    // Seguridad de zona
    const zonaFinal = req.user.rol === "Lider" ? req.user.zona_id : zona_id;

    // 1. Limpiar planificación previa de esa zona y fecha (Sobreescribir)
    await client.query(
      `DELETE FROM planificacion_visual WHERE fecha = $1 AND zona_id = $2`,
      [fecha, zonaFinal]
    );

    // Limpiar notas de stands de esa zona y fecha (hacemos un join para borrar solo los de esa zona)
    await client.query(
      `
            DELETE FROM planificacion_notas_stand 
            WHERE fecha = $1 AND stand_id IN (SELECT id FROM stands WHERE zona_id = $2)
        `,
      [fecha, zonaFinal]
    );

    // 2. Insertar nuevas asignaciones
    for (const asig of asignaciones) {
      await client.query(
        `
                INSERT INTO planificacion_visual (fecha, zona_id, stand_id, promotor_id, nota)
                VALUES ($1, $2, $3, $4, $5)
            `,
        [fecha, zonaFinal, asig.stand_id, asig.promotor_id, asig.nota]
      );
    }

    // 3. Insertar notas de stands
    for (const ns of notasStands) {
      if (ns.nota && ns.nota.trim() !== "") {
        await client.query(
          `
                    INSERT INTO planificacion_notas_stand (fecha, stand_id, nota)
                    VALUES ($1, $2, $3)
                `,
          [fecha, ns.stand_id, ns.nota]
        );
      }
    }

    await client.query("COMMIT");
    res.json({ message: "Planificación guardada" });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

module.exports = router;
