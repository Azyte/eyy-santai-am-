const fs = require('fs');
const path = require('path');
const os = require('os');
const { getSql } = require('./db');

const BASELINE_TOTAL = 1558;
const isServerless = !!(process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT);
let dataDir = path.join(__dirname, '..', 'data');
let statsFile = path.join(dataDir, 'stats.json');

if (isServerless) {
  dataDir = os.tmpdir();
  statsFile = path.join(dataDir, 'stats.json');
} else if (!fs.existsSync(dataDir)) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch {
    dataDir = os.tmpdir();
    statsFile = path.join(dataDir, 'stats.json');
  }
}

function getWibTodayString() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().split('T')[0];
}

const defaultStats = {
  totalPremium: BASELINE_TOTAL,
  todayPremium: 0,
  lastDate: getWibTodayString()
};

function loadStats() {
  try {
    if (fs.existsSync(statsFile)) {
      const raw = fs.readFileSync(statsFile, 'utf8');
      const data = JSON.parse(raw);
      const today = getWibTodayString();
      if (data.lastDate !== today) {
        data.todayPremium = 0;
        data.lastDate = today;
        saveStats(data);
      }
      return data;
    }
  } catch {}

  saveStats(defaultStats);
  return { ...defaultStats };
}

function saveStats(statsObj) {
  try {
    fs.writeFileSync(statsFile, JSON.stringify(statsObj, null, 2), 'utf8');
  } catch {
    try {
      const fallbackFile = path.join(os.tmpdir(), 'stats.json');
      fs.writeFileSync(fallbackFile, JSON.stringify(statsObj, null, 2), 'utf8');
      statsFile = fallbackFile;
    } catch {}
  }
}

function getStats() {
  const current = loadStats();
  return {
    total: current.totalPremium || BASELINE_TOTAL,
    today: current.todayPremium || 0
  };
}

async function getStatsAsync() {
  const local = getStats();
  const sql = getSql();
  if (!sql) return local;

  try {
    const rows = await sql`
      SELECT
        COUNT(*)::int AS db_total,
        COUNT(*) FILTER (
          WHERE (created_at AT TIME ZONE 'Asia/Jakarta')::date = (NOW() AT TIME ZONE 'Asia/Jakarta')::date
        )::int AS db_today
      FROM activation_logs
    `;
    const dbTotal = Number(rows?.[0]?.db_total || 0);
    const dbToday = Number(rows?.[0]?.db_today || 0);
    return {
      total: Math.max(local.total, BASELINE_TOTAL + dbTotal),
      today: Math.max(local.today, dbToday)
    };
  } catch {
    return local;
  }
}

function incrementStats() {
  const current = loadStats();
  current.totalPremium = (current.totalPremium || BASELINE_TOTAL) + 1;
  current.todayPremium = (current.todayPremium || 0) + 1;
  current.lastDate = getWibTodayString();
  saveStats(current);
  return {
    total: current.totalPremium,
    today: current.todayPremium
  };
}

module.exports = {
  BASELINE_TOTAL,
  getStats,
  getStatsAsync,
  incrementStats
};
