const express = require('express');
const auth = require('../../../lib/auth');
const { friendlyFirebaseError } = require('../../../lib/errors');
const { incrementStats, getStatsAsync } = require('../../../lib/stats');
const { extractClientContext, recordActivation } = require('../../../lib/quota');
const rateLimit = require('../../../lib/rate-limit');

const router = express.Router();

const renewLimiter = rateLimit({
  scope: 'renew',
  windowMs: 5 * 60 * 1000,
  max: 6,
  message: 'Terlalu sering memperpanjang lisensi.'
});

router.post('/', renewLimiter, async (req, res) => {
  const { refreshToken, email } = req.body || {};
  if (!refreshToken || !refreshToken.trim()) {
    return res.status(400).json({ success: false, message: 'Refresh token wajib disertakan.', error: 'Refresh token wajib disertakan.' });
  }

  const r = await auth.re(refreshToken.trim());
  if (!r.ok) {
    const errMsg = friendlyFirebaseError(r.why) || 'Sesi telah kedaluwarsa. Silakan aktivasi ulang melalui email.';
    return res.status(400).json({
      success: false,
      message: errMsg,
      error: errMsg,
      code: r.why
    });
  }

  const premium = await auth.pro(r.id);
  if (!premium.ok) {
    const failMsg = 'Token sesi diperbarui, tetapi sinkronisasi struk Pro gagal diproses server pusat.';
    return res.status(502).json({
      success: false,
      message: failMsg,
      error: failMsg,
      detail: premium.why
    });
  }

  incrementStats();
  const ctx = extractClientContext(req);
  await recordActivation({
    ...ctx,
    amEmail: email || 'renew-session',
    actionType: 'renew'
  });
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
    message: 'Lisensi Pro berhasil diperpanjang.',
    validUntil: validUntilStr,
    validUntilTimestamp,
    idToken: r.id,
    refreshToken: r.ref,
    data: {
      stats,
      status: 'ACTIVE',
      planName: 'Alight Motion Pro / Member',
      orderId: premium.order || null,
      validUntil: validUntilStr,
      validUntilTimestamp,
      idToken: r.id,
      refreshToken: r.ref
    }
  });
});

module.exports = router;
