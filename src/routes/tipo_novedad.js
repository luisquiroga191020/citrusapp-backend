const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");
const verifyRole = require("../middleware/roles");

// GET - Listar todos los tipos de novedad
router.get(
  "/",
  auth,
  verifyRole(["Administrador", "Lider", "Visualizador"]),
  async (req, res) => {
    try {
      const result = await pool.query(
        "SELECT * FROM tipo_novedad ORDER BY nombre ASC"
      );
      res.json(result.rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// POST - Crear nuevo tipo de novedad
router.post("/", auth, verifyRole(["Administrador"]), async (req, res) => {
  const { nombre, operativo } = req.body;

  if (!nombre || !operativo) {
    return res.status(400).json({ error: "Faltan campos requeridos" });
  }

  if (!["SI", "NO"].includes(operativo)) {
    return res.status(400).json({ error: "Operativo debe ser SI o NO" });
  }

  try {
    const result = await pool.query(
      "INSERT INTO tipo_novedad (nombre, operativo) VALUES ($1, $2) RETURNING *",
      [nombre, operativo]
    );
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT - Actualizar tipo de novedad
router.put("/:id", auth, verifyRole(["Administrador"]), async (req, res) => {
  const { id } = req.params;
  const { nombre, operativo } = req.body;

  if (!nombre || !operativo) {
    return res.status(400).json({ error: "Faltan campos requeridos" });
  }

  if (!["SI", "NO"].includes(operativo)) {
    return res.status(400).json({ error: "Operativo debe ser SI o NO" });
  }

  try {
    const result = await pool.query(
      "UPDATE tipo_novedad SET nombre = $1, operativo = $2 WHERE id = $3 RETURNING *",
      [nombre, operativo, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Tipo de novedad no encontrado" });
    }

    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE - Eliminar tipo de novedad
router.delete("/:id", auth, verifyRole(["Administrador"]), async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      "DELETE FROM tipo_novedad WHERE id = $1 RETURNING *",
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Tipo de novedad no encontrado" });
    }

    res.json({ message: "Tipo de novedad eliminado" });
  } catch (e) {
    if (e.code === "23503") {
      // Foreign key violation
      return res.status(400).json({
        error:
          "No se puede eliminar. Existen planificaciones que usan este tipo de novedad",
      });
    }
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
