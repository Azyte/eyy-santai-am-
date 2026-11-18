const { getEnv } = require('./env');
const { neon } = require('@neondatabase/serverless');

let sqlClient = null;
let cachedUrl = null;

function isDbConfigured() {
  return Boolean(getEnv('DATABASE_URL'));
}

function getSql() {
  const connStr = getEnv('DATABASE_URL');
  if (!connStr) return null;
  if (!sqlClient || cachedUrl !== connStr) {
    sqlClient = neon(connStr);
    cachedUrl = connStr;
  }
  return sqlClient;
}

module.exports = { getSql, isDbConfigured };
