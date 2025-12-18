const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("./db");
const auth = require("./middleware/auth");
const audit = require("./middleware/audit");
const zonasRoutes = require("./routes/zonas");
const planesRoutes = require("./routes/planes");
const promotoresRoutes = require("./routes/promotores");
const periodosRoutes = require("./routes/periodos");
const jornadasRoutes = require("./routes/jornadas");
const usuariosRoutes = require("./routes/usuarios");
const formasPagoRoutes = require("./routes/formasPago");
const localidadesRoutes = require("./routes/localidades");
const standsRoutes = require("./routes/stands");
const analyticsRoutes = require("./routes/analytics");
const iaRoutes = require("./routes/ia");
const planificadorRoutes = require("./routes/planificador");

const app = express();
app.use(express.json());
app.use(cors());
app.use(helmet());
// If running behind a proxy (Render, Heroku, nginx), trust proxy headers so req.ip and protocol are correct
app.set('trust proxy', true);

// Auditoría: registrar todas las peticiones
app.use(audit);

// --- RUTAS DE AUTENTICACIÓN ---

// Registro inicial (Solo para crear el primer admin, luego proteger)
app.post("/auth/register", async (req, res) => {
  const { email, password, nombre } = req.body;
  const hash = await bcrypt.hash(password, 10);
  try {
    const newUser = await pool.query(
      "INSERT INTO usuarios (email, password_hash, nombre_completo, rol) VALUES ($1, $2, $3, 'admin') RETURNING id, email",
      [email, hash, nombre]
    );
    res.json(newUser.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login
app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await pool.query("SELECT * FROM usuarios WHERE email = $1", [
    email,
  ]);

  if (user.rows.length === 0)
    return res.status(400).json({ error: "Usuario no encontrado" });

  const validPass = await bcrypt.compare(password, user.rows[0].password_hash);
  if (!validPass)
    return res.status(400).json({ error: "Contraseña incorrecta" });

  const usuarioData = user.rows[0]; // Datos de la DB

  const token = jwt.sign(
    {
      id: usuarioData.id,
      rol: usuarioData.rol,
      zona_id: usuarioData.zona_id, // <--- IMPORTANTE: Incluirlo en el token
    },
    process.env.JWT_SECRET,
    { expiresIn: "12h" }
  );

  // Registrar login exitoso en auditoría (usuario ya identificado)
  try {
    await pool.query(
      `INSERT INTO audits (user_id, username, rol, method, path, status, ip, user_agent, device_type, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        usuarioData.id,
        usuarioData.nombre_completo,
        usuarioData.rol,
        'POST',
        '/auth/login',
        200,
        req.ip || null,
        req.get('User-Agent') || null,
        null,
        { message: 'login_success' },
      ]
    );
  } catch (e) {
    console.error('Audit insert error on login', e.message);
  }

  res.json({
    token,
    user: {
      id: usuarioData.id,
      nombre: usuarioData.nombre_completo,
      rol: usuarioData.rol,
      zona_id: usuarioData.zona_id, // <--- IMPORTANTE: Enviarlo al frontend
    },
  });
});

// Logout (opcional): registra cierre de sesión
app.post('/auth/logout', auth, async (req, res) => {
  try {
    await pool.query(`INSERT INTO audits (user_id, username, rol, method, path, status, ip, user_agent, device_type, details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
      req.user?.id || null,
      req.user?.nombre || null,
      req.user?.rol || null,
      'POST',
      '/auth/logout',
      200,
      req.ip || null,
      req.get('User-Agent') || null,
      null,
      { message: 'logout' }
    ]);
  } catch (e) {
    console.error('Audit insert error on logout', e.message);
  }
  res.json({ ok: true });
});

// --- RUTAS DE DATOS (Protegidas) ---

app.get("/api/dashboard", auth, async (req, res) => {
  try {
    const kpis = await pool.query(`
            SELECT 
                COUNT(*) as total_ventas,
                SUM(monto) as monto_total,
                (SELECT COUNT(*) FROM jornadas WHERE fecha = CURRENT_DATE) as promotores_activos
            FROM ventas 
            WHERE created_at >= date_trunc('month', CURRENT_DATE)
        `);
    res.json(kpis.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.use("/api/zonas", zonasRoutes);
app.use("/api/planes", planesRoutes);
app.use("/api/promotores", promotoresRoutes);
app.use("/api/periodos", periodosRoutes);
app.use("/api/jornadas", jornadasRoutes);
app.use("/api/usuarios", usuariosRoutes);
app.use("/api/formas-pago", formasPagoRoutes);
app.use("/api/localidades", localidadesRoutes);
app.use("/api/stands", standsRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/ia", iaRoutes);
app.use("/api/planificador", planificadorRoutes);
const auditsRoutes = require('./routes/audits');
app.use('/api/audits', auditsRoutes);
const proxyRoutes = require('./routes/proxy');
app.use('/proxy', proxyRoutes);
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
