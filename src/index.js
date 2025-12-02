const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('./db');
const auth = require('./middleware/auth');
const zonasRoutes = require('./routes/zonas');
const planesRoutes = require('./routes/planes');
const promotoresRoutes = require('./routes/promotores');
const jornadasRoutes = require('./routes/jornadas');
const usuariosRoutes = require('./routes/usuarios');

const app = express();
app.use(express.json());
app.use(cors());
app.use(helmet());

// --- RUTAS DE AUTENTICACIÓN ---

// Registro inicial (Solo para crear el primer admin, luego proteger)
app.post('/auth/register', async (req, res) => {
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
app.post('/auth/login', async (req, res) => {
    const { email, password } = req.body;
    const user = await pool.query("SELECT * FROM usuarios WHERE email = $1", [email]);
    
    if (user.rows.length === 0) return res.status(400).json({ error: "Usuario no encontrado" });
    
    const validPass = await bcrypt.compare(password, user.rows[0].password_hash);
    if (!validPass) return res.status(400).json({ error: "Contraseña incorrecta" });

    // Crear Token
    const token = jwt.sign(
        { id: user.rows[0].id, rol: user.rows[0].rol },
        process.env.JWT_SECRET,
        { expiresIn: '12h' }
    );

    res.header('auth-token', token).json({ 
        token, 
        user: { 
            id: user.rows[0].id, 
            nombre: user.rows[0].nombre_completo, 
            rol: user.rows[0].rol 
        } 
    });
});

// --- RUTAS DE DATOS (Protegidas) ---


app.get('/api/dashboard', auth, async (req, res) => {
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
app.use('/api/zonas', zonasRoutes);
app.use('/api/planes', planesRoutes);
app.use('/api/promotores', promotoresRoutes);
app.use('/api/jornadas', jornadasRoutes);
app.use('/api/usuarios', usuariosRoutes);
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));