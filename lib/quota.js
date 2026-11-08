const crypto = require('crypto');
const { getSql } = require('./db');

const FREE_DAILY_LIMIT = 3;
const FREE_COOLDOWN_SECONDS = 10 * 60; // 10 minutes
const PREMIUM_DAILY_LIMIT = 10;
const RESELLER_DAILY_LIMIT = 25;

const TOKEN_SECRET = process.env.SESSION_SECRET || 'dkaimono-am-hwlock-token-secret-2026-v2';

// In-memory rate limiters (anti brute-force for voucher & login)
const voucherAttempts = new Map();
const loginAttempts = new Map();
const memoryDevices = new Map();

function checkRateLimit(map, key, maxAttempts = 5, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const entry = map.get(key);
  if (!entry || now > entry.resetAt) {
    return { blocked: false, remaining: maxAttempts };
  }
  if (entry.count >= maxAttempts) {
    const waitSec = Math.ceil((entry.resetAt - now) / 1000);
    return { blocked: true, waitSeconds: waitSec };
  }
  return { blocked: false, remaining: maxAttempts - entry.count };
}

function recordFailedAttempt(map, key, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const entry = map.get(key);
  if (!entry || now > entry.resetAt) {
    map.set(key, { count: 1, resetAt: now + windowMs });
  } else {
    entry.count += 1;
  }
}

function clearAttempts(map, key) {
  map.delete(key);
}

function extractClientIp(req) {
  const raw =
    req.headers['x-nf-client-connection-ip'] ||
    req.headers['cf-connecting-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    '127.0.0.1';
  return String(raw).replace(/^::ffff:/, '').trim();
}

function getIpSubnet24(ip) {
  const clean = String(ip || '127.0.0.1').replace(/^::ffff:/, '').trim();
  const ipv4Parts = clean.split('.');
  if (ipv4Parts.length === 4) {
    return `${ipv4Parts[0]}.${ipv4Parts[1]}.${ipv4Parts[2]}.0/24`;
  }
  const ipv6Parts = clean.split(':');
  if (ipv6Parts.length >= 4) {
    return `${ipv6Parts.slice(0, 4).join(':')}::/64`;
  }
  return clean;
}

function normalizeFingerprint(rawFp, ipSubnet, userAgent = '') {
  if (rawFp && typeof rawFp === 'string' && rawFp.trim().length >= 8) {
    return rawFp.trim().slice(0, 96);
  }
  const hash = crypto
    .createHash('sha256')
    .update(`${ipSubnet}|${userAgent}`)
    .digest('hex')
    .slice(0, 24);
  return `fp_${hash}`;
}

// One-way salted SHA-256 hash for secret vouchers (plaintext never stored in code or DB)
function hashSecretVoucher(rawCode) {
  const clean = String(rawCode || '').trim().toUpperCase();
  if (!clean) return '';
  return crypto
    .createHash('sha256')
    .update(`dkaimono-v1::${clean}::secret-pepper`)
    .digest('hex');
}

// Password hashing with scrypt
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, origHex] = storedHash.split(':');
  if (!salt || !origHex) return false;
  const derived = crypto.scryptSync(String(password), salt, 64);
  const origBuf = Buffer.from(origHex, 'hex');
  if (derived.length !== origBuf.length) return false;
  return crypto.timingSafeEqual(derived, origBuf);
}

// Signed HMAC session token bound to userId + device fingerprint (1 Device 1 Account)
function createSessionToken(user, fingerprint) {
  const payload = {
    uid: user.id,
    em: user.email,
    fp: fingerprint,
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000
  };
  const dataB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(dataB64).digest('base64url');
  return `${dataB64}.${sig}`;
}

function verifySessionToken(token, currentFingerprint) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [dataB64, sig] = token.split('.');
  if (!dataB64 || !sig) return null;
  const expectedSig = crypto.createHmac('sha256', TOKEN_SECRET).update(dataB64).digest('base64url');
  if (sig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  try {
    const payload = JSON.parse(Buffer.from(dataB64, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    // Enforce hardware fingerprint lock on session token
    if (currentFingerprint && payload.fp && payload.fp !== currentFingerprint) {
      return { ...payload, deviceMismatch: true };
    }
    return payload;
  } catch (e) {
    return null;
  }
}

function extractClientContext(req) {
  const ip = extractClientIp(req);
  const ipSubnet = getIpSubnet24(ip);
  const rawFp =
    req.headers['x-device-fingerprint'] ||
    req.body?.fingerprint ||
    req.query?.fingerprint ||
    '';
  const authToken = (
    req.headers['x-auth-token'] ||
    req.headers['authorization']?.replace(/^Bearer\s+/i, '') ||
    req.body?.authToken ||
    ''
  )
    .toString()
    .trim();
  const voucherCode = (
    req.headers['x-voucher-code'] ||
    req.body?.voucherCode ||
    req.query?.voucherCode ||
    ''
  )
    .toString()
    .trim();
  const fingerprint = normalizeFingerprint(rawFp, ipSubnet, req.headers['user-agent'] || '');
  return { ip, ipSubnet, fingerprint, authToken, voucherCode };
}

// ============================================================================
// 1 DEVICE = 1 ACCOUNT AUTHENTICATION (REGISTER & LOGIN)
// ============================================================================
async function registerAppUser({ email, password, fingerprint, ip, ipSubnet }) {
  const em = String(email || '').trim().toLowerCase();
  const pw = String(password || '');
  const subnet = ipSubnet || getIpSubnet24(ip);
  const fp = normalizeFingerprint(fingerprint, subnet);

  if (!em || !em.includes('@') || !em.includes('.')) {
    return { ok: false, status: 400, message: 'Masukkan alamat email yang valid.' };
  }
  if (pw.length < 6) {
    return { ok: false, status: 400, message: 'Password minimal 6 karakter.' };
  }

  try {
    const sql = getSql();

    // Check if email is already registered
    const existingEmail = await sql`
      SELECT id, email FROM app_users WHERE LOWER(email) = ${em} LIMIT 1
    `;
    if (existingEmail && existingEmail.length > 0) {
      return {
        ok: false,
        status: 409,
        message: 'Email ini sudah terdaftar. Silakan masuk melalui tab Login.'
      };
    }

    // 1 DEVICE = 1 ACCOUNT CHECK: Check if this device fingerprint already owns an account
    const existingDevice = await sql`
      SELECT id, email FROM app_users WHERE device_fingerprint = ${fp} LIMIT 1
    `;
    if (existingDevice && existingDevice.length > 0) {
      return {
        ok: false,
        status: 403,
        message: 'Perangkat ini sudah terikat dengan akun lain. Sistem membatasi 1 Perangkat hanya untuk 1 Akun.'
      };
    }

    const pwHash = hashPassword(pw);
    const inserted = await sql`
      INSERT INTO app_users (
        email,
        password_hash,
        tier,
        daily_limit,
        device_fingerprint,
        ip_address,
        daily_activations_count,
        daily_reset_date
      )
      VALUES (${em}, ${pwHash}, 'free', ${FREE_DAILY_LIMIT}, ${fp}, ${ip}, 0, CURRENT_DATE)
      RETURNING id, email, tier, daily_limit, premium_until, device_fingerprint
    `;

    const user = inserted[0];
    const token = createSessionToken(user, fp);
    const quota = await getQuotaStatus({ fingerprint: fp, ip, ipSubnet: subnet, authToken: token });

    return {
      ok: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        tier: user.tier,
        deviceLocked: true
      },
      quota,
      message: 'Akun berhasil dibuat dan dikunci ke perangkat ini (1 Device 1 Akun).'
    };
  } catch (err) {
    if (err.message && err.message.includes('idx_app_users_unique_fp')) {
      return {
        ok: false,
        status: 403,
        message: 'Perangkat ini sudah terdaftar pada akun lain (1 Perangkat = 1 Akun).'
      };
    }
    console.error('Register error:', err.message);
    return { ok: false, status: 500, message: 'Gagal mendaftarkan akun di server.' };
  }
}

async function loginAppUser({ email, password, fingerprint, ip, ipSubnet }) {
  const em = String(email || '').trim().toLowerCase();
  const pw = String(password || '');
  const subnet = ipSubnet || getIpSubnet24(ip);
  const fp = normalizeFingerprint(fingerprint, subnet);
  const rateKey = `login:${fp}:${subnet}`;

  const rl = checkRateLimit(loginAttempts, rateKey, 6, 15 * 60 * 1000);
  if (rl.blocked) {
    return {
      ok: false,
      status: 429,
      message: `Terlalu banyak percobaan login gagal. Tunggu ${Math.ceil(rl.waitSeconds / 60)} menit.`
    };
  }

  if (!em || !pw) {
    return { ok: false, status: 400, message: 'Email dan password wajib diisi.' };
  }

  try {
    const sql = getSql();
    const rows = await sql`
      SELECT id, email, password_hash, tier, daily_limit, premium_until, device_fingerprint
      FROM app_users
      WHERE LOWER(email) = ${em}
      LIMIT 1
    `;

    if (!rows || rows.length === 0 || !verifyPassword(pw, rows[0].password_hash)) {
      recordFailedAttempt(loginAttempts, rateKey);
      return { ok: false, status: 401, message: 'Email atau password salah.' };
    }

    const user = rows[0];

    // Check 1: Is this account already locked to a DIFFERENT device?
    if (user.device_fingerprint && user.device_fingerprint !== fp) {
      return {
        ok: false,
        status: 403,
        message: 'Akses ditolak: Akun ini sudah dikunci pada perangkat lain (1 Akun = 1 Perangkat).'
      };
    }

    // Check 2: Is this device already locked to a DIFFERENT account?
    const otherAccOnDevice = await sql`
      SELECT id FROM app_users
      WHERE device_fingerprint = ${fp} AND id != ${user.id}
      LIMIT 1
    `;
    if (otherAccOnDevice && otherAccOnDevice.length > 0) {
      return {
        ok: false,
        status: 403,
        message: 'Akses ditolak: Perangkat ini sudah terikat dengan akun lain (1 Perangkat = 1 Akun).'
      };
    }

    // Lock device fingerprint if not yet set
    if (!user.device_fingerprint) {
      await sql`
        UPDATE app_users
        SET device_fingerprint = ${fp}, ip_address = ${ip}, updated_at = NOW()
        WHERE id = ${user.id}
      `;
    }

    clearAttempts(loginAttempts, rateKey);
    const token = createSessionToken(user, fp);
    const quota = await getQuotaStatus({ fingerprint: fp, ip, ipSubnet: subnet, authToken: token });

    return {
      ok: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        tier: quota.tier,
        deviceLocked: true
      },
      quota,
      message: 'Berhasil masuk! Sesi perangkat terverifikasi.'
    };
  } catch (err) {
    console.error('Login error:', err.message);
    return { ok: false, status: 500, message: 'Gagal memproses login.' };
  }
}

async function getAuthenticatedUser(authToken, fingerprint) {
  if (!authToken) return null;
  const decoded = verifySessionToken(authToken, fingerprint);
  if (!decoded || decoded.deviceMismatch) return decoded;

  try {
    const sql = getSql();
    const rows = await sql`
      SELECT
        id,
        email,
        tier,
        COALESCE(daily_limit, CASE WHEN tier = 'reseller' THEN 25 WHEN tier = 'premium' THEN 10 ELSE 3 END) AS daily_limit,
        premium_until,
        device_fingerprint,
        CASE
          WHEN daily_reset_date IS NULL OR daily_reset_date < CURRENT_DATE THEN 0
          ELSE COALESCE(daily_activations_count, 0)
        END AS used_today,
        last_activation_at
      FROM app_users
      WHERE id = ${decoded.uid}
      LIMIT 1
    `;
    if (!rows || rows.length === 0) return null;
    const u = rows[0];
    if (u.device_fingerprint && fingerprint && u.device_fingerprint !== fingerprint) {
      return { deviceMismatch: true };
    }
    return u;
  } catch (err) {
    return null;
  }
}

// ============================================================================
// SECRET VOUCHER VERIFICATION & REDEMPTION (HASHED, ANTI-HACKER)
// ============================================================================
async function verifySecretVoucherHash(rawCode) {
  if (!rawCode) return null;
  const codeHash = hashSecretVoucher(rawCode);
  if (!codeHash) return null;
  try {
    const sql = getSql();
    const rows = await sql`
      SELECT id, plan_label, tier, daily_limit, duration_days
      FROM secret_vouchers
      WHERE code_hash = ${codeHash} AND is_active = TRUE
      LIMIT 1
    `;
    if (!rows || rows.length === 0) return null;
    return rows[0];
  } catch (err) {
    return null;
  }
}

async function redeemVoucherForUser({ voucherCode, authToken, fingerprint, ip, ipSubnet }) {
  const subnet = ipSubnet || getIpSubnet24(ip);
  const fp = normalizeFingerprint(fingerprint, subnet);
  const rateKey = `voucher:${fp}:${subnet}`;

  const rl = checkRateLimit(voucherAttempts, rateKey, 5, 15 * 60 * 1000);
  if (rl.blocked) {
    return {
      ok: false,
      status: 429,
      message: `Terlalu banyak percobaan voucher yang salah. Silakan tunggu ${Math.ceil(rl.waitSeconds / 60)} menit.`
    };
  }

  const user = await getAuthenticatedUser(authToken, fp);
  if (!user || user.deviceMismatch) {
    return {
      ok: false,
      status: 401,
      requireLogin: true,
      message: 'Silakan Login / Daftar akun terlebih dahulu (1 Device 1 Akun) sebelum mengaktifkan Kode Voucher.'
    };
  }

  const matchedVoucher = await verifySecretVoucherHash(voucherCode);
  if (!matchedVoucher) {
    recordFailedAttempt(voucherAttempts, rateKey);
    return {
      ok: false,
      status: 404,
      message: 'Kode Voucher tidak valid atau tidak terdaftar.'
    };
  }

  clearAttempts(voucherAttempts, rateKey);

  try {
    const sql = getSql();
    const durationDays = Number(matchedVoucher.duration_days || 30);
    const newExpiry = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString();

    await sql`
      UPDATE app_users
      SET
        tier = ${matchedVoucher.tier || 'premium'},
        daily_limit = ${matchedVoucher.daily_limit || PREMIUM_DAILY_LIMIT},
        premium_until = ${newExpiry},
        voucher_code = 'HASHED-PREMIUM-1M',
        updated_at = NOW()
      WHERE id = ${user.id}
    `;

    const updatedQuota = await getQuotaStatus({ fingerprint: fp, ip, ipSubnet: subnet, authToken });
    return {
      ok: true,
      status: 200,
      message: `${matchedVoucher.plan_label} berhasil diaktifkan di akun ${user.email}!`,
      quota: updatedQuota
    };
  } catch (err) {
    console.error('Error redeeming voucher:', err.message);
    return {
      ok: false,
      status: 500,
      message: 'Gagal mengaktifkan voucher ke akun.'
    };
  }
}

async function getFreeDeviceUsage(fingerprint, ipSubnet) {
  try {
    const sql = getSql();
    const rows = await sql`
      SELECT
        COALESCE(MAX(
          CASE
            WHEN daily_reset_date IS NULL OR daily_reset_date < CURRENT_DATE THEN 0
            ELSE COALESCE(free_activations_count, 0)
          END
        ), 0)::int AS used_today,
        MAX(last_free_activation_at) AS last_free_activation_at
      FROM device_records
      WHERE fingerprint = ${fingerprint}
         OR (ip_subnet IS NOT NULL AND ip_subnet = ${ipSubnet} AND ip_subnet != '127.0.0.0/24')
    `;

    const row = rows?.[0] || { used_today: 0, last_free_activation_at: null };
    const usedToday = Number(row.used_today || 0);
    let cooldownRemaining = 0;

    if (row.last_free_activation_at) {
      const elapsedSec = Math.floor((Date.now() - new Date(row.last_free_activation_at).getTime()) / 1000);
      if (elapsedSec < FREE_COOLDOWN_SECONDS) {
        cooldownRemaining = FREE_COOLDOWN_SECONDS - elapsedSec;
      }
    }

    return {
      usedToday,
      limit: FREE_DAILY_LIMIT,
      remaining: Math.max(0, FREE_DAILY_LIMIT - usedToday),
      cooldownSeconds: cooldownRemaining,
      lastActivationAt: row.last_free_activation_at || null
    };
  } catch (err) {
    const mem = memoryDevices.get(fingerprint) || { usedToday: 0, lastAt: 0, date: new Date().toISOString().slice(0, 10) };
    const today = new Date().toISOString().slice(0, 10);
    if (mem.date !== today) {
      mem.usedToday = 0;
      mem.date = today;
    }
    const elapsedSec = mem.lastAt ? Math.floor((Date.now() - mem.lastAt) / 1000) : 999999;
    const cooldownRemaining = elapsedSec < FREE_COOLDOWN_SECONDS ? FREE_COOLDOWN_SECONDS - elapsedSec : 0;
    return {
      usedToday: mem.usedToday,
      limit: FREE_DAILY_LIMIT,
      remaining: Math.max(0, FREE_DAILY_LIMIT - mem.usedToday),
      cooldownSeconds: cooldownRemaining,
      lastActivationAt: mem.lastAt ? new Date(mem.lastAt).toISOString() : null
    };
  }
}

async function getQuotaStatus({ fingerprint, ip, ipSubnet, authToken, voucherCode }) {
  const subnet = ipSubnet || getIpSubnet24(ip);
  const fp = normalizeFingerprint(fingerprint, subnet);
  const freeUsage = await getFreeDeviceUsage(fp, subnet);

  // Check logged-in user (1 Device 1 Account)
  const user = await getAuthenticatedUser(authToken, fp);
  if (user && !user.deviceMismatch) {
    const isPremActive =
      (user.tier === 'premium' || user.tier === 'reseller') &&
      user.premium_until &&
      new Date(user.premium_until) > new Date();

    if (isPremActive) {
      const limit = Number(user.daily_limit || PREMIUM_DAILY_LIMIT);
      const used = Number(user.used_today || 0);
      return {
        loggedIn: true,
        accountEmail: user.email,
        deviceLocked: true,
        tier: user.tier,
        isPremium: true,
        canBulk: true,
        planLabel: 'Premium Pass (1 Bulan)',
        premiumUntil: user.premium_until,
        usedToday: used,
        limit,
        remaining: Math.max(0, limit - used),
        cooldownSeconds: 0,
        fingerprint: fp,
        ipSubnet: subnet
      };
    }

    // Logged-in Free Tier user: combine account usage and device/subnet usage for anti-bypass
    const used = Math.max(Number(user.used_today || 0), freeUsage.usedToday);
    let userCooldown = freeUsage.cooldownSeconds;
    if (user.last_activation_at) {
      const elapsed = Math.floor((Date.now() - new Date(user.last_activation_at).getTime()) / 1000);
      if (elapsed < FREE_COOLDOWN_SECONDS) {
        userCooldown = Math.max(userCooldown, FREE_COOLDOWN_SECONDS - elapsed);
      }
    }

    return {
      loggedIn: true,
      accountEmail: user.email,
      deviceLocked: true,
      tier: 'free',
      isPremium: false,
      canBulk: false,
      planLabel: 'Free Tier (Akun Terkunci)',
      premiumUntil: null,
      usedToday: used,
      limit: FREE_DAILY_LIMIT,
      remaining: Math.max(0, FREE_DAILY_LIMIT - used),
      cooldownSeconds: userCooldown,
      fingerprint: fp,
      ipSubnet: subnet
    };
  }

  return {
    loggedIn: false,
    accountEmail: null,
    deviceLocked: false,
    deviceMismatch: Boolean(user?.deviceMismatch),
    tier: 'free',
    isPremium: false,
    canBulk: false,
    planLabel: 'Mode Gratis (Belum Login)',
    premiumUntil: null,
    usedToday: freeUsage.usedToday,
    limit: freeUsage.limit,
    remaining: freeUsage.remaining,
    cooldownSeconds: freeUsage.cooldownSeconds,
    fingerprint: fp,
    ipSubnet: subnet
  };
}

async function checkQuotaAllowed(context, requestedCount = 1) {
  const status = await getQuotaStatus(context);

  if (status.deviceMismatch) {
    return {
      allowed: false,
      status,
      message: 'Sesi ditolak: Akun ini terikat pada perangkat lain (Aturan 1 Device 1 Akun).'
    };
  }

  if (status.remaining < requestedCount) {
    if (status.isPremium) {
      return {
        allowed: false,
        status,
        message: `Kuota harian Premium Pass (${status.limit} akun/hari) sudah habis. Reset otomatis besok.`
      };
    }
    return {
      allowed: false,
      status,
      message: `Kuota Gratis harian habis (${status.usedToday}/${status.limit} akun/hari di perangkat/jaringan ini). Login & klaim Voucher Premium Pass untuk lanjut tanpa jeda.`
    };
  }

  if (!status.isPremium && status.cooldownSeconds > 0) {
    const mins = Math.floor(status.cooldownSeconds / 60);
    const secs = status.cooldownSeconds % 60;
    const waitLabel = mins > 0 ? `${mins} menit ${secs} detik` : `${secs} detik`;
    return {
      allowed: false,
      status,
      message: `Mode Gratis memiliki jeda cooldown 10 menit antar aktivasi. Tunggu ${waitLabel} lagi atau upgrade ke Premium Pass.`
    };
  }

  return {
    allowed: true,
    status
  };
}

async function recordActivation({ fingerprint, ip, ipSubnet, authToken, amEmail }) {
  const subnet = ipSubnet || getIpSubnet24(ip);
  const fp = normalizeFingerprint(fingerprint, subnet);
  const emailClean = String(amEmail || '-').trim().toLowerCase();

  try {
    const sql = getSql();
    let userId = null;
    let tierAtTime = 'free';

    const user = await getAuthenticatedUser(authToken, fp);
    if (user && !user.deviceMismatch) {
      userId = user.id;
      const isPremActive =
        (user.tier === 'premium' || user.tier === 'reseller') &&
        user.premium_until &&
        new Date(user.premium_until) > new Date();
      tierAtTime = isPremActive ? user.tier : 'free';

      await sql`
        UPDATE app_users
        SET
          daily_activations_count = CASE
            WHEN daily_reset_date IS NULL OR daily_reset_date < CURRENT_DATE THEN 1
            ELSE COALESCE(daily_activations_count, 0) + 1
          END,
          daily_reset_date = CURRENT_DATE,
          total_activations = COALESCE(total_activations, 0) + 1,
          last_activation_at = NOW(),
          device_fingerprint = COALESCE(device_fingerprint, ${fp}),
          ip_address = ${ip},
          updated_at = NOW()
        WHERE id = ${userId}
      `;
    }

    if (tierAtTime === 'free') {
      await sql`
        INSERT INTO device_records (fingerprint, ip_address, ip_subnet, free_activations_count, last_free_activation_at, daily_reset_date)
        VALUES (${fp}, ${ip}, ${subnet}, 1, NOW(), CURRENT_DATE)
        ON CONFLICT (fingerprint) DO UPDATE SET
          ip_address = EXCLUDED.ip_address,
          ip_subnet = EXCLUDED.ip_subnet,
          free_activations_count = CASE
            WHEN device_records.daily_reset_date IS NULL OR device_records.daily_reset_date < CURRENT_DATE THEN 1
            ELSE COALESCE(device_records.free_activations_count, 0) + 1
          END,
          last_free_activation_at = NOW(),
          daily_reset_date = CURRENT_DATE
      `;
    }

    await sql`
      INSERT INTO activation_logs (user_id, am_email, tier_at_time, ip_address)
      VALUES (${userId}, ${emailClean}, ${tierAtTime}, ${ip})
    `;
  } catch (err) {
    console.error('Error recording activation in Neon DB:', err.message);
    const today = new Date().toISOString().slice(0, 10);
    const mem = memoryDevices.get(fp) || { usedToday: 0, lastAt: 0, date: today };
    if (mem.date !== today) mem.usedToday = 0;
    mem.usedToday += 1;
    mem.lastAt = Date.now();
    mem.date = today;
    memoryDevices.set(fp, mem);
  }

  return getQuotaStatus({ fingerprint: fp, ip, ipSubnet: subnet, authToken });
}

module.exports = {
  FREE_DAILY_LIMIT,
  FREE_COOLDOWN_SECONDS,
  PREMIUM_DAILY_LIMIT,
  RESELLER_DAILY_LIMIT,
  extractClientIp,
  getIpSubnet24,
  normalizeFingerprint,
  extractClientContext,
  registerAppUser,
  loginAppUser,
  redeemVoucherForUser,
  getQuotaStatus,
  checkQuotaAllowed,
  recordActivation
};
