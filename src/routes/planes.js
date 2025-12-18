const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");
const verifyRole = require("../middleware/roles");

// 1. LISTAR
router.get("/", auth, verifyRole(["Administrador", "Lider", "Visualizador"]), async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM planes ORDER BY nombre ASC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. CREAR
router.post("/", auth, verifyRole(["Administrador"]), async (req, res) => {
  const { nombre, servicio, tipo } = req.body;
  // servicio ahora llega como array ['Sepelio', 'Salud']
  try {
    const result = await pool.query(
      "INSERT INTO planes (nombre, servicio, tipo) VALUES ($1, $2, $3) RETURNING *",
      [nombre, servicio, tipo]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. EDITAR
router.put("/:id", auth, verifyRole(["Administrador"]), async (req, res) => {
  const { id } = req.params;
  const { nombre, servicio, tipo } = req.body;
  try {
    await pool.query(
      "UPDATE planes SET nombre = $1, servicio = $2, tipo = $3 WHERE id = $4",
      [nombre, servicio, tipo, id]
    );
    res.json({ message: "Plan actualizado" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. ELIMINAR
router.delete("/:id", auth, verifyRole(["Administrador"]), async (req, res) => {
  try {
    await pool.query("DELETE FROM planes WHERE id = $1", [req.params.id]);
    res.json({ message: "Plan eliminado" });
  } catch (err) {
    res
      .status(500)
      .json({ error: "No se puede eliminar (tiene ventas asociadas)" });
  }
});

module.exports = router;
