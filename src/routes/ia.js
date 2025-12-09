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
- zonas (id, nombre)
- planes (id, nombre)
- formas_pago (id, nombre)
- usuarios (id, nombre_completo, rol, zona_id)
- promotores (id, nombre_completo, codigo, zona_id, tipo_jornada, objetivo_base)
- periodos (id, nombre, zona_id, fecha_inicio, fecha_fin, estado)
- jornadas (id, fecha, periodo_id, zona_id)
- jornada_promotores (id, jornada_id, promotor_id, stand_id)
- ventas (id, jornada_promotor_id, plan_id, forma_pago_id, monto, codigo_ficha)
- stands (id, nombre, zona_id, localidad_id)

Relaciones:
- ventas.jornada_promotor_id -> jornada_promotores.id
- jornada_promotores.promotor_id -> promotores.id
- jornada_promotores.jornada_id -> jornadas.id
- jornadas.zona_id -> zonas.id
- ventas.plan_id -> planes.id
- ventas.forma_pago_id -> formas_pago.id
`;

// Función de Fallback Inteligente (Orden optimizado)
async function generarConFallback(prompt) {
  // Ponemos primero los modelos genéricos que suelen estar siempre disponibles
  const modelos = [
    "gemini-flash-latest", // Alias dinámico (Suele ser el más seguro)
    "gemini-1.5-flash", // Estable anterior
    "gemini-2.0-flash", // Nueva generación (A veces falla por cuota)
    "gemini-2.5-flash", // Experimental
  ];

  let lastError = null;

  for (const modelName of modelos) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      return result.response.text(); // ¡Éxito!
    } catch (err) {
      console.warn(
        `Saltando modelo ${modelName}: ${err.message.substring(0, 50)}...`
      );
      lastError = err;
      if (err.message.includes("SAFETY")) break;
    }
  }
  throw lastError;
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
            
            4. **CRÍTICO - FECHAS**:
               Si el usuario pide ventas de una fecha específica (ej: 27/11/2025):
               - DEBES hacer JOIN con la tabla 'jornadas'.
               - DEBES filtrar por 'jornadas.fecha'.
               - NO uses 'ventas.created_at' ni 'ventas.fecha'.
               - Formato fecha SQL: 'YYYY-MM-DD'.

               Ejemplo correcto:
               SELECT SUM(v.monto) 
               FROM ventas v
               JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id
               JOIN jornadas j ON jp.jornada_id = j.id
               WHERE j.fecha = '2025-11-27';
        `;

    if (rol === "Lider") {
      promptSQL += `\nFILTRO OBLIGATORIO: Filtra por j.zona_id = '${zona_id}' haciendo los JOINs necesarios.`;
    }

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
        // Si la consulta SQL funcionó pero trajo 0 filas
        datosJson =
          "Consulta exitosa pero sin registros encontrados (0 resultados).";
      }
    } catch (sqlErr) {
      console.error("Error SQL:", sqlErr.message);
      datosJson = "Error de sintaxis en SQL generado.";
    }

    // --- PASO 3: Respuesta Humana ---
    const promptTexto = `
            PREGUNTA: "${pregunta}"
            DATOS: ${datosJson}
            INSTRUCCIÓN: Responde breve y profesionalmente. Usa formato $. 
            Si los datos dicen "0 resultados", responde: "No encontré ventas registradas para esa fecha en el sistema."
        `;

    const respuestaFinal = await generarConFallback(promptTexto);
    res.json({ respuesta: respuestaFinal });
  } catch (err) {
    console.error("Error IA Final:", err);
    if (
      err.message &&
      (err.message.includes("429") || err.message.includes("503"))
    ) {
      return res.json({ respuesta: "⚠️ IA saturada. Espera 10 segundos." });
    }
    res.status(500).json({ error: "Error en el asistente." });
  }
});

module.exports = router;
