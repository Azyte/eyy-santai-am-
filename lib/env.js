const fs = require('fs');
const path = require('path');

let loaded = false;

function cleanEnvValue(raw) {
  let val = String(raw || '').trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1).trim();
  }
  return val;
}

function getEnv(key, fallback = '') {
  const raw = process.env[key];
  if (raw === undefined || raw === null) return fallback;
  const cleaned = cleanEnvValue(raw);
  return cleaned !== '' ? cleaned : fallback;
}

function loadEnv() {
  if (loaded) return;
  loaded = true;
  try {
    const envFile = path.resolve(process.cwd(), '.env');
    if (!fs.existsSync(envFile)) return;
    const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      const val = cleanEnvValue(trimmed.slice(idx + 1));
      if (process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  } catch {}
}

loadEnv();

module.exports = { loadEnv, getEnv, cleanEnvValue };
