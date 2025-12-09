const router = require("express").Router();
const pool = require("../db");
const auth = require("../middleware/auth");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Verificación de seguridad
if (!process.env.GEMINI_API_KEY) {
  console.error("ERROR FATAL: No se encontró GEMINI_API_KEY.");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- SOLUCIÓN: Usamos el alias genérico que tu cuenta SÍ tiene habilitado ---
const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });

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
- localidades.zona_id -> zonas.id
`;

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
            
            HISTORIAL RECIENTE:
            ${contextText}
            
            PREGUNTA ACTUAL: "${pregunta}"
            
            TU TAREA: Genera una consulta SQL SELECT (PostgreSQL).
            
            REGLAS OBLIGATORIAS:
            1. Solo código SQL puro. Sin markdown.
            2. Usa COALESCE(SUM(monto), 0) para sumas.
            3. Fecha de hoy: '${new Date().toISOString().split("T")[0]}'.
            4. MANEJO DE FECHAS: Si el usuario escribe una fecha como 'DD/MM/YYYY' (ej: 27/12/2025), conviértela a formato ISO 'YYYY-MM-DD' (ej: '2025-12-27') en el WHERE.
            5. Para filtrar por fecha de venta, usa la tabla 'jornadas' haciendo JOIN:
               JOIN jornada_promotores jp ON v.jornada_promotor_id = jp.id
               JOIN jornadas j ON jp.jornada_id = j.id
               WHERE j.fecha = 'AAAA-MM-DD'
        `;

    if (rol === "Lider") {
      promptSQL += `\n6. FILTRO OBLIGATORIO: Filtra por zona_id = '${zona_id}' haciendo los JOINs necesarios.`;
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
      return res.json({ respuesta: sqlQuery });
    }

    // --- PASO 2: Ejecutar SQL ---
    let datosJson = "[]";
    try {
      const datos = await pool.query(sqlQuery);
      if (datos.rows.length > 0) {
        datosJson = JSON.stringify(datos.rows).substring(0, 4000);
      } else {
        datosJson =
          "Sin resultados. No hay ventas o datos registrados para esa fecha/criterio.";
      }
    } catch (sqlErr) {
      console.error("Error SQL:", sqlErr.message);
      datosJson = "Error ejecutando la consulta SQL generada por la IA.";
    }

    // --- PASO 3: Respuesta Humana ---
    const promptTexto = `
            PREGUNTA: "${pregunta}"
            DATOS ENCONTRADOS (JSON): ${datosJson}
            
            INSTRUCCIÓN: Responde breve y profesionalmente. 
            Si hay dinero usa formato $.
            Si los datos dicen "Sin resultados", dilo amablemente.
        `;

    const resultTexto = await model.generateContent(promptTexto);
    res.json({ respuesta: resultTexto.response.text() });
  } catch (err) {
    console.error("Error IA:", err);

    if (err.message.includes("429") || err.status === 429) {
      return res.json({
        respuesta: "⚠️ Demasiadas preguntas rápidas. Espera 30 segundos.",
      });
    }

    // Si sigue el error 404, probamos el último recurso (gemini-pro)
    if (err.message.includes("404")) {
      return res.json({
        respuesta:
          "⚠️ Error de modelo. Por favor avisa al administrador que cambie el modelo a 'gemini-pro'.",
      });
    }

    res.status(500).json({ error: "Error interno del asistente." });
  }
});

module.exports = router;
