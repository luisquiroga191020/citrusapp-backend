const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");
const { GoogleGenerativeAI } = require("@google/generative-ai");

if (!process.env.GEMINI_API_KEY) {
  console.error("ERROR FATAL: No se encontró GEMINI_API_KEY.");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- ESTRATEGIA DE FALLBACK ROBUSTA (Tu lista preferida) ---
async function generarConFallback(prompt) {
  const modelos = [
    "gemini-flash-latest", // 1. Alias dinámico (Prioridad)
    "gemini-1.5-flash", // 2. Estable y rápido
    "gemini-2.0-flash", // 3. Potente (si hay cuota)
    "gemini-2.0-flash-exp", // 4. Experimental
  ];

  let lastError = null;

  for (const modelName of modelos) {
    try {
      // console.log(`Intentando con modelo: ${modelName}`); // Descomentar para debug
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (err) {
      console.warn(
        `Fallo modelo ${modelName}: ${err.message.substring(0, 50)}...`
      );
      lastError = err;
      // Si es error de seguridad, paramos. Si es 404/429/503, seguimos.
      if (err.message.includes("SAFETY")) break;
    }
  }
  throw lastError;
}

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
- ventas (id, jornada_promotor_id, plan_id, forma_pago_id, monto, created_at, codigo_ficha)
- stands (id, nombre, zona_id, localidad_id)

Relaciones CLAVE:
1. ventas -> jornada_promotores (jp) -> jornadas (j) -> zonas (z)
2. ventas -> planes (p)
3. ventas -> formas_pago (fp)
`;

router.post("/chat", auth, async (req, res) => {
  const { pregunta, historial } = req.body;
  const { rol, zona_id } = req.user;

  try {
    const contextText = historial
      ? historial
          .slice(-8)
          .map((m) => `${m.role.toUpperCase()}: ${m.text}`)
          .join("\n")
      : "";

    console.log("Pregunta:", pregunta);

    // --- PASO 1: Generar SQL con Contexto ---
    let promptSQL = `
            ${DB_SCHEMA}
            
            HISTORIAL DE CONVERSACIÓN:
            ${contextText}
            
            PREGUNTA ACTUAL: "${pregunta}"
            
            TU TAREA: Genera una consulta SQL SELECT (PostgreSQL).
            
            REGLAS DE CONTEXTO:
            1. Analiza el HISTORIAL. Si en la pregunta anterior se habló de una fecha específica, MANTÉN ESE FILTRO DE FECHA.
            2. Si preguntan "¿A qué zona pertenece?" o "¿Qué plan?", asume que hablan de los registros filtrados anteriormente.
            
            REGLAS TÉCNICAS:
            1. Solo código SQL puro. Sin markdown.
            2. Fecha de hoy: '${new Date().toISOString().split("T")[0]}'.
            3. Fechas: Convierte DD/MM/YYYY a YYYY-MM-DD.
            4. Filtro fecha ventas: JOIN jornadas j ON ... WHERE j.fecha = 'AAAA-MM-DD'.
        `;

    if (rol === "Lider") {
      promptSQL += `\nFILTRO SEGURIDAD: j.zona_id = '${zona_id}'`;
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
        datosJson = "Consulta correcta pero sin resultados (0 filas).";
      }
    } catch (sqlErr) {
      console.error("Error SQL:", sqlErr.message);
      datosJson = "Error de sintaxis SQL.";
    }

    // --- PASO 3: Respuesta Humana ---
    const promptTexto = `
            HISTORIAL:
            ${contextText}

            PREGUNTA: "${pregunta}"
            
            RESULTADO SQL: ${datosJson}
            
            INSTRUCCIÓN: Responde basándote en los datos. 
            - Si hay lista, enumérala.
            - Si preguntan "Qué zona" y el dato la tiene, dilo.
            - Usa formato $.
        `;

    const respuestaFinal = await generarConFallback(promptTexto);
    res.json({ respuesta: respuestaFinal });
  } catch (err) {
    console.error("Error IA Final:", err);
    if (
      err.message &&
      (err.message.includes("429") || err.message.includes("503"))
    ) {
      return res.json({
        respuesta: "⚠️ IA saturada temporalmente. Espera unos segundos.",
      });
    }
    res.status(500).json({ error: "Error en el asistente." });
  }
});

module.exports = router;
