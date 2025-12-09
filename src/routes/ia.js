const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");
const { GoogleGenerativeAI } = require("@google/generative-ai");

if (!process.env.GEMINI_API_KEY) {
  console.error("ERROR FATAL: No se encontró GEMINI_API_KEY.");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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
- ventas (id, jornada_promotor_id, plan_id, forma_pago_id, monto, created_at, codigo_ficha)
- stands (id, nombre, zona_id, localidad_id)

Relaciones:
- ventas.jornada_promotor_id -> jornada_promotores.id
- jornada_promotores.promotor_id -> promotores.id
- jornada_promotores.jornada_id -> jornadas.id
- jornadas.zona_id -> zonas.id
- ventas.plan_id -> planes.id
- ventas.forma_pago_id -> formas_pago.id
`;

// Función auxiliar para probar modelos en cascada
async function generarConFallback(prompt) {
  // Lista de modelos en orden de preferencia
  const modelos = [
    "gemini-1.5-flash-latest",
    "gemini-2.0-flash-exp",
    "gemini-pro",
  ];

  let lastError = null;

  for (const modelName of modelos) {
    try {
      console.log(`Intentando con modelo: ${modelName}...`);
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      return result.response.text(); // ¡Éxito!
    } catch (err) {
      console.warn(`Fallo modelo ${modelName}: ${err.message}`);
      lastError = err;
      // Si el error es por seguridad (safety settings), no reintentamos
      if (err.message.includes("SAFETY")) break;
      // Si es 404, 429 o 503, continuamos con el siguiente modelo del bucle
    }
  }
  throw lastError; // Si todos fallan, lanzamos el último error
}

router.post("/chat", auth, async (req, res) => {
  const { pregunta, historial } = req.body;
  const { rol, zona_id } = req.user;

  try {
    const contextText = historial
      ? historial
          .slice(-6)
          .map(
            (m) => `${m.role === "user" ? "Usuario" : "Asistente"}: ${m.text}`
          )
          .join("\n")
      : "";

    console.log("Pregunta:", pregunta);

    // --- PASO 1: Generar SQL ---
    let promptSQL = `
            ${DB_SCHEMA}
            
            HISTORIAL:
            ${contextText}
            
            PREGUNTA ACTUAL: "${pregunta}"
            
            TU TAREA: Genera una consulta SQL SELECT (PostgreSQL).
            
            REGLAS OBLIGATORIAS:
            1. Solo código SQL puro. Sin markdown.
            2. Usa COALESCE(SUM(monto), 0) para sumas.
            3. Fecha de hoy: '${new Date().toISOString().split("T")[0]}'.
            4. MANEJO DE FECHAS: Convierte DD/MM/YYYY a YYYY-MM-DD.
        `;

    if (rol === "Lider") {
      promptSQL += `\nFILTRO: zona_id = '${zona_id}' en los JOINs.`;
    }

    // Usamos la función de fallback
    let sqlQuery = await generarConFallback(promptSQL);

    sqlQuery = sqlQuery
      .replace(/```sql/g, "")
      .replace(/```/g, "")
      .trim();
    console.log("SQL Generado:", sqlQuery);

    if (!sqlQuery.toUpperCase().startsWith("SELECT")) {
      return res.json({ respuesta: sqlQuery });
    }

    // --- PASO 2: Ejecutar SQL ---
    let datosJson = "[]";
    try {
      const datos = await pool.query(sqlQuery);
      if (datos.rows.length > 0) {
        datosJson = JSON.stringify(datos.rows).substring(0, 4000);
      } else {
        datosJson = "Sin resultados.";
      }
    } catch (sqlErr) {
      console.error("Error SQL:", sqlErr.message);
      datosJson = "Error en consulta SQL.";
    }

    // --- PASO 3: Respuesta Humana ---
    const promptTexto = `
            PREGUNTA: "${pregunta}"
            DATOS: ${datosJson}
            INSTRUCCIÓN: Responde breve y profesionalmente. Usa formato $.
        `;

    const respuestaFinal = await generarConFallback(promptTexto);
    res.json({ respuesta: respuestaFinal });
  } catch (err) {
    console.error("Error IA Final:", err);

    // Mensaje amigable si todo falla
    if (
      err.message &&
      (err.message.includes("429") || err.message.includes("503"))
    ) {
      return res.json({
        respuesta:
          "⚠️ Todos los modelos de IA están ocupados. Por favor espera 1 minuto.",
      });
    }
    res.status(500).json({ error: "Error en el asistente." });
  }
});

module.exports = router;
