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
        "SELECT * FROM mercados WHERE deleted_at IS NULL ORDER BY mercado ASC",
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

router.post("/", auth, verifyRole(["Administrador"]), async (req, res) => {
  const { mercado, codigo_mercado } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO mercados (mercado, codigo_mercado) VALUES ($1, $2) RETURNING *",
      [mercado, codigo_mercado],
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/:id", auth, verifyRole(["Administrador"]), async (req, res) => {
  const { id } = req.params;
  const { mercado, codigo_mercado } = req.body;
  try {
    await pool.query(
      "UPDATE mercados SET mercado = $1, codigo_mercado = $2 WHERE id = $3 AND deleted_at IS NULL",
      [mercado, codigo_mercado, id],
    );
    res.json({ message: "Mercado actualizado" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/:id", auth, verifyRole(["Administrador"]), async (req, res) => {
  try {
    await pool.query(
      "UPDATE mercados SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1",
      [req.params.id],
    );
    res.json({ message: "Mercado eliminado" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
