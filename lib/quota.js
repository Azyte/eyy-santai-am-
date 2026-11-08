const crypto = require('crypto');
const { getSql } = require('./db');

const FREE_DAILY_LIMIT = 3;
const FREE_COOLDOWN_SECONDS = 10 * 60; // 10 minutes
const PREMIUM_DAILY_LIMIT = 10;
const RESELLER_DAILY_LIMIT = 25;

// In-memory fallback if DB is temporarily unreachable
const memoryDevices = new Map();

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

function extractClientContext(req) {
  const ip = extractClientIp(req);
  const ipSubnet = getIpSubnet24(ip);
  const rawFp =
    req.headers['x-device-fingerprint'] ||
    req.body?.fingerprint ||
    req.query?.fingerprint ||
    '';
  const voucherCode = (
    req.headers['x-voucher-code'] ||
    req.body?.voucherCode ||
    req.query?.voucherCode ||
    ''
  )
    .toString()
    .trim()
    .toUpperCase();
  const fingerprint = normalizeFingerprint(rawFp, ipSubnet, req.headers['user-agent'] || '');
  return { ip, ipSubnet, fingerprint, voucherCode };
}

async function getVoucherUser(voucherCode) {
  if (!voucherCode) return null;
  const code = String(voucherCode).trim().toUpperCase();
  try {
    const sql = getSql();
    const rows = await sql`
      SELECT
        id,
        email,
        tier,
        voucher_code,
        COALESCE(daily_limit, CASE WHEN tier = 'reseller' THEN 25 ELSE 10 END) AS daily_limit,
        premium_until,
        CASE
          WHEN daily_reset_date IS NULL OR daily_reset_date < CURRENT_DATE THEN 0
          ELSE COALESCE(daily_activations_count, 0)
        END AS used_today,
        total_activations,
        last_activation_at
      FROM app_users
      WHERE UPPER(voucher_code) = ${code}
      LIMIT 1
    `;
    if (!rows || rows.length === 0) return null;
    const u = rows[0];
    if (u.premium_until && new Date(u.premium_until) < new Date()) {
      return { ...u, expired: true };
    }
    return { ...u, expired: false };
  } catch (err) {
    console.error('Error querying voucher user:', err.message);
    return null;
  }
}

async function getFreeDeviceUsage(fingerprint, ipSubnet) {
  try {
    const sql = getSql();
    // Anti-bypass: check both device fingerprint AND /24 IP subnet for today's usage & cooldown
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

async function getQuotaStatus({ fingerprint, ip, ipSubnet, voucherCode }) {
  const subnet = ipSubnet || getIpSubnet24(ip);
  const fp = normalizeFingerprint(fingerprint, subnet);

  if (voucherCode) {
    const vUser = await getVoucherUser(voucherCode);
    if (vUser && !vUser.expired) {
      const limit = Number(vUser.daily_limit || (vUser.tier === 'reseller' ? RESELLER_DAILY_LIMIT : PREMIUM_DAILY_LIMIT));
      const used = Number(vUser.used_today || 0);
      return {
        tier: vUser.tier || 'premium',
        isPremium: true,
        canBulk: true,
        voucherCode: vUser.voucher_code,
        voucherValid: true,
        premiumUntil: vUser.premium_until,
        usedToday: used,
        limit,
        remaining: Math.max(0, limit - used),
        cooldownSeconds: 0,
        fingerprint: fp,
        ipSubnet: subnet
      };
    }
  }

  const freeUsage = await getFreeDeviceUsage(fp, subnet);
  return {
    tier: 'free',
    isPremium: false,
    canBulk: false,
    voucherCode: null,
    voucherValid: voucherCode ? false : null,
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

  if (context.voucherCode && status.voucherValid === false) {
    return {
      allowed: false,
      status,
      message: 'Kode Voucher tidak ditemukan atau sudah kedaluwarsa.'
    };
  }

  if (status.remaining < requestedCount) {
    if (status.isPremium) {
      return {
        allowed: false,
        status,
        message: `Kuota harian Voucher (${status.limit} akun/hari) sudah habis. Reset otomatis besok.`
      };
    }
    return {
      allowed: false,
      status,
      message: `Kuota Gratis harian habis (${status.usedToday}/${status.limit} akun/hari di perangkat/jaringan ini). Masukkan Kode Voucher Premium untuk lanjut tanpa batas jeda.`
    };
  }

  if (!status.isPremium && status.cooldownSeconds > 0) {
    const mins = Math.floor(status.cooldownSeconds / 60);
    const secs = status.cooldownSeconds % 60;
    const waitLabel = mins > 0 ? `${mins} menit ${secs} detik` : `${secs} detik`;
    return {
      allowed: false,
      status,
      message: `Mode Gratis memiliki jeda cooldown 10 menit antar aktivasi. Tunggu ${waitLabel} lagi atau gunakan Voucher Premium.`
    };
  }

  return {
    allowed: true,
    status
  };
}

async function recordActivation({ fingerprint, ip, ipSubnet, voucherCode, amEmail }) {
  const subnet = ipSubnet || getIpSubnet24(ip);
  const fp = normalizeFingerprint(fingerprint, subnet);
  const emailClean = String(amEmail || '-').trim().toLowerCase();

  try {
    const sql = getSql();
    let userId = null;
    let tierAtTime = 'free';

    if (voucherCode) {
      const vUser = await getVoucherUser(voucherCode);
      if (vUser && !vUser.expired) {
        userId = vUser.id;
        tierAtTime = vUser.tier || 'premium';
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
            device_fingerprint = ${fp},
            ip_address = ${ip},
            updated_at = NOW()
          WHERE id = ${userId}
        `;
      }
    }

    if (!userId) {
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

  return getQuotaStatus({ fingerprint: fp, ip, ipSubnet: subnet, voucherCode });
}

async function createVoucherInvoice({ plan = 'premium', buyerEmail = '' }) {
  const isReseller = plan === 'reseller' || plan === 'bulk';
  const normalizedPlan = isReseller ? 'reseller' : 'premium';
  const amount = isReseller ? 35000 : 15000;
  const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  const invoiceCode = `INV-${Date.now().toString(36).toUpperCase()}-${suffix}`;
  const qrisPayload = `00020101021226610014ID.DKAIMONO.WWW01189360091431234567890215${invoiceCode}5204581253033605405${amount}5802ID5911DKAIMONO AM6007JAKARTA6304A1B2`;

  try {
    const sql = getSql();
    await sql`
      INSERT INTO payments (invoice_code, plan, amount, payment_method, payment_status, qris_url)
      VALUES (${invoiceCode}, ${normalizedPlan}, ${amount}, 'QRIS', 'unpaid', ${qrisPayload})
    `;
  } catch (err) {
    console.error('Error creating payment invoice:', err.message);
  }

  return {
    invoiceCode,
    plan: normalizedPlan,
    planLabel: isReseller ? 'Reseller / Bulk Pass (25 Akun/Hari)' : 'Premium Pass (10 Akun/Hari)',
    amount,
    paymentMethod: 'QRIS',
    paymentStatus: 'unpaid',
    qrisPayload,
    buyerEmail
  };
}

async function confirmVoucherInvoice({ invoiceCode, fingerprint = '', ip = '' }) {
  if (!invoiceCode) return { ok: false, message: 'Kode invoice wajib diisi.' };
  const code = String(invoiceCode).trim().toUpperCase();

  try {
    const sql = getSql();
    const invRows = await sql`
      SELECT id, invoice_code, plan, amount, payment_status
      FROM payments
      WHERE UPPER(invoice_code) = ${code}
      LIMIT 1
    `;

    const plan = invRows?.[0]?.plan || (code.includes('BULK') ? 'reseller' : 'premium');
    const isReseller = plan === 'reseller';
    const prefix = isReseller ? 'DK-BULK' : 'DK-PRO';
    const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
    const generatedVoucher = `${prefix}-${rand}`;
    const dailyLimit = isReseller ? RESELLER_DAILY_LIMIT : PREMIUM_DAILY_LIMIT;
    const dummyEmail = `${generatedVoucher.toLowerCase()}@voucher.dkaimono.web.id`;

    const userRows = await sql`
      INSERT INTO app_users (email, password_hash, tier, voucher_code, daily_limit, premium_until, device_fingerprint, ip_address)
      VALUES (${dummyEmail}, 'qris-paid', ${plan}, ${generatedVoucher}, ${dailyLimit}, NOW() + INTERVAL '30 days', ${fingerprint}, ${ip})
      RETURNING id, voucher_code, tier, daily_limit, premium_until
    `;

    const userId = userRows?.[0]?.id || null;

    if (invRows && invRows.length > 0) {
      await sql`
        UPDATE payments
        SET payment_status = 'paid', user_id = ${userId}, paid_at = NOW()
        WHERE id = ${invRows[0].id}
      `;
    }

    return {
      ok: true,
      voucherCode: generatedVoucher,
      tier: plan,
      dailyLimit,
      premiumUntil: userRows?.[0]?.premium_until || new Date(Date.now() + 30 * 86400000).toISOString()
    };
  } catch (err) {
    console.error('Error confirming invoice:', err.message);
    return { ok: false, message: 'Gagal memverifikasi pembayaran di database.' };
  }
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
  getQuotaStatus,
  checkQuotaAllowed,
  recordActivation,
  createVoucherInvoice,
  confirmVoucherInvoice
};
