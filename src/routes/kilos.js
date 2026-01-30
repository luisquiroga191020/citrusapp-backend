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
        "SELECT * FROM kilos WHERE deleted_at IS NULL ORDER BY kilo ASC",
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

router.post("/", auth, verifyRole(["Administrador"]), async (req, res) => {
  const { kilo } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO kilos (kilo) VALUES ($1) RETURNING *",
      [kilo],
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/:id", auth, verifyRole(["Administrador"]), async (req, res) => {
  const { id } = req.params;
  const { kilo } = req.body;
  try {
    await pool.query(
      "UPDATE kilos SET kilo = $1 WHERE id = $2 AND deleted_at IS NULL",
      [kilo, id],
    );
    res.json({ message: "Kilo actualizado" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/:id", auth, verifyRole(["Administrador"]), async (req, res) => {
  try {
    await pool.query(
      "UPDATE kilos SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1",
      [req.params.id],
    );
    res.json({ message: "Kilo eliminado" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
