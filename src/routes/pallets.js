const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");
const verifyRole = require("../middleware/roles");

// 1. LISTAR PALLETS
router.get(
  "/",
  auth,
  verifyRole(["Administrador", "Lider", "Visualizador"]),
  async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT 
            p.*, 
            pr.producto as producto_nombre,
            m.marca as marca_nombre,
            c.categoria as categoria_nombre,
            ca.calibre as calibre_nombre,
            mer.mercado as mercado_nombre,
            k.kilo as kilos_nombre,
            (SELECT COALESCE(SUM(cantidad_cajas), 0) FROM pallet_detalle_cajas WHERE pallet_id = p.id AND deleted_at IS NULL) as total_cajas
        FROM alta_pallets p
        LEFT JOIN productos pr ON p.producto_id = pr.id
        LEFT JOIN marcas m ON p.marca_id = m.id
        LEFT JOIN categorias c ON p.categoria_id = c.id
        LEFT JOIN calibres ca ON p.calibre_id = ca.id
        LEFT JOIN mercados mer ON p.mercado_id = mer.id
        LEFT JOIN kilos k ON p.kilos_id = k.id
        WHERE p.deleted_at IS NULL
        ORDER BY p.fecha DESC, p.created_at DESC
      `);
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

// 2. DETALLE PALLET
router.get(
  "/:id",
  auth,
  verifyRole(["Administrador", "Lider", "Visualizador"]),
  async (req, res) => {
    try {
      const cabecera = await pool.query(
        `
        SELECT 
            p.*, 
            pr.producto as producto_nombre,
            m.marca as marca_nombre,
            c.categoria as categoria_nombre,
            ca.calibre as calibre_nombre,
            mer.mercado as mercado_nombre,
            k.kilo as kilos_nombre
        FROM alta_pallets p
        LEFT JOIN productos pr ON p.producto_id = pr.id
        LEFT JOIN marcas m ON p.marca_id = m.id
        LEFT JOIN categorias c ON p.categoria_id = c.id
        LEFT JOIN calibres ca ON p.calibre_id = ca.id
        LEFT JOIN mercados mer ON p.mercado_id = mer.id
        LEFT JOIN kilos k ON p.kilos_id = k.id
        WHERE p.id = $1 AND p.deleted_at IS NULL
      `,
        [req.params.id],
      );

      if (cabecera.rows.length === 0)
        return res.status(404).json({ error: "No existe el pallet" });

      const detalles = await pool.query(
        `
        SELECT 
            d.*, 
            up.up as up_nombre
        FROM pallet_detalle_cajas d
        LEFT JOIN unidades_produccion up ON d.up_id = up.id
        WHERE d.pallet_id = $1 AND d.deleted_at IS NULL
        ORDER BY d.fecha_produccion DESC, d.created_at DESC
      `,
        [req.params.id],
      );

      res.json({
        pallet: cabecera.rows[0],
        detalles: detalles.rows,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

// 3. CREAR PALLET
router.post(
  "/",
  auth,
  verifyRole(["Administrador", "Lider"]),
  async (req, res) => {
    const {
      numero_pallet,
      fecha,
      producto_id,
      codigo_senasa,
      marca_id,
      categoria_id,
      calibre_id,
      mercado_id,
      kilos_id,
    } = req.body;
    try {
      const result = await pool.query(
        `INSERT INTO alta_pallets (
            numero_pallet, fecha, producto_id, codigo_senasa, 
            marca_id, categoria_id, calibre_id, mercado_id, kilos_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          numero_pallet,
          fecha,
          producto_id,
          codigo_senasa,
          marca_id,
          categoria_id,
          calibre_id,
          mercado_id,
          kilos_id,
        ],
      );
      res.json({ id: result.rows[0].id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

// 4. ACTUALIZAR PALLET
router.put(
  "/:id",
  auth,
  verifyRole(["Administrador", "Lider"]),
  async (req, res) => {
    const { id } = req.params;
    const {
      numero_pallet,
      fecha,
      producto_id,
      codigo_senasa,
      marca_id,
      categoria_id,
      calibre_id,
      mercado_id,
      kilos_id,
    } = req.body;
    try {
      await pool.query(
        `UPDATE alta_pallets SET 
            numero_pallet=$1, fecha=$2, producto_id=$3, codigo_senasa=$4, 
            marca_id=$5, categoria_id=$6, calibre_id=$7, mercado_id=$8, kilos_id=$9,
            updated_at=CURRENT_TIMESTAMP
        WHERE id=$10 AND deleted_at IS NULL`,
        [
          numero_pallet,
          fecha,
          producto_id,
          codigo_senasa,
          marca_id,
          categoria_id,
          calibre_id,
          mercado_id,
          kilos_id,
          id,
        ],
      );
      res.json({ message: "Pallet actualizado" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

// 5. BORRADO LÓGICO PALLET
router.delete(
  "/:id",
  auth,
  verifyRole(["Administrador", "Lider"]),
  async (req, res) => {
    try {
      await pool.query(
        "UPDATE alta_pallets SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1",
        [req.params.id],
      );
      res.json({ message: "Pallet eliminado" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

// --- RUTAS DE DETALLE ---

// 6. AGREGAR DETALLE DE CAJAS
router.post(
  "/detalles",
  auth,
  verifyRole(["Administrador", "Lider"]),
  async (req, res) => {
    const { pallet_id, fecha_produccion, cantidad_cajas, up_id } = req.body;
    try {
      const result = await pool.query(
        `INSERT INTO pallet_detalle_cajas (
            pallet_id, fecha_produccion, cantidad_cajas, up_id
        ) VALUES ($1, $2, $3, $4) RETURNING *`,
        [pallet_id, fecha_produccion, cantidad_cajas, up_id],
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

// 7. ACTUALIZAR DETALLE DE CAJAS
router.put(
  "/detalles/:id",
  auth,
  verifyRole(["Administrador", "Lider"]),
  async (req, res) => {
    const { id } = req.params;
    const { fecha_produccion, cantidad_cajas, up_id } = req.body;
    try {
      await pool.query(
        `UPDATE pallet_detalle_cajas SET 
            fecha_produccion=$1, cantidad_cajas=$2, up_id=$3,
            updated_at=CURRENT_TIMESTAMP
        WHERE id=$4 AND deleted_at IS NULL`,
        [fecha_produccion, cantidad_cajas, up_id, id],
      );
      res.json({ message: "Detalle actualizado" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

// 8. BORRADO LÓGICO DETALLE
router.delete(
  "/detalles/:id",
  auth,
  verifyRole(["Administrador", "Lider"]),
  async (req, res) => {
    try {
      await pool.query(
        "UPDATE pallet_detalle_cajas SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1",
        [req.params.id],
      );
      res.json({ message: "Detalle eliminado" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

module.exports = router;
