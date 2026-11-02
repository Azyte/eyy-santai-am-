// In-memory sliding window rate limiter
const ipRequests = new Map();

// Periodic cleanup of stale IPs every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of ipRequests.entries()) {
    if (now - data.firstReq > 10 * 60 * 1000) {
      ipRequests.delete(ip);
    }
  }
}, 5 * 60 * 1000).unref();

function rateLimit({ windowMs = 60 * 1000, max = 5, message = 'Terlalu banyak permintaan. Silakan tunggu sebentar.' } = {}) {
  return (req, res, next) => {
    // Determine client IP
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() ||
               req.headers['x-real-ip'] ||
               req.socket?.remoteAddress ||
               'unknown-ip';

    const now = Date.now();
    const entry = ipRequests.get(ip) || { count: 0, firstReq: now };

    if (now - entry.firstReq > windowMs) {
      entry.count = 1;
      entry.firstReq = now;
    } else {
      entry.count++;
    }

    ipRequests.set(ip, entry);

    if (entry.count > max) {
      const waitSeconds = Math.ceil((windowMs - (now - entry.firstReq)) / 1000);
      return res.status(429).json({
        success: false,
        message: `${message} (Tunggu ${waitSeconds} detik)`
      });
    }

    next();
  };
}

module.exports = rateLimit;
