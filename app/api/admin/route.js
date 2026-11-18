const express = require('express');
const { getSql, isDbConfigured } = require('../../../lib/db');
const { getTrustedClientIp, consumeBucket, clearBucket } = require('../../../lib/rate-limit');
const { getStatsAsync } = require('../../../lib/stats');
const {
  createAdminToken,
  verifyAdminToken,
  createVoucherBatch,
  PREMIUM_DAILY_LIMIT,
  RESELLER_DAILY_LIMIT,
  FREE_DAILY_LIMIT
} = require('../../../lib/quota');
const {
  getStoreConfig,
  saveStoreConfig,
  verifyAdminPassword,
  updateAdminPassword,
  scryptHash
} = require('../../../lib/settings');

const router = express.Router();

function requireAdmin(req, res, next) {
  const token = (
    req.headers['x-admin-token'] ||
    req.headers['authorization']?.replace(/^Bearer\s+/i, '') ||
    ''
  ).toString().trim();

  if (!verifyAdminToken(token)) {
    return res.status(401).json({
      success: false,
      message: 'Sesi Admin tidak valid atau telah berakhir. Silakan login kembali.'
    });
  }
  next();
}

router.post('/login', async (req, res) => {
  const ip = getTrustedClientIp(req);
  const rateKey = `admin-login:${ip}`;

  const rl = await consumeBucket(rateKey, 5, 15 * 60 * 1000);
  if (rl.blocked) {
    return res.status(429).json({
      success: false,
      message: `Terlalu banyak percobaan gagal. Tunggu ${Math.ceil(rl.waitSeconds / 60)} menit.`
    });
  }

  const { password } = req.body || {};
  const check = await verifyAdminPassword(password);

  if (check.unconfigured) {
    return res.status(503).json({
      success: false,
      message: 'Environment variable ADMIN_PASSWORD belum dipasang di pengaturan server / Netlify.'
    });
  }

  if (!check.ok) {
    return res.status(401).json({
      success: false,
      message: 'Password Admin salah.'
    });
  }

  await clearBucket(rateKey);
  return res.json({
    success: true,
    token: createAdminToken(),
    message: 'Login Admin berhasil.'
  });
});

router.get('/overview', requireAdmin, async (req, res) => {
  const sql = getSql();
  const stats = await getStatsAsync();

  if (!sql) {
    return res.json({
      success: true,
      dbConnected: false,
      metrics: {
        totalUsers: 0,
        premiumUsers: 0,
        activeVouchers: 0,
        totalActivations: stats.total,
        todayActivations: stats.today
      },
      recentLogs: []
    });
  }

  try {
    const [userCounts, voucherCounts, recentLogs] = await Promise.all([
      sql`
        SELECT
          COUNT(*)::int AS total_users,
          COUNT(*) FILTER (
            WHERE (tier = 'premium' OR tier = 'reseller') AND premium_until > NOW()
          )::int AS premium_users
        FROM app_users
      `,
      sql`
        SELECT
          COUNT(*) FILTER (WHERE is_active = TRUE AND used_count < max_uses)::int AS active_vouchers,
          COUNT(*)::int AS total_vouchers
        FROM vouchers
      `,
      sql`
        SELECT
          l.id,
          l.am_email,
          l.action_type,
          l.tier_at_time,
          l.ip_address,
          l.created_at,
          u.email AS owner_email
        FROM activation_logs l
        LEFT JOIN app_users u ON u.id = l.user_id
        ORDER BY l.created_at DESC
        LIMIT 25
      `
    ]);

    return res.json({
      success: true,
      dbConnected: isDbConfigured(),
      metrics: {
        totalUsers: Number(userCounts?.[0]?.total_users || 0),
        premiumUsers: Number(userCounts?.[0]?.premium_users || 0),
        activeVouchers: Number(voucherCounts?.[0]?.active_vouchers || 0),
        totalVouchers: Number(voucherCounts?.[0]?.total_vouchers || 0),
        totalActivations: stats.total,
        todayActivations: stats.today
      },
      recentLogs: recentLogs || []
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Gagal memuat ringkasan Admin: ' + err.message
    });
  }
});

router.get('/vouchers', requireAdmin, async (req, res) => {
  const sql = getSql();
  if (!sql) {
    return res.status(503).json({ success: false, message: 'Database belum terhubung.' });
  }
  try {
    const rows = await sql`
      SELECT
        v.id,
        v.code_hint,
        v.plan_label,
        v.tier,
        v.daily_limit,
        v.duration_days,
        v.max_uses,
        v.used_count,
        v.expires_at,
        v.is_active,
        v.note,
        v.created_at,
        COALESCE(
          (
            SELECT json_agg(json_build_object('email', u.email, 'at', r.redeemed_at) ORDER BY r.redeemed_at DESC)
            FROM voucher_redemptions r
            JOIN app_users u ON u.id = r.user_id
            WHERE r.voucher_id = v.id
          ),
          '[]'::json
        ) AS redemptions
      FROM vouchers v
      ORDER BY v.created_at DESC
      LIMIT 200
    `;
    return res.json({ success: true, vouchers: rows || [] });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Gagal memuat daftar voucher: ' + err.message });
  }
});

router.post('/vouchers', requireAdmin, async (req, res) => {
  try {
    const {
      count,
      customCode,
      prefix,
      planLabel,
      tier,
      dailyLimit,
      durationDays,
      maxUses,
      note
    } = req.body || {};

    const created = await createVoucherBatch({
      count,
      customCode,
      prefix,
      planLabel,
      tier,
      dailyLimit,
      durationDays,
      maxUses,
      note
    });

    return res.json({
      success: true,
      message: `${created.length} kode voucher berhasil dibuat.`,
      created
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      message: err.message || 'Gagal membuat voucher.'
    });
  }
});

router.patch('/vouchers/:id', requireAdmin, async (req, res) => {
  const sql = getSql();
  if (!sql) return res.status(503).json({ success: false, message: 'Database belum terhubung.' });

  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'ID voucher tidak valid.' });

  const { isActive, maxUses, note } = req.body || {};

  try {
    const rows = await sql`SELECT id, is_active, max_uses, note FROM vouchers WHERE id = ${id} LIMIT 1`;
    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Voucher tidak ditemukan.' });
    }
    const cur = rows[0];
    const nextActive = typeof isActive === 'boolean' ? isActive : cur.is_active;
    const nextMax = maxUses !== undefined ? Math.max(1, Number(maxUses) || cur.max_uses) : cur.max_uses;
    const nextNote = note !== undefined ? (String(note || '').trim().slice(0, 200) || null) : cur.note;

    await sql`
      UPDATE vouchers
      SET is_active = ${nextActive}, max_uses = ${nextMax}, note = ${nextNote}
      WHERE id = ${id}
    `;

    return res.json({ success: true, message: 'Status voucher diperbarui.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Gagal memperbarui voucher.' });
  }
});

router.delete('/vouchers/:id', requireAdmin, async (req, res) => {
  const sql = getSql();
  if (!sql) return res.status(503).json({ success: false, message: 'Database belum terhubung.' });

  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'ID voucher tidak valid.' });

  try {
    await sql`DELETE FROM vouchers WHERE id = ${id}`;
    return res.json({ success: true, message: 'Voucher berhasil dihapus.' });
  } catch {
    return res.status(500).json({ success: false, message: 'Gagal menghapus voucher.' });
  }
});

router.get('/users', requireAdmin, async (req, res) => {
  const sql = getSql();
  if (!sql) return res.status(503).json({ success: false, message: 'Database belum terhubung.' });

  const q = String(req.query.q || '').trim().toLowerCase();

  try {
    const rows = q
      ? await sql`
          SELECT
            id, email, tier, daily_limit, premium_until,
            CASE
              WHEN daily_reset_date < (NOW() AT TIME ZONE 'Asia/Jakarta')::date THEN 0
              ELSE COALESCE(daily_activations_count, 0)
            END AS used_today,
            total_activations, device_fingerprint, device_reset_count, last_bulk_at, created_at
          FROM app_users
          WHERE LOWER(email) LIKE ${'%' + q + '%'}
          ORDER BY created_at DESC
          LIMIT 100
        `
      : await sql`
          SELECT
            id, email, tier, daily_limit, premium_until,
            CASE
              WHEN daily_reset_date < (NOW() AT TIME ZONE 'Asia/Jakarta')::date THEN 0
              ELSE COALESCE(daily_activations_count, 0)
            END AS used_today,
            total_activations, device_fingerprint, device_reset_count, last_bulk_at, created_at
          FROM app_users
          ORDER BY created_at DESC
          LIMIT 100
        `;

    return res.json({ success: true, users: rows || [] });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Gagal memuat daftar pengguna.' });
  }
});

router.post('/users/:id/action', requireAdmin, async (req, res) => {
  const sql = getSql();
  if (!sql) return res.status(503).json({ success: false, message: 'Database belum terhubung.' });

  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'ID akun tidak valid.' });

  const { action, tier, durationDays, dailyLimit, newPassword } = req.body || {};

  try {
    if (action === 'reset-device') {
      await sql`
        UPDATE app_users
        SET device_fingerprint = NULL, device_reset_count = COALESCE(device_reset_count, 0) + 1, updated_at = NOW()
        WHERE id = ${id}
      `;
      return res.json({ success: true, message: 'Kunci perangkat berhasil direset. Pengguna dapat masuk dari HP baru.' });
    }

    if (action === 'reset-bulk') {
      await sql`
        UPDATE app_users SET last_bulk_at = NULL, updated_at = NOW() WHERE id = ${id}
      `;
      return res.json({ success: true, message: 'Jeda mingguan Bulk Grosir direset untuk akun ini.' });
    }

    if (action === 'grant-plan') {
      const nextTier = tier === 'reseller' ? 'reseller' : (tier === 'premium' ? 'premium' : 'free');
      if (nextTier === 'free') {
        await sql`
          UPDATE app_users
          SET tier = 'free', daily_limit = ${FREE_DAILY_LIMIT}, premium_until = NULL, updated_at = NOW()
          WHERE id = ${id}
        `;
        return res.json({ success: true, message: 'Akun dikembalikan ke paket Gratis.' });
      }

      const days = Math.max(1, Math.min(365, Number(durationDays) || 30));
      const limit = Math.max(1, Math.min(200, Number(dailyLimit) || (nextTier === 'reseller' ? RESELLER_DAILY_LIMIT : PREMIUM_DAILY_LIMIT)));
      const uRows = await sql`SELECT premium_until FROM app_users WHERE id = ${id} LIMIT 1`;
      const curMs = uRows?.[0]?.premium_until ? new Date(uRows[0].premium_until).getTime() : 0;
      const baseMs = curMs > Date.now() ? curMs : Date.now();
      const expiryIso = new Date(baseMs + days * 86400 * 1000).toISOString();

      await sql`
        UPDATE app_users
        SET tier = ${nextTier}, daily_limit = ${limit}, premium_until = ${expiryIso}, updated_at = NOW()
        WHERE id = ${id}
      `;
      return res.json({ success: true, message: `Paket ${nextTier.toUpperCase()} (+${days} hari) berhasil diberikan.` });
    }

    if (action === 'reset-password') {
      const pw = String(newPassword || '');
      if (pw.length < 6) {
        return res.status(400).json({ success: false, message: 'Password baru minimal 6 karakter.' });
      }
      const pwHash = scryptHash(pw);
      await sql`
        UPDATE app_users SET password_hash = ${pwHash}, updated_at = NOW() WHERE id = ${id}
      `;
      return res.json({ success: true, message: 'Password akun pengguna berhasil diperbarui.' });
    }

    if (action === 'delete-user') {
      await sql`DELETE FROM app_users WHERE id = ${id}`;
      return res.json({ success: true, message: 'Akun pengguna dihapus.' });
    }

    return res.status(400).json({ success: false, message: 'Aksi tidak dikenali.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Gagal menjalankan aksi pada akun: ' + err.message });
  }
});

router.get('/settings', requireAdmin, async (req, res) => {
  const store = await getStoreConfig();
  return res.json({ success: true, store });
});

router.put('/settings', requireAdmin, async (req, res) => {
  try {
    const { store, newAdminPassword } = req.body || {};
    let savedStore = null;

    if (store && typeof store === 'object') {
      savedStore = await saveStoreConfig(store);
    } else {
      savedStore = await getStoreConfig();
    }

    if (newAdminPassword && String(newAdminPassword).trim()) {
      await updateAdminPassword(String(newAdminPassword).trim());
    }

    return res.json({
      success: true,
      message: newAdminPassword ? 'Pengaturan toko & password Admin berhasil disimpan.' : 'Pengaturan toko & WhatsApp berhasil disimpan.',
      store: savedStore
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      message: err.message || 'Gagal menyimpan pengaturan.'
    });
  }
});

module.exports = router;
