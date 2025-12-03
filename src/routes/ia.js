const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Verificar clave
if (!process.env.GEMINI_API_KEY) {
  console.error("ERROR: Falta GEMINI_API_KEY");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Usamos 'gemini-1.5-flash' que es el estándar actual gratuito.
// Si falla, revisa los logs de Render.
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

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

router.post("/chat", auth, async (req, res) => {
  const { pregunta } = req.body;
  const { rol, zona_id } = req.user;

  try {
    console.log("--- NUEVA CONSULTA IA ---");
    console.log("Pregunta:", pregunta);

    let promptSQL = `
            ${DB_SCHEMA}
            
            Genera una consulta SQL SELECT (PostgreSQL) para responder: "${pregunta}"
            
            REGLAS:
            1. Solo código SQL puro. Sin markdown (\`\`\`).
            2. Usa COALESCE(SUM(monto), 0) para sumas.
            3. Fecha de hoy: '${new Date().toISOString().split("T")[0]}'.
            4. Si piden "ventas de hoy", usa jornadas.fecha = CURRENT_DATE.
        `;

    if (rol === "Lider") {
      promptSQL += `\n5. FILTRO OBLIGATORIO: Filtra por zona con id '${zona_id}' haciendo los JOINs necesarios.`;
    }

    // 1. Generar SQL
    const resultSQL = await model.generateContent(promptSQL);
    let sqlQuery = resultSQL.response.text().trim();

    // Limpieza de formato
    sqlQuery = sqlQuery
      .replace(/```sql/g, "")
      .replace(/```/g, "")
      .trim();
    console.log("SQL Generado:", sqlQuery);

    if (!sqlQuery.toUpperCase().startsWith("SELECT")) {
      return res.json({ respuesta: "Solo puedo leer datos, no modificarlos." });
    }

    // 2. Ejecutar SQL
    const datos = await pool.query(sqlQuery);

    if (datos.rows.length === 0) {
      return res.json({ respuesta: "No encontré datos para esa consulta." });
    }

    // 3. Generar Respuesta Texto
    const datosJson = JSON.stringify(datos.rows).substring(0, 4000);
    const promptTexto = `
            Datos: ${datosJson}
            Pregunta: "${pregunta}"
            Responde brevemente y con formato moneda si aplica.
        `;

    const resultTexto = await model.generateContent(promptTexto);
    const respuestaFinal = resultTexto.response.text();

    res.json({ respuesta: respuestaFinal });
  } catch (err) {
    console.error("ERROR CRÍTICO IA:", err); // Mira esto en los logs de Render si falla

    // Mensaje amigable al usuario dependiendo del error
    if (err.message.includes("404") || err.message.includes("Not Found")) {
      res
        .status(500)
        .json({
          error: "Error de configuración del modelo IA. Revisa los logs.",
        });
    } else {
      res
        .status(500)
        .json({ error: "No pude procesar la consulta en este momento." });
    }
  }
});

module.exports = router;
