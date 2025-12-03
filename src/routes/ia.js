const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Configurar Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Le enseñamos a la IA tu base de datos
const DB_SCHEMA = `
Eres un experto SQL. Tienes esta base de datos PostgreSQL:
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

RELACIONES:
- ventas -> jornada_promotores -> jornadas -> zonas
- ventas -> jornada_promotores -> promotores
`;

router.post("/chat", auth, async (req, res) => {
  const { pregunta } = req.body;
  const { rol, zona_id } = req.user;

  try {
    // --- FASE 1: Generar SQL ---
    let promptSQL = `${DB_SCHEMA}
        
        El usuario pregunta: "${pregunta}"
        
        Genera una consulta SQL SELECT para responder.
        REGLAS:
        1. Solo devuelve el código SQL puro, sin markdown ni explicaciones.
        2. Usa COALESCE(SUM(monto), 0) para sumas.
        3. La fecha actual es ${new Date().toISOString().split("T")[0]}.
        `;

    // Seguridad RLS para Líderes
    if (rol === "Lider") {
      promptSQL += `\nIMPORTANTE: Filtra los datos donde la tabla relacionada con 'zona' tenga id = '${zona_id}'.`;
    }

    const resultSQL = await model.generateContent(promptSQL);
    let sqlQuery = resultSQL.response.text();

    // Limpiar el SQL (Gemini a veces pone \`\`\`sql ... \`\`\`)
    sqlQuery = sqlQuery
      .replace(/```sql/g, "")
      .replace(/```/g, "")
      .trim();

    console.log("SQL Generado:", sqlQuery); // Para que lo veas en los logs de Render

    // Validación de seguridad (Solo lectura)
    if (!sqlQuery.toUpperCase().startsWith("SELECT")) {
      return res.json({
        respuesta: "Solo puedo consultar datos, no modificarlos.",
      });
    }

    // --- FASE 2: Ejecutar SQL ---
    const datos = await pool.query(sqlQuery);

    if (datos.rows.length === 0) {
      return res.json({
        respuesta: "No encontré datos que coincidan con tu consulta.",
      });
    }

    // --- FASE 3: Interpretar Datos ---
    const datosJson = JSON.stringify(datos.rows).substring(0, 5000); // Limitamos tamaño por seguridad

    const promptTexto = `
            Pregunta: "${pregunta}"
            Datos obtenidos (JSON): ${datosJson}
            
            Actúa como un analista de negocios experto.
            Analiza los datos y responde la pregunta del usuario de forma clara, concisa y profesional.
            Si hay montos, dales formato de dinero.
        `;

    const resultTexto = await model.generateContent(promptTexto);
    const respuestaFinal = resultTexto.response.text();

    res.json({ respuesta: respuestaFinal });
  } catch (err) {
    console.error("Error IA:", err);
    // A veces la IA genera SQL inválido, manejamos el error
    if (err.code) {
      res.json({
        respuesta:
          "Entendí la pregunta, pero intenté hacer una consulta compleja y falló. Intenta ser más específico.",
      });
    } else {
      res.status(500).json({ error: "Error conectando con la IA." });
    }
  }
});

module.exports = router;
