const router = require('express').Router();
const pool = require('../db');
const auth = require('../middleware/auth');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Verificar clave
const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) console.error("ERROR: Falta GEMINI_API_KEY");

const genAI = new GoogleGenerativeAI(API_KEY);

// --- CAMBIO IMPORTANTE: Usamos un modelo "seguro" por defecto ---
// Si este falla, el código intentará listar los disponibles
const MODEL_NAME = "gemini-1.5-flash"; 
const model = genAI.getGenerativeModel({ model: MODEL_NAME });

const DB_SCHEMA = `
Tablas PostgreSQL:
- zonas (id, nombre, color_identificador)
- planes (id, nombre, servicio, tipo)
- formas_pago (id, nombre, tipo)
- usuarios (id, nombre_completo, rol, zona_id)
- promotores (id, nombre_completo, codigo, zona_id, tipo_jornada, objetivo_base)
- periodos (id, nombre, zona_id, fecha_inicio, fecha_fin, estado)
- jornadas (id, fecha, periodo_id, zona_id)
- jornada_promotores (id, jornada_id, promotor_id, stand_id)
- ventas (id, jornada_promotor_id, plan_id, forma_pago_id, monto, created_at)
- stands (id, nombre, zona_id, localidad_id)

Relaciones:
- ventas.jornada_promotor_id -> jornada_promotores.id
- jornada_promotores.promotor_id -> promotores.id
- jornada_promotores.jornada_id -> jornadas.id
- jornadas.zona_id -> zonas.id
`;

// RUTA DE DIAGNÓSTICO (Para ver qué modelos ve tu clave)
router.get('/debug-models', async (req, res) => {
    try {
        // Consulta directa a la API REST de Google para ver modelos
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`);
        const data = await response.json();
        
        console.log("MODELOS DISPONIBLES PARA TU CLAVE:", JSON.stringify(data, null, 2));
        
        if (data.error) {
            return res.status(400).json(data.error);
        }
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/chat', auth, async (req, res) => {
    const { pregunta } = req.body;
    const { rol, zona_id } = req.user;

    try {
        console.log(`Intento consulta con modelo: ${MODEL_NAME}`);
        
        let promptSQL = `
            ${DB_SCHEMA}
            Genera SQL SELECT para: "${pregunta}"
            REGLAS: Solo SQL puro. Sin markdown. Fecha hoy: '${new Date().toISOString().split('T')[0]}'.
        `;

        if (rol === 'Lider') promptSQL += `\nFiltra por zona_id = '${zona_id}'`;

        // 1. Generar SQL
        const resultSQL = await model.generateContent(promptSQL);
        let sqlQuery = resultSQL.response.text().replace(/```sql/g, '').replace(/```/g, '').trim();
        
        console.log("SQL Generado:", sqlQuery);

        if (!sqlQuery.toUpperCase().startsWith('SELECT')) {
            return res.json({ respuesta: "Solo puedo leer datos." });
        }

        // 2. Ejecutar SQL
        const datos = await pool.query(sqlQuery);
        
        // 3. Respuesta Humana
        const datosJson = JSON.stringify(datos.rows).substring(0, 4000);
        const resultTexto = await model.generateContent(`
            Datos: ${datosJson}. Pregunta: "${pregunta}". 
            Responde como analista experto, brevemente.
        `);
        
        res.json({ respuesta: resultTexto.response.text() });

    } catch (err) {
        console.error("ERROR IA:", err);
        
        // Si es 404, damos instrucciones claras
        if (err.message.includes("404") || err.message.includes("Not Found")) {
            res.status(500).json({ 
                error: `El modelo ${MODEL_NAME} no está disponible para tu clave. Ve a /api/ia/debug-models para ver cuáles tienes.` 
            });
        } else {
            res.status(500).json({ error: "Error procesando la consulta." });
        }
    }
});

module.exports = router;