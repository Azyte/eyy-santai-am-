require('./env');
const crypto = require('crypto');
const { getSql } = require('./db');
const { getTrustedClientIp, consumeBucket, clearBucket } = require('./rate-limit');
const { scryptHash, scryptVerify } = require('./settings');

const FREE_DAILY_LIMIT = 3;
const FREE_COOLDOWN_SECONDS = 10 * 60;
const PREMIUM_DAILY_LIMIT = 10;
const RESELLER_DAILY_LIMIT = 25;
const BULK_MAX_ITEMS = 10;
const BULK_WEEKLY_SECONDS = 7 * 24 * 60 * 60;

// Ephemeral fallback avoids shipping a predictable static signing key in public source code.
const EPHEMERAL_KEY = crypto.randomBytes(32).toString('hex');
const TOKEN_SECRET = (process.env.SESSION_SECRET || '').trim() || EPHEMERAL_KEY;
const VOUCHER_PEPPER = (process.env.VOUCHER_PEPPER || '').trim() || 'dkaimono-voucher-pepper-v2';

const memoryDevices = new Map();

function getWibDateString() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
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

// Strip minor browser build numbers so routine Chrome/Safari auto-updates do not break hardware locks.
function sanitizeUserAgentFamily(ua = '') {
  return String(ua)
    .replace(/\/[\d.]+/g, '')
    .slice(0, 120);
}

function normalizeFingerprint(rawFp, ipSubnet, userAgent = '') {
  if (rawFp && typeof rawFp === 'string' && rawFp.trim().length >= 8) {
    return rawFp.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 96);
  }
  const hash = crypto
    .createHash('sha256')
    .update(`${ipSubnet}|${sanitizeUserAgentFamily(userAgent)}`)
    .digest('hex')
    .slice(0, 24);
  return `fp_${hash}`;
}

function hashVoucherCode(rawCode) {
  const clean = String(rawCode || '').trim().toUpperCase();
  if (!clean) return '';
  return crypto
    .createHash('sha256')
    .update(`dkm-v2::${clean}::${VOUCHER_PEPPER}`)
    .digest('hex');
}

function maskVoucherHint(rawCode) {
  const clean = String(rawCode || '').trim().toUpperCase();
  if (clean.length <= 6) return clean.slice(0, 2) + '****';
  return `${clean.slice(0, 5)}-****-${clean.slice(-4)}`;
}

function generatePlainVoucherCode(prefix = 'DKPRO') {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const seg = len => {
    let out = '';
    for (let i = 0; i < len; i++) {
      out += alphabet[crypto.randomInt(0, alphabet.length)];
    }
    return out;
  };
  const cleanPrefix = String(prefix || 'DKPRO').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'DKPRO';
  return `${cleanPrefix}-${seg(4)}-${seg(4)}`;
}

function createSessionToken(user, fingerprint) {
  const payload = {
    role: 'user',
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
    if (payload.role && payload.role !== 'user') return null;
    if (currentFingerprint && payload.fp && payload.fp !== currentFingerprint) {
      return { ...payload, deviceMismatch: true };
    }
    return payload;
  } catch {
    return null;
  }
}

function createAdminToken() {
  const payload = {
    role: 'admin',
    iat: Date.now(),
    exp: Date.now() + 12 * 60 * 60 * 1000
  };
  const dataB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(dataB64).digest('base64url');
  return `${dataB64}.${sig}`;
}

function verifyAdminToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [dataB64, sig] = token.split('.');
  if (!dataB64 || !sig) return false;
  const expectedSig = crypto.createHmac('sha256', TOKEN_SECRET).update(dataB64).digest('base64url');
  if (sig.length !== expectedSig.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return false;
  try {
    const payload = JSON.parse(Buffer.from(dataB64, 'base64url').toString('utf8'));
    return payload.role === 'admin' && payload.exp > Date.now();
  } catch {
    return false;
  }
}

function extractClientContext(req) {
  const ip = getTrustedClientIp(req);
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

  const rl = await consumeBucket(`reg:${subnet}`, 5, 30 * 60 * 1000);
  if (rl.blocked) {
    return {
      ok: false,
      status: 429,
      message: `Terlalu banyak pendaftaran dari jaringan ini. Tunggu ${Math.ceil(rl.waitSeconds / 60)} menit.`
    };
  }

  const sql = getSql();
  if (!sql) {
    return { ok: false, status: 503, message: 'Database server belum dikonfigurasi.' };
  }

  try {
    const existingEmail = await sql`
      SELECT id FROM app_users WHERE LOWER(email) = ${em} LIMIT 1
    `;
    if (existingEmail && existingEmail.length > 0) {
      return {
        ok: false,
        status: 409,
        message: 'Email ini sudah terdaftar. Silakan masuk melalui tab Login.'
      };
    }

    const existingDevice = await sql`
      SELECT id FROM app_users WHERE device_fingerprint = ${fp} LIMIT 1
    `;
    if (existingDevice && existingDevice.length > 0) {
      return {
        ok: false,
        status: 403,
        message: 'Perangkat ini sudah terikat dengan akun lain (aturan 1 Perangkat = 1 Akun).'
      };
    }

    const pwHash = scryptHash(pw);
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
      VALUES (
        ${em},
        ${pwHash},
        'free',
        ${FREE_DAILY_LIMIT},
        ${fp},
        ${ip},
        0,
        (NOW() AT TIME ZONE 'Asia/Jakarta')::date
      )
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
      message: 'Akun berhasil dibuat dan dikunci ke perangkat ini.'
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

  if (!em || !pw) {
    return { ok: false, status: 400, message: 'Email dan password wajib diisi.' };
  }

  const sql = getSql();
  if (!sql) {
    return { ok: false, status: 503, message: 'Database server belum dikonfigurasi.' };
  }

  const rl = await consumeBucket(rateKey, 6, 15 * 60 * 1000);
  if (rl.blocked) {
    return {
      ok: false,
      status: 429,
      message: `Terlalu banyak percobaan login gagal. Tunggu ${Math.ceil(rl.waitSeconds / 60)} menit.`
    };
  }

  try {
    const rows = await sql`
      SELECT id, email, password_hash, tier, daily_limit, premium_until, device_fingerprint
      FROM app_users
      WHERE LOWER(email) = ${em}
      LIMIT 1
    `;

    if (!rows || rows.length === 0 || !scryptVerify(pw, rows[0].password_hash)) {
      return { ok: false, status: 401, message: 'Email atau password salah.' };
    }

    const user = rows[0];

    if (user.device_fingerprint && user.device_fingerprint !== fp) {
      return {
        ok: false,
        status: 403,
        message: 'Akun ini sudah dikunci pada perangkat lain. Hubungi Admin WhatsApp jika Anda baru berganti HP.'
      };
    }

    const otherAccOnDevice = await sql`
      SELECT id FROM app_users
      WHERE device_fingerprint = ${fp} AND id != ${user.id}
      LIMIT 1
    `;
    if (otherAccOnDevice && otherAccOnDevice.length > 0) {
      return {
        ok: false,
        status: 403,
        message: 'Perangkat ini sudah terikat dengan akun lain (1 Perangkat = 1 Akun).'
      };
    }

    if (!user.device_fingerprint) {
      await sql`
        UPDATE app_users
        SET device_fingerprint = ${fp}, ip_address = ${ip}, updated_at = NOW()
        WHERE id = ${user.id}
      `;
    }

    await clearBucket(rateKey);
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
      message: 'Berhasil masuk. Sesi perangkat terverifikasi.'
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

  const sql = getSql();
  if (!sql) return null;

  try {
    const rows = await sql`
      SELECT
        id,
        email,
        tier,
        COALESCE(daily_limit, CASE WHEN tier = 'reseller' THEN 25 WHEN tier = 'premium' THEN 10 ELSE 3 END) AS daily_limit,
        premium_until,
        device_fingerprint,
        CASE
          WHEN daily_reset_date IS NULL OR daily_reset_date < (NOW() AT TIME ZONE 'Asia/Jakarta')::date THEN 0
          ELSE COALESCE(daily_activations_count, 0)
        END AS used_today,
        last_activation_at,
        last_bulk_at
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
  } catch {
    return null;
  }
}

async function redeemVoucherForUser({ voucherCode, authToken, fingerprint, ip, ipSubnet }) {
  const subnet = ipSubnet || getIpSubnet24(ip);
  const fp = normalizeFingerprint(fingerprint, subnet);
  const rateKey = `voucher:${fp}:${subnet}`;

  const user = await getAuthenticatedUser(authToken, fp);
  if (!user || user.deviceMismatch) {
    return {
      ok: false,
      status: 401,
      requireLogin: true,
      message: 'Silakan Login / Daftar akun terlebih dahulu sebelum mengklaim Kode Voucher.'
    };
  }

  const sql = getSql();
  if (!sql) {
    return { ok: false, status: 503, message: 'Database server belum dikonfigurasi.' };
  }

  const rl = await consumeBucket(rateKey, 5, 15 * 60 * 1000);
  if (rl.blocked) {
    return {
      ok: false,
      status: 429,
      message: `Terlalu banyak percobaan voucher yang salah. Tunggu ${Math.ceil(rl.waitSeconds / 60)} menit.`
    };
  }

  const codeHash = hashVoucherCode(voucherCode);
  if (!codeHash) {
    return { ok: false, status: 400, message: 'Masukkan kode voucher yang valid.' };
  }

  try {
    const vRows = await sql`
      SELECT id, plan_label, tier, daily_limit, duration_days, max_uses, used_count, expires_at, is_active
      FROM vouchers
      WHERE code_hash = ${codeHash}
      LIMIT 1
    `;

    if (!vRows || vRows.length === 0) {
      return { ok: false, status: 404, message: 'Kode Voucher tidak ditemukan atau salah ketik.' };
    }

    const v = vRows[0];
    if (!v.is_active || Number(v.used_count) >= Number(v.max_uses)) {
      return { ok: false, status: 410, message: 'Kode Voucher ini sudah habis terpakai atau dinonaktifkan.' };
    }
    if (v.expires_at && new Date(v.expires_at) <= new Date()) {
      return { ok: false, status: 410, message: 'Masa klaim Kode Voucher ini sudah kedaluwarsa.' };
    }

    const dupCheck = await sql`
      SELECT id FROM voucher_redemptions
      WHERE voucher_id = ${v.id} AND user_id = ${user.id}
      LIMIT 1
    `;
    if (dupCheck && dupCheck.length > 0) {
      return { ok: false, status: 409, message: 'Anda sudah pernah mengklaim kode voucher ini sebelumnya.' };
    }

    // Atomic increment prevents parallel double-spend when two requests submit the same single-use code.
    const claimed = await sql`
      UPDATE vouchers
      SET
        used_count = used_count + 1,
        is_active = CASE WHEN used_count + 1 >= max_uses THEN FALSE ELSE is_active END
      WHERE id = ${v.id}
        AND is_active = TRUE
        AND used_count < max_uses
      RETURNING id
    `;
    if (!claimed || claimed.length === 0) {
      return { ok: false, status: 409, message: 'Kode Voucher baru saja habis diklaim pengguna lain.' };
    }

    await sql`
      INSERT INTO voucher_redemptions (voucher_id, user_id, ip_address)
      VALUES (${v.id}, ${user.id}, ${ip})
    `;

    const durationDays = Math.max(1, Number(v.duration_days || 30));
    const nowMs = Date.now();
    const existingMs = user.premium_until ? new Date(user.premium_until).getTime() : 0;
    const baseMs = existingMs > nowMs ? existingMs : nowMs;
    const newExpiryIso = new Date(baseMs + durationDays * 86400 * 1000).toISOString();
    const nextTier = v.tier === 'reseller' || user.tier === 'reseller' ? 'reseller' : (v.tier || 'premium');
    const nextDailyLimit = Math.max(Number(v.daily_limit || PREMIUM_DAILY_LIMIT), nextTier === 'reseller' ? RESELLER_DAILY_LIMIT : PREMIUM_DAILY_LIMIT);

    await sql`
      UPDATE app_users
      SET
        tier = ${nextTier},
        daily_limit = ${nextDailyLimit},
        premium_until = ${newExpiryIso},
        updated_at = NOW()
      WHERE id = ${user.id}
    `;

    await clearBucket(rateKey);
    const updatedQuota = await getQuotaStatus({ fingerprint: fp, ip, ipSubnet: subnet, authToken });

    return {
      ok: true,
      status: 200,
      message: `${v.plan_label} berhasil diaktifkan untuk ${user.email} (+${durationDays} hari).`,
      quota: updatedQuota
    };
  } catch (err) {
    console.error('Redeem voucher error:', err.message);
    return { ok: false, status: 500, message: 'Gagal memproses klaim voucher di server.' };
  }
}

async function getFreeDeviceUsage(fingerprint, ipSubnet) {
  const sql = getSql();
  if (sql) {
    try {
      const rows = await sql`
        SELECT
          COALESCE(MAX(
            CASE
              WHEN daily_reset_date IS NULL OR daily_reset_date < (NOW() AT TIME ZONE 'Asia/Jakarta')::date THEN 0
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
    } catch {}
  }

  const today = getWibDateString();
  const mem = memoryDevices.get(fingerprint) || { usedToday: 0, lastAt: 0, date: today };
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

function computeBulkCooldown(tier, lastBulkAt) {
  if (tier === 'reseller') {
    return { bulkCooldownSeconds: 0, nextBulkAt: null };
  }
  if (!lastBulkAt) {
    return { bulkCooldownSeconds: 0, nextBulkAt: null };
  }
  const lastMs = new Date(lastBulkAt).getTime();
  const elapsedSec = Math.floor((Date.now() - lastMs) / 1000);
  if (elapsedSec >= BULK_WEEKLY_SECONDS) {
    return { bulkCooldownSeconds: 0, nextBulkAt: null };
  }
  const rem = BULK_WEEKLY_SECONDS - elapsedSec;
  return {
    bulkCooldownSeconds: rem,
    nextBulkAt: new Date(lastMs + BULK_WEEKLY_SECONDS * 1000).toISOString()
  };
}

async function getQuotaStatus({ fingerprint, ip, ipSubnet, authToken }) {
  const subnet = ipSubnet || getIpSubnet24(ip);
  const fp = normalizeFingerprint(fingerprint, subnet);
  const freeUsage = await getFreeDeviceUsage(fp, subnet);

  const user = await getAuthenticatedUser(authToken, fp);
  if (user && !user.deviceMismatch) {
    const isPremActive =
      (user.tier === 'premium' || user.tier === 'reseller') &&
      user.premium_until &&
      new Date(user.premium_until) > new Date();

    if (isPremActive) {
      const limit = Number(user.daily_limit || (user.tier === 'reseller' ? RESELLER_DAILY_LIMIT : PREMIUM_DAILY_LIMIT));
      const used = Number(user.used_today || 0);
      const bulkInfo = computeBulkCooldown(user.tier, user.last_bulk_at);
      return {
        loggedIn: true,
        accountEmail: user.email,
        deviceLocked: true,
        tier: user.tier,
        isPremium: true,
        canBulk: true,
        bulkMaxItems: BULK_MAX_ITEMS,
        bulkCooldownSeconds: bulkInfo.bulkCooldownSeconds,
        nextBulkAt: bulkInfo.nextBulkAt,
        planLabel: user.tier === 'reseller' ? 'Reseller Pass' : 'Premium Pass',
        premiumUntil: user.premium_until,
        usedToday: used,
        limit,
        remaining: Math.max(0, limit - used),
        cooldownSeconds: 0,
        fingerprint: fp,
        ipSubnet: subnet
      };
    }

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
      bulkMaxItems: BULK_MAX_ITEMS,
      bulkCooldownSeconds: 0,
      nextBulkAt: null,
      planLabel: 'Mode Gratis (Terdaftar)',
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
    bulkMaxItems: BULK_MAX_ITEMS,
    bulkCooldownSeconds: 0,
    nextBulkAt: null,
    planLabel: 'Mode Gratis',
    premiumUntil: null,
    usedToday: freeUsage.usedToday,
    limit: freeUsage.limit,
    remaining: freeUsage.remaining,
    cooldownSeconds: freeUsage.cooldownSeconds,
    fingerprint: fp,
    ipSubnet: subnet
  };
}

async function checkQuotaAllowed(context, requestedCount = 1, options = { isBulk: false }) {
  const status = await getQuotaStatus(context);

  if (status.deviceMismatch) {
    return {
      allowed: false,
      status,
      message: 'Sesi ditolak: Akun ini terikat pada perangkat lain (aturan 1 Perangkat = 1 Akun).'
    };
  }

  if (options.isBulk) {
    if (!status.isPremium || !status.canBulk) {
      return {
        allowed: false,
        status,
        message: 'Fitur Bulk Grosir khusus pengguna Voucher Premium Pass atau Reseller Pass.'
      };
    }
    if (status.bulkCooldownSeconds > 0) {
      const daysLeft = Math.ceil(status.bulkCooldownSeconds / 86400);
      return {
        allowed: false,
        status,
        message: `Paket Premium Pass membatasi Bulk Grosir 1x per 7 hari (tersedia lagi dalam ~${daysLeft} hari). Upgrade ke Reseller Pass untuk Bulk harian.`
      };
    }
  }

  if (status.remaining < requestedCount) {
    if (status.isPremium) {
      return {
        allowed: false,
        status,
        message: `Kuota harian ${status.planLabel} (${status.limit} akun/hari) sudah terpakai. Reset otomatis pukul 00:00 WIB.`
      };
    }
    return {
      allowed: false,
      status,
      message: `Kuota Gratis harian habis (${status.usedToday}/${status.limit} akun/hari di jaringan ini). Klaim atau beli Voucher Premium via WhatsApp untuk lanjut tanpa jeda.`
    };
  }

  if (!status.isPremium && status.cooldownSeconds > 0) {
    const mins = Math.floor(status.cooldownSeconds / 60);
    const secs = status.cooldownSeconds % 60;
    const waitLabel = mins > 0 ? `${mins} menit ${secs} detik` : `${secs} detik`;
    return {
      allowed: false,
      status,
      message: `Mode Gratis memiliki jeda tunggu 10 menit antar aktivasi. Tunggu ${waitLabel} lagi atau aktifkan Voucher Premium.`
    };
  }

  return { allowed: true, status };
}

async function recordActivation({ fingerprint, ip, ipSubnet, authToken, amEmail, actionType = 'activate', markBulkUsed = false }) {
  const subnet = ipSubnet || getIpSubnet24(ip);
  const fp = normalizeFingerprint(fingerprint, subnet);
  const emailClean = String(amEmail || '-').trim().toLowerCase();
  const sql = getSql();

  if (sql) {
    try {
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

        if (actionType !== 'renew') {
          await sql`
            UPDATE app_users
            SET
              daily_activations_count = CASE
                WHEN daily_reset_date IS NULL OR daily_reset_date < (NOW() AT TIME ZONE 'Asia/Jakarta')::date THEN 1
                ELSE COALESCE(daily_activations_count, 0) + 1
              END,
              daily_reset_date = (NOW() AT TIME ZONE 'Asia/Jakarta')::date,
              total_activations = COALESCE(total_activations, 0) + 1,
              last_activation_at = NOW(),
              last_bulk_at = CASE WHEN ${Boolean(markBulkUsed)} THEN NOW() ELSE last_bulk_at END,
              device_fingerprint = COALESCE(device_fingerprint, ${fp}),
              ip_address = ${ip},
              updated_at = NOW()
            WHERE id = ${userId}
          `;
        }
      }

      if (tierAtTime === 'free' && actionType !== 'renew') {
        await sql`
          INSERT INTO device_records (
            fingerprint,
            ip_address,
            ip_subnet,
            free_activations_count,
            last_free_activation_at,
            daily_reset_date
          )
          VALUES (
            ${fp},
            ${ip},
            ${subnet},
            1,
            NOW(),
            (NOW() AT TIME ZONE 'Asia/Jakarta')::date
          )
          ON CONFLICT (fingerprint) DO UPDATE SET
            ip_address = EXCLUDED.ip_address,
            ip_subnet = EXCLUDED.ip_subnet,
            free_activations_count = CASE
              WHEN device_records.daily_reset_date IS NULL OR device_records.daily_reset_date < (NOW() AT TIME ZONE 'Asia/Jakarta')::date THEN 1
              ELSE COALESCE(device_records.free_activations_count, 0) + 1
            END,
            last_free_activation_at = NOW(),
            daily_reset_date = (NOW() AT TIME ZONE 'Asia/Jakarta')::date
        `;
      }

      await sql`
        INSERT INTO activation_logs (user_id, am_email, action_type, tier_at_time, ip_address)
        VALUES (${userId}, ${emailClean}, ${actionType}, ${tierAtTime}, ${ip})
      `;
    } catch (err) {
      console.error('Error recording activation:', err.message);
    }
  } else if (actionType !== 'renew') {
    const today = getWibDateString();
    const mem = memoryDevices.get(fp) || { usedToday: 0, lastAt: 0, date: today };
    if (mem.date !== today) mem.usedToday = 0;
    mem.usedToday += 1;
    mem.lastAt = Date.now();
    mem.date = today;
    memoryDevices.set(fp, mem);
  }

  return getQuotaStatus({ fingerprint: fp, ip, ipSubnet: subnet, authToken });
}

async function createVoucherBatch({
  count = 1,
  customCode = '',
  prefix = 'DKPRO',
  planLabel = 'Premium Pass (30 Hari)',
  tier = 'premium',
  dailyLimit = 10,
  durationDays = 30,
  maxUses = 1,
  note = ''
}) {
  const sql = getSql();
  if (!sql) throw new Error('Database belum terhubung.');

  const safeTier = tier === 'reseller' ? 'reseller' : 'premium';
  const safeLimit = Math.max(1, Math.min(200, Number(dailyLimit) || (safeTier === 'reseller' ? RESELLER_DAILY_LIMIT : PREMIUM_DAILY_LIMIT)));
  const safeDays = Math.max(1, Math.min(365, Number(durationDays) || 30));
  const safeMaxUses = Math.max(1, Math.min(1000, Number(maxUses) || 1));
  const safeLabel = String(planLabel || 'Premium Pass (30 Hari)').trim().slice(0, 100);
  const safeNote = String(note || '').trim().slice(0, 200) || null;

  const batchSize = customCode.trim() ? 1 : Math.max(1, Math.min(50, Number(count) || 1));
  const generatedCodes = [];

  for (let i = 0; i < batchSize; i++) {
    const plain = customCode.trim()
      ? customCode.trim().toUpperCase()
      : generatePlainVoucherCode(prefix);
    const codeHash = hashVoucherCode(plain);
    const codeHint = maskVoucherHint(plain);

    const inserted = await sql`
      INSERT INTO vouchers (
        code_hash,
        code_hint,
        plan_label,
        tier,
        daily_limit,
        duration_days,
        max_uses,
        used_count,
        is_active,
        note
      )
      VALUES (
        ${codeHash},
        ${codeHint},
        ${safeLabel},
        ${safeTier},
        ${safeLimit},
        ${safeDays},
        ${safeMaxUses},
        0,
        TRUE,
        ${safeNote}
      )
      ON CONFLICT (code_hash) DO NOTHING
      RETURNING id, code_hint, plan_label, tier, daily_limit, duration_days, max_uses, used_count, is_active, note, created_at
    `;

    if (inserted && inserted.length > 0) {
      generatedCodes.push({
        ...inserted[0],
        plainCode: plain
      });
    } else if (customCode.trim()) {
      throw new Error('Kode voucher kustom tersebut sudah pernah dibuat sebelumnya.');
    }
  }

  return generatedCodes;
}

module.exports = {
  FREE_DAILY_LIMIT,
  FREE_COOLDOWN_SECONDS,
  PREMIUM_DAILY_LIMIT,
  RESELLER_DAILY_LIMIT,
  BULK_MAX_ITEMS,
  getIpSubnet24,
  normalizeFingerprint,
  hashVoucherCode,
  createAdminToken,
  verifyAdminToken,
  extractClientContext,
  registerAppUser,
  loginAppUser,
  redeemVoucherForUser,
  getQuotaStatus,
  checkQuotaAllowed,
  recordActivation,
  createVoucherBatch
};
