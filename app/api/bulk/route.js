const express = require('express');
const auth = require('../../../lib/auth');
const { friendlyFirebaseError } = require('../../../lib/errors');
const { incrementStats } = require('../../../lib/stats');
const {
  BULK_MAX_ITEMS,
  extractClientContext,
  checkQuotaAllowed,
  recordActivation,
  getQuotaStatus
} = require('../../../lib/quota');

const router = express.Router();

// Process external Firebase + verifyPurchase requests in bounded parallel chunks to stay under Netlify's 10s limit.
async function mapChunks(items, chunkSize, worker) {
  const out = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    const slice = items.slice(i, i + chunkSize);
    const batchRes = await Promise.all(slice.map(worker));
    out.push(...batchRes);
  }
  return out;
}

router.post('/', async (req, res) => {
  const ctx = extractClientContext(req);
  const { action, emails, items } = req.body || {};

  const status = await getQuotaStatus(ctx);
  if (!status.isPremium || !status.canBulk) {
    return res.status(403).json({
      success: false,
      message: 'Fitur Bulk Grosir khusus pengguna Voucher Premium Pass atau Reseller Pass.',
      quota: status
    });
  }

  if (action === 'send-links') {
    const emailList = Array.isArray(emails)
      ? emails.map(e => String(e || '').trim().toLowerCase()).filter(e => e.includes('@') && e.includes('.'))
      : [];

    const uniqueEmails = Array.from(new Set(emailList)).slice(0, BULK_MAX_ITEMS);
    if (uniqueEmails.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Masukkan minimal 1 alamat email yang valid.'
      });
    }

    const quotaCheck = await checkQuotaAllowed(ctx, uniqueEmails.length, { isBulk: true });
    if (!quotaCheck.allowed) {
      return res.status(429).json({
        success: false,
        message: quotaCheck.message,
        quota: quotaCheck.status
      });
    }

    const results = await mapChunks(uniqueEmails, 5, async em => {
      const r = await auth.link(em);
      return {
        email: em,
        success: r.ok,
        message: r.ok ? 'Tautan terkirim' : friendlyFirebaseError(r.why)
      };
    });

    return res.json({
      success: true,
      sentCount: results.filter(r => r.success).length,
      totalCount: results.length,
      results,
      quota: status
    });
  }

  if (action === 'verify-links') {
    const pairList = Array.isArray(items) ? items.slice(0, BULK_MAX_ITEMS) : [];
    if (pairList.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Masukkan daftar pasangan email dan magic link terlebih dahulu.'
      });
    }

    const quotaCheck = await checkQuotaAllowed(ctx, pairList.length, { isBulk: true });
    if (!quotaCheck.allowed) {
      return res.status(429).json({
        success: false,
        message: quotaCheck.message,
        quota: quotaCheck.status
      });
    }

    const now = new Date();
    const defaultValidStr = '3 Juli ' + (now.getMonth() >= 6 ? now.getFullYear() + 1 : now.getFullYear());
    let firstBulkRecorded = false;

    const results = await mapChunks(pairList, 4, async item => {
      const em = String(item.email || '').trim().toLowerCase();
      const linkStr = String(item.magicLink || '').trim();
      if (!em || !linkStr) {
        return { email: em || '-', success: false, message: 'Email atau tautan kosong' };
      }

      const v = await auth.auth(em, linkStr);
      if (!v.ok) {
        return {
          email: em,
          success: false,
          message: friendlyFirebaseError(v.why)
        };
      }

      const premium = await auth.pro(v.id);
      if (premium.ok) {
        incrementStats();
        const markBulk = !firstBulkRecorded;
        firstBulkRecorded = true;
        await recordActivation({
          ...ctx,
          amEmail: v.user?.email || em,
          actionType: 'bulk',
          markBulkUsed: markBulk
        });
      }

      let validUntilStr = defaultValidStr;
      if (premium.r?.expiryTimeMillis) {
        const d = new Date(Number(premium.r.expiryTimeMillis));
        validUntilStr = d.toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' });
      } else if (premium.r?.expiryDate) {
        validUntilStr = premium.r.expiryDate;
      }

      return {
        email: v.user?.email || em,
        success: premium.ok,
        validUntil: validUntilStr,
        refreshToken: v.ref,
        idToken: v.id,
        message: premium.ok ? 'PRO Aktif' : (premium.why || 'Gagal sinkron struk')
      };
    });

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
    message: 'Aksi bulk tidak dikenali.'
  });
});

module.exports = router;
