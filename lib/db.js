const { neon } = require('@neondatabase/serverless');

const DEFAULT_NEON_URL = 'postgresql://neondb_owner:npg_5yCmwuK7zSPX@ep-curly-lab-a1ogyf2u-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require';

let sqlClient = null;

function getSql() {
  if (!sqlClient) {
    const connStr = process.env.DATABASE_URL || DEFAULT_NEON_URL;
    sqlClient = neon(connStr);
  }
  return sqlClient;
}

module.exports = { getSql };
