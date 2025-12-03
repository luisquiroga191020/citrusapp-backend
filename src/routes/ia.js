const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Verificar que la clave exista
if (!process.env.GEMINI_API_KEY) {
  console.error(
    "ERROR FATAL: No se encontró GEMINI_API_KEY en las variables de entorno."
  );
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-pro" });

const DB_SCHEMA = `
Tablas PostgreSQL:
- zonas (id, nombre)
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
    console.log("Pregunta recibida:", pregunta);

    // 1. Generar SQL
    let promptSQL = `
            ${DB_SCHEMA}
            
            Genera una consulta SQL SELECT válida para responder: "${pregunta}"
            
            REGLAS OBLIGATORIAS:
            1. Responde SOLO con el código SQL. Nada de markdown, nada de comillas invertidas (\`\`\`).
            2. No uses bloques \`\`\`sql ... \`\`\`. Solo texto plano.
            3. Usa COALESCE(SUM(monto), 0) para sumas de dinero.
            4. La fecha de hoy es '${new Date().toISOString().split("T")[0]}'.
        `;

    if (rol === "Lider") {
      promptSQL += `\n5. FILTRO OBLIGATORIO: Filtra los datos por la zona con ID '${zona_id}' haciendo los JOIN necesarios.`;
    }

    const resultSQL = await model.generateContent(promptSQL);
    let sqlQuery = resultSQL.response.text().trim();

    // Limpieza agresiva de markdown por si Gemini desobedece
    sqlQuery = sqlQuery
      .replace(/```sql/g, "")
      .replace(/```/g, "")
      .trim();

    console.log("SQL Generado:", sqlQuery);

    if (!sqlQuery.toUpperCase().startsWith("SELECT")) {
      return res.json({
        respuesta: "Solo puedo realizar consultas de lectura.",
      });
    }

    // 2. Ejecutar SQL
    const datos = await pool.query(sqlQuery);

    if (datos.rows.length === 0) {
      return res.json({
        respuesta: "No encontré información con esos criterios.",
      });
    }

    // 3. Interpretar resultados
    const datosJson = JSON.stringify(datos.rows).substring(0, 4000); // Limitar caracteres

    const promptTexto = `
            Datos encontrados (JSON): ${datosJson}
            Pregunta original: "${pregunta}"
            
            Responde al usuario basándote en los datos. Sé breve y profesional.
            Si hay dinero, usa formato moneda.
        `;

    const resultTexto = await model.generateContent(promptTexto);
    const respuestaFinal = resultTexto.response.text();

    res.json({ respuesta: respuestaFinal });
  } catch (err) {
    console.error("Error en /api/ia/chat:", err);
    res
      .status(500)
      .json({
        error: "Error interno del asistente. Revisa los logs del servidor.",
      });
  }
});

module.exports = router;
