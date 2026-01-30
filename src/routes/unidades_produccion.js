const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");
const verifyRole = require("../middleware/roles");

router.get(
  "/",
  auth,
  verifyRole(["Administrador", "Lider", "Visualizador"]),
  async (req, res) => {
    try {
      const result = await pool.query(
        "SELECT * FROM unidades_produccion WHERE deleted_at IS NULL ORDER BY numero_certificado ASC",
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

router.post("/", auth, verifyRole(["Administrador"]), async (req, res) => {
  const { numero_certificado, fecha_vencimiento, codigo_especie, estado } =
    req.body;
  try {
    const result = await pool.query(
      "INSERT INTO unidades_produccion (numero_certificado, fecha_vencimiento, codigo_especie, estado) VALUES ($1, $2, $3, $4) RETURNING *",
      [numero_certificado, fecha_vencimiento, codigo_especie, estado],
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/:id", auth, verifyRole(["Administrador"]), async (req, res) => {
  const { id } = req.params;
  const { numero_certificado, fecha_vencimiento, codigo_especie, estado } =
    req.body;
  try {
    await pool.query(
      "UPDATE unidades_produccion SET numero_certificado = $1, fecha_vencimiento = $2, codigo_especie = $3, estado = $4 WHERE id = $5 AND deleted_at IS NULL",
      [numero_certificado, fecha_vencimiento, codigo_especie, estado, id],
    );
    res.json({ message: "Unidad de producción actualizada" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/:id", auth, verifyRole(["Administrador"]), async (req, res) => {
  try {
    await pool.query(
      "UPDATE unidades_produccion SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1",
      [req.params.id],
    );
    res.json({ message: "Unidad de producción eliminada" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
