const { Pool } = require("pg");
require("dotenv").config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  try {
    const res = await pool.query(`
      SELECT column_name, data_type, udt_name
      FROM information_schema.columns 
      WHERE table_name = 'usuarios' AND column_name = 'id'
    `);
    if (res.rows.length > 0) {
      console.log(
        "DATATYPE_FOUND:" +
          res.rows[0].data_type +
          " (" +
          res.rows[0].udt_name +
          ")",
      );
    } else {
      console.log("COLUMN_NOT_FOUND");
    }
  } catch (err) {
    console.log("DEBUG_ERROR:" + err.message);
  } finally {
    await pool.end();
  }
}
run();
