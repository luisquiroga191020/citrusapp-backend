const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Verificación de seguridad de la clave
if (!process.env.GEMINI_API_KEY) {
  console.error(
    "ERROR FATAL: No se encontró GEMINI_API_KEY en las variables de entorno."
  );
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- CAMBIO: Usamos el modelo que aparece en tu lista ---
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// El mapa de tu base de datos para que la IA entienda qué buscar
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
  const { pregunta } = req.body;
  const { rol, zona_id } = req.user;

  try {
    console.log("Pregunta recibida:", pregunta);

    // --- PASO 1: Generar SQL ---
    let promptSQL = `
            ${DB_SCHEMA}
            
            Actúa como un experto en SQL. Genera una consulta SELECT (PostgreSQL) para responder: "${pregunta}"
            
            REGLAS OBLIGATORIAS:
            1. Responde SOLAMENTE con el código SQL. Sin markdown, sin comillas invertidas (\`\`\`), sin explicaciones.
            2. Usa COALESCE(SUM(monto), 0) para sumas de dinero.
            3. La fecha de hoy es '${new Date().toISOString().split("T")[0]}'.
            4. Si piden "ventas de hoy", usa: jornadas.fecha = CURRENT_DATE.
        `;

    // Seguridad: Si es Líder, solo ve su zona
    if (rol === "Lider") {
      promptSQL += `\n5. FILTRO DE SEGURIDAD: Debes filtrar obligatoriamente por la zona con ID '${zona_id}' haciendo los JOINs necesarios hacia la tabla zonas o jornadas.`;
    }

    const resultSQL = await model.generateContent(promptSQL);
    let sqlQuery = resultSQL.response.text().trim();

    // Limpieza de texto por si la IA responde con formato
    sqlQuery = sqlQuery
      .replace(/```sql/g, "")
      .replace(/```/g, "")
      .trim();

    console.log("SQL Generado:", sqlQuery);

    // Validación de seguridad (Solo lectura)
    if (!sqlQuery.toUpperCase().startsWith("SELECT")) {
      return res.json({
        respuesta:
          "Lo siento, solo tengo permisos para leer datos, no para modificar.",
      });
    }

    // --- PASO 2: Ejecutar SQL ---
    const datos = await pool.query(sqlQuery);

    if (datos.rows.length === 0) {
      return res.json({
        respuesta:
          "Analicé la base de datos y no encontré registros que coincidan con tu búsqueda.",
      });
    }

    // --- PASO 3: Generar Respuesta Humana ---
    // Convertimos los datos a texto, limitando el tamaño para no saturar a la IA
    const datosJson = JSON.stringify(datos.rows).substring(0, 4000);

    const promptTexto = `
            Contexto: El usuario preguntó: "${pregunta}"
            Resultados de la base de datos: ${datosJson}
            
            Instrucción: Responde al usuario de forma natural, breve y profesional basándote en estos datos.
            - Si hay montos de dinero, usa el formato $ 1.234.
            - Si es una lista larga, resume los puntos clave o da el top 3.
        `;

    const resultTexto = await model.generateContent(promptTexto);
    const respuestaFinal = resultTexto.response.text();

    res.json({ respuesta: respuestaFinal });
  } catch (err) {
    console.error("Error en Chat IA:", err);
    res
      .status(500)
      .json({
        error:
          "Tuve un problema técnico al procesar tu consulta. Por favor intenta de nuevo.",
      });
  }
});

// Mantenemos la ruta de debug por si acaso
router.get("/debug-models", async (req, res) => {
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`
    );
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
