const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Verificación de seguridad
if (!process.env.GEMINI_API_KEY) {
  console.error("ERROR FATAL: No se encontró GEMINI_API_KEY.");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- MODELO CORRECTO PARA TU CUENTA ---
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

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

router.post("/chat", auth, async (req, res) => {
  const { pregunta, historial } = req.body;
  const { rol, zona_id } = req.user;

  try {
    // --- MEMORIA OPTIMIZADA ---
    // Tomamos solo los últimos 6 mensajes para dar contexto sin gastar tokens de más
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
            
            HISTORIAL RECIENTE:
            ${contextText}
            
            PREGUNTA ACTUAL: "${pregunta}"
            
            TU TAREA: Genera una consulta SQL SELECT (PostgreSQL).
            
            REGLAS:
            1. Solo código SQL puro. Sin markdown.
            2. Usa COALESCE(SUM(monto), 0) para sumas.
            3. Fecha de hoy: '${new Date().toISOString().split("T")[0]}'.
        `;

    if (rol === "Lider") {
      promptSQL += `\n4. FILTRO OBLIGATORIO: Filtra por zona_id = '${zona_id}' haciendo los JOINs necesarios.`;
    }

    const resultSQL = await model.generateContent(promptSQL);
    let sqlQuery = resultSQL.response.text().trim();

    // Limpieza
    sqlQuery = sqlQuery
      .replace(/```sql/g, "")
      .replace(/```/g, "")
      .trim();
    console.log("SQL Generado:", sqlQuery);

    if (!sqlQuery.toUpperCase().startsWith("SELECT")) {
      // Si la IA no generó SQL (ej: saludo), devolvemos su respuesta texto directo
      return res.json({ respuesta: sqlQuery });
    }

    // --- PASO 2: Ejecutar SQL ---
    let datosJson = "[]";
    try {
      const datos = await pool.query(sqlQuery);
      if (datos.rows.length > 0) {
        datosJson = JSON.stringify(datos.rows).substring(0, 4000);
      } else {
        datosJson = "Sin resultados en la base de datos.";
      }
    } catch (sqlErr) {
      console.error("Error SQL:", sqlErr.message);
      datosJson = "Error ejecutando la consulta.";
    }

    // --- PASO 3: Respuesta Humana ---
    const promptTexto = `
            HISTORIAL:
            ${contextText}

            PREGUNTA: "${pregunta}"
            
            DATOS ENCONTRADOS (JSON): 
            ${datosJson}
            
            INSTRUCCIÓN: Responde breve y profesionalmente. Si hay dinero usa formato $.
        `;

    const resultTexto = await model.generateContent(promptTexto);
    res.json({ respuesta: resultTexto.response.text() });
  } catch (err) {
    console.error("Error IA:", err);
    res.status(500).json({ error: "Error en el asistente inteligente." });
  }
});

module.exports = router;
