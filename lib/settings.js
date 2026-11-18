const { getEnv } = require('./env');
const crypto = require('crypto');
const { getSql } = require('./db');

const DEFAULT_STORE_CONFIG = {
  whatsappNumber: getEnv('ADMIN_WHATSAPP').replace(/[^0-9]/g, ''),
  whatsappGreeting: 'Halo Admin DKaimono-AM, saya ingin membeli Kode Voucher:',
  storeNotice: 'Pembelian kode voucher dilayani langsung via WhatsApp Admin dan langsung aktif setelah diklaim.',
  plans: [
    {
      id: 'premium-30d',
      name: 'Premium Pass (30 Hari)',
      tier: 'premium',
      durationDays: 30,
      dailyLimit: 10,
      priceLabel: 'Hubungi Admin',
      badge: 'Populer',
      features: [
        'Kuota 10 akun Alight Motion / hari',
        'Tanpa jeda tunggu 10 menit',
        'Akses Bulk Grosir (maks 10 akun / minggu)'
      ]
    },
    {
      id: 'reseller-30d',
      name: 'Reseller Pass (30 Hari)',
      tier: 'reseller',
      durationDays: 30,
      dailyLimit: 25,
      priceLabel: 'Hubungi Admin',
      badge: 'Grosir',
      features: [
        'Kuota 25 akun Alight Motion / hari',
        'Tanpa jeda tunggu antar aktivasi',
        'Bulk Grosir prioritas setiap hari'
      ]
    }
  ]
};

let memoryStoreConfig = null;

function scryptHash(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function scryptVerify(plain, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, origHex] = stored.split(':');
  if (!salt || !origHex) return false;
  const derived = crypto.scryptSync(String(plain), salt, 64);
  const origBuf = Buffer.from(origHex, 'hex');
  if (derived.length !== origBuf.length) return false;
  return crypto.timingSafeEqual(derived, origBuf);
}

function normalizePhone(raw) {
  let digits = String(raw || '').replace(/[^0-9]/g, '');
  if (digits.startsWith('08')) {
    digits = '62' + digits.slice(1);
  }
  return digits.slice(0, 20);
}

function sanitizeStoreConfig(input = {}) {
  const base = { ...DEFAULT_STORE_CONFIG };
  const wa = input.whatsappNumber !== undefined
    ? normalizePhone(input.whatsappNumber)
    : base.whatsappNumber;
  const greeting = typeof input.whatsappGreeting === 'string' && input.whatsappGreeting.trim()
    ? input.whatsappGreeting.trim().slice(0, 240)
    : base.whatsappGreeting;
  const notice = typeof input.storeNotice === 'string'
    ? input.storeNotice.trim().slice(0, 300)
    : base.storeNotice;

  let plans = base.plans;
  if (Array.isArray(input.plans) && input.plans.length > 0) {
    plans = input.plans.slice(0, 6).map((p, idx) => ({
      id: String(p.id || `plan-${idx + 1}`).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || `plan-${idx + 1}`,
      name: String(p.name || 'Paket Voucher').trim().slice(0, 80),
      tier: p.tier === 'reseller' ? 'reseller' : 'premium',
      durationDays: Math.max(1, Math.min(365, Number(p.durationDays) || 30)),
      dailyLimit: Math.max(1, Math.min(200, Number(p.dailyLimit) || 10)),
      priceLabel: String(p.priceLabel || 'Hubungi Admin').trim().slice(0, 40),
      badge: String(p.badge || '').trim().slice(0, 24),
      features: Array.isArray(p.features)
        ? p.features.map(f => String(f || '').trim()).filter(Boolean).slice(0, 6)
        : []
    }));
  }

  return {
    whatsappNumber: wa,
    whatsappGreeting: greeting,
    storeNotice: notice,
    plans
  };
}

async function getStoreConfig() {
  const sql = getSql();
  if (!sql) {
    return memoryStoreConfig || sanitizeStoreConfig({});
  }
  try {
    const rows = await sql`
      SELECT value FROM site_settings WHERE key = 'store_config' LIMIT 1
    `;
    if (rows && rows.length > 0 && rows[0].value) {
      return sanitizeStoreConfig(rows[0].value);
    }
  } catch {}
  return sanitizeStoreConfig({});
}

async function saveStoreConfig(newConfig) {
  const clean = sanitizeStoreConfig(newConfig);
  memoryStoreConfig = clean;
  const sql = getSql();
  if (!sql) return clean;
  await sql`
    INSERT INTO site_settings (key, value, updated_at)
    VALUES ('store_config', ${JSON.stringify(clean)}::jsonb, NOW())
    ON CONFLICT (key) DO UPDATE SET
      value = EXCLUDED.value,
      updated_at = NOW()
  `;
  return clean;
}

async function verifyAdminPassword(candidate) {
  const input = String(candidate || '');
  if (!input) return { ok: false, unconfigured: false };

  const sql = getSql();
  if (sql) {
    try {
      const rows = await sql`
        SELECT value FROM site_settings WHERE key = 'admin_credentials' LIMIT 1
      `;
      if (rows && rows.length > 0 && rows[0].value?.passwordHash) {
        return { ok: scryptVerify(input, rows[0].value.passwordHash), unconfigured: false };
      }
    } catch {}
  }

  const envPass = getEnv('ADMIN_PASSWORD');
  if (!envPass) {
    return { ok: false, unconfigured: true };
  }

  const bufA = Buffer.from(input);
  const bufB = Buffer.from(envPass);
  if (bufA.length !== bufB.length) return { ok: false, unconfigured: false };
  return { ok: crypto.timingSafeEqual(bufA, bufB), unconfigured: false };
}

async function updateAdminPassword(newPassword) {
  const pw = String(newPassword || '');
  if (pw.length < 8) {
    throw new Error('Password Admin minimal 8 karakter.');
  }
  const sql = getSql();
  if (!sql) {
    throw new Error('Database belum terhubung untuk menyimpan password baru.');
  }
  const passwordHash = scryptHash(pw);
  await sql`
    INSERT INTO site_settings (key, value, updated_at)
    VALUES ('admin_credentials', ${JSON.stringify({ passwordHash })}::jsonb, NOW())
    ON CONFLICT (key) DO UPDATE SET
      value = EXCLUDED.value,
      updated_at = NOW()
  `;
}

module.exports = {
  getStoreConfig,
  saveStoreConfig,
  verifyAdminPassword,
  updateAdminPassword,
  scryptHash,
  scryptVerify
};
