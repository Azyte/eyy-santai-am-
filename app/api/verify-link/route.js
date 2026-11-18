const express = require('express');
const auth = require('../../../lib/auth');
const { friendlyFirebaseError } = require('../../../lib/errors');
const { incrementStats, getStatsAsync } = require('../../../lib/stats');
const { extractClientContext, checkQuotaAllowed, recordActivation } = require('../../../lib/quota');

const router = express.Router();

router.post('/', async (req, res) => {
  const { email, magicLink } = req.body || {};
  if (!email || !email.includes('@')) {
    return res.status(400).json({ success: false, message: 'Email wajib diisi.', error: 'Email wajib diisi.' });
  }
  if (!magicLink || !magicLink.trim()) {
    return res.status(400).json({ success: false, message: 'Tautan dari email wajib diisi.', error: 'Tautan dari email wajib diisi.' });
  }

  const ctx = extractClientContext(req);
  const quotaCheck = await checkQuotaAllowed(ctx, 1, { isBulk: false });
  if (!quotaCheck.allowed) {
    return res.status(429).json({
      success: false,
      message: quotaCheck.message,
      error: quotaCheck.message,
      quota: quotaCheck.status
    });
  }

  const em = email.trim().toLowerCase();
  const v = await auth.auth(em, magicLink.trim());
  if (!v.ok) {
    const errMsg = friendlyFirebaseError(v.why);
    return res.status(400).json({ success: false, message: errMsg, error: errMsg, code: v.why, quota: quotaCheck.status });
  }

  const premium = await auth.pro(v.id);
  if (!premium.ok) {
    const failMsg = 'Login berhasil, tetapi sinkronisasi struk Pro ditolak server pusat. Kuota Anda tidak dipotong.';
    return res.status(502).json({
      success: false,
      message: failMsg,
      error: failMsg,
      detail: premium.why,
      quota: quotaCheck.status
    });
  }

  incrementStats();
  const confirmedEmail = v.user?.email || em;
  const updatedQuota = await recordActivation({ ...ctx, amEmail: confirmedEmail, actionType: 'activate' });
  const stats = await getStatsAsync();

  const now = new Date();
  let validUntilStr = '3 Juli ' + (now.getMonth() >= 6 ? now.getFullYear() + 1 : now.getFullYear());
  let validUntilTimestamp = new Date(now.getFullYear() + 1, 6, 3).getTime();

  if (premium.r?.expiryTimeMillis) {
    const d = new Date(Number(premium.r.expiryTimeMillis));
    validUntilStr = d.toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' });
    validUntilTimestamp = d.getTime();
  } else if (premium.r?.expiryDate) {
    validUntilStr = premium.r.expiryDate;
  }

  return res.json({
    success: true,
    message: 'Verifikasi berhasil, lisensi Pro aktif.',
    email: confirmedEmail,
    validUntil: validUntilStr,
    validUntilTimestamp,
    idToken: v.id,
    refreshToken: v.ref,
    quota: updatedQuota,
    data: {
      stats,
      quota: updatedQuota,
      uid: v.uid,
      email: confirmedEmail,
      emailVerified: v.user?.emailVerified ?? true,
      isNewUser: v.baru,
      status: 'ACTIVE',
      membershipStatus: 'PREMIUM_ACTIVE',
      planName: 'Alight Motion Pro / Member',
      subscriptionType: 'Yearly VIP License',
      orderId: premium.order || null,
      activatedAt: now.toISOString(),
      validUntil: validUntilStr,
      validUntilTimestamp,
      tokenType: 'Bearer',
      idToken: v.id,
      refreshToken: v.ref
    }
  });
});

module.exports = router;
