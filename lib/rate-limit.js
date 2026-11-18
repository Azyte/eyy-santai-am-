const { getSql } = require('./db');

const memoryBuckets = new Map();

// Prefer platform-injected client IP headers so callers cannot spoof X-Forwarded-For to bypass limits.
function getTrustedClientIp(req) {
  const isLocal = !process.env.NETLIFY && !process.env.AWS_LAMBDA_FUNCTION_NAME;
  const raw =
    req.headers['x-nf-client-connection-ip'] ||
    req.headers['cf-connecting-ip'] ||
    (isLocal ? req.headers['x-forwarded-for']?.split(',')[0]?.trim() : null) ||
    req.socket?.remoteAddress ||
    '127.0.0.1';
  return String(raw).replace(/^::ffff:/, '').trim();
}

async function consumeBucket(bucketKey, maxHits, windowMs) {
  const now = Date.now();
  const sql = getSql();

  if (sql) {
    try {
      const nextResetIso = new Date(now + windowMs).toISOString();
      const rows = await sql`
        INSERT INTO rate_limit_buckets (bucket_key, hits, reset_at)
        VALUES (${bucketKey}, 1, ${nextResetIso})
        ON CONFLICT (bucket_key) DO UPDATE SET
          hits = CASE
            WHEN rate_limit_buckets.reset_at <= NOW() THEN 1
            ELSE rate_limit_buckets.hits + 1
          END,
          reset_at = CASE
            WHEN rate_limit_buckets.reset_at <= NOW() THEN ${nextResetIso}::timestamptz
            ELSE rate_limit_buckets.reset_at
          END
        RETURNING hits, reset_at
      `;
      const row = rows?.[0];
      if (row) {
        const waitSeconds = Math.max(1, Math.ceil((new Date(row.reset_at).getTime() - now) / 1000));
        return {
          blocked: Number(row.hits) > maxHits,
          hits: Number(row.hits),
          waitSeconds
        };
      }
    } catch {}
  }

  const entry = memoryBuckets.get(bucketKey);
  if (!entry || now >= entry.resetAt) {
    memoryBuckets.set(bucketKey, { hits: 1, resetAt: now + windowMs });
    return { blocked: false, hits: 1, waitSeconds: Math.ceil(windowMs / 1000) };
  }
  entry.hits += 1;
  const waitSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  return {
    blocked: entry.hits > maxHits,
    hits: entry.hits,
    waitSeconds
  };
}

async function clearBucket(bucketKey) {
  memoryBuckets.delete(bucketKey);
  const sql = getSql();
  if (!sql) return;
  try {
    await sql`DELETE FROM rate_limit_buckets WHERE bucket_key = ${bucketKey}`;
  } catch {}
}

function rateLimit({ scope = 'api', windowMs = 60 * 1000, max = 5, message = 'Terlalu banyak permintaan. Silakan tunggu sebentar.' } = {}) {
  return async (req, res, next) => {
    const ip = getTrustedClientIp(req);
    const key = `rl:${scope}:${ip}`;
    const result = await consumeBucket(key, max, windowMs);
    if (result.blocked) {
      return res.status(429).json({
        success: false,
        message: `${message} (Tunggu ${result.waitSeconds} detik)`,
        error: `${message} (Tunggu ${result.waitSeconds} detik)`
      });
    }
    next();
  };
}

module.exports = rateLimit;
module.exports.getTrustedClientIp = getTrustedClientIp;
module.exports.consumeBucket = consumeBucket;
module.exports.clearBucket = clearBucket;
