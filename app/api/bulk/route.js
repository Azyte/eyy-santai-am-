const express = require('express');
const auth = require('../../../lib/auth');
const { friendlyFirebaseError } = require('../../../lib/errors');
const { incrementStats } = require('../../../lib/stats');
const {
  extractClientContext,
  checkQuotaAllowed,
  recordActivation,
  getQuotaStatus
} = require('../../../lib/quota');

const router = express.Router();

router.post('/', async (req, res) => {
  const ctx = extractClientContext(req);
  const { action, emails, items } = req.body || {};

  const status = await getQuotaStatus(ctx);
  if (!status.isPremium || !status.canBulk) {
    return res.status(403).json({
      success: false,
      message: 'Fitur Bulk Activation khusus untuk pengguna Kode Voucher Premium / Reseller.',
      quota: status
    });
  }

  // Action 1: Bulk Send Magic Links
  if (action === 'send-links') {
    const emailList = Array.isArray(emails)
      ? emails.map(e => String(e || '').trim().toLowerCase()).filter(e => e.includes('@') && e.includes('.'))
      : [];

    const uniqueEmails = Array.from(new Set(emailList)).slice(0, 10);
    if (uniqueEmails.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Masukkan minimal 1 alamat email yang valid.'
      });
    }

    if (status.remaining < uniqueEmails.length) {
      return res.status(429).json({
        success: false,
        message: `Sisa kuota voucher hari ini (${status.remaining}) tidak cukup untuk ${uniqueEmails.length} akun.`,
        quota: status
      });
    }

    const results = await Promise.all(
      uniqueEmails.map(async em => {
        const r = await auth.link(em);
        return {
          email: em,
          success: r.ok,
          message: r.ok ? 'Magic link terkirim' : friendlyFirebaseError(r.why)
        };
      })
    );

    return res.json({
      success: true,
      sentCount: results.filter(r => r.success).length,
      totalCount: results.length,
      results,
      quota: status
    });
  }

  // Action 2: Bulk Verify & Activate Pro
  if (action === 'verify-links') {
    const pairList = Array.isArray(items) ? items.slice(0, 10) : [];
    if (pairList.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Masukkan daftar magic link untuk diaktifkan.'
      });
    }

    const quotaCheck = await checkQuotaAllowed(ctx, pairList.length);
    if (!quotaCheck.allowed) {
      return res.status(429).json({
        success: false,
        message: quotaCheck.message,
        quota: quotaCheck.status
      });
    }

    const results = [];
    const now = new Date();
    const defaultValidStr = '3 Juli ' + (now.getMonth() >= 6 ? now.getFullYear() + 1 : now.getFullYear());

    for (const item of pairList) {
      const em = String(item.email || '').trim().toLowerCase();
      const linkStr = String(item.magicLink || '').trim();
      if (!em || !linkStr) {
        results.push({ email: em || '-', success: false, message: 'Email atau magic link kosong' });
        continue;
      }

      const v = await auth.auth(em, linkStr);
      if (!v.ok) {
        results.push({
          email: em,
          success: false,
          message: friendlyFirebaseError(v.why)
        });
        continue;
      }

      const premium = await auth.pro(v.id);
      if (premium.ok) {
        incrementStats();
        await recordActivation({ ...ctx, amEmail: v.user?.email || em });
      }

      let validUntilStr = defaultValidStr;
      if (premium.r?.expiryTimeMillis) {
        const d = new Date(Number(premium.r.expiryTimeMillis));
        validUntilStr = d.toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' });
      } else if (premium.r?.expiryDate) {
        validUntilStr = premium.r.expiryDate;
      }

      results.push({
        email: v.user?.email || em,
        success: premium.ok,
        validUntil: validUntilStr,
        refreshToken: v.ref,
        idToken: v.id,
        message: premium.ok ? 'PRO Aktif' : (premium.why || 'Gagal inject struk')
      });
    }

    const updatedQuota = await getQuotaStatus(ctx);
    return res.json({
      success: true,
      activatedCount: results.filter(r => r.success).length,
      totalCount: results.length,
      results,
      quota: updatedQuota
    });
  }

  return res.status(400).json({
    success: false,
    message: 'Action bulk tidak dikenali.'
  });
});

module.exports = router;
