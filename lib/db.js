require('./env');
const { neon } = require('@neondatabase/serverless');

let sqlClient = null;
let cachedUrl = null;

function isDbConfigured() {
  return Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim());
}

function getSql() {
  const connStr = (process.env.DATABASE_URL || '').trim();
  if (!connStr) return null;
  if (!sqlClient || cachedUrl !== connStr) {
    sqlClient = neon(connStr);
    cachedUrl = connStr;
  }
  return sqlClient;
}

module.exports = { getSql, isDbConfigured };
