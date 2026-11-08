const express = require('express');
const {
  extractClientContext,
  getQuotaStatus,
  registerAppUser,
  loginAppUser,
  redeemVoucherForUser
} = require('../../../lib/quota');

const router = express.Router();

router.get('/', async (req, res) => {
  const ctx = extractClientContext(req);
  const status = await getQuotaStatus(ctx);
  return res.json({
    success: true,
    quota: status
  });
});

router.post('/register', async (req, res) => {
  const ctx = extractClientContext(req);
  const { email, password } = req.body || {};
  const result = await registerAppUser({
    email,
    password,
    fingerprint: ctx.fingerprint,
    ip: ctx.ip,
    ipSubnet: ctx.ipSubnet
  });
  if (!result.ok) {
    return res.status(result.status || 400).json({
      success: false,
      message: result.message
    });
  }
  return res.json({
    success: true,
    message: result.message,
    token: result.token,
    user: result.user,
    quota: result.quota
  });
});

router.post('/login', async (req, res) => {
  const ctx = extractClientContext(req);
  const { email, password } = req.body || {};
  const result = await loginAppUser({
    email,
    password,
    fingerprint: ctx.fingerprint,
    ip: ctx.ip,
    ipSubnet: ctx.ipSubnet
  });
  if (!result.ok) {
    return res.status(result.status || 401).json({
      success: false,
      message: result.message
    });
  }
  return res.json({
    success: true,
    message: result.message,
    token: result.token,
    user: result.user,
    quota: result.quota
  });
});

router.post('/voucher', async (req, res) => {
  const ctx = extractClientContext(req);
  if (!ctx.voucherCode) {
    return res.status(400).json({
      success: false,
      message: 'Masukkan kode voucher terlebih dahulu.'
    });
  }
  const result = await redeemVoucherForUser({
    voucherCode: ctx.voucherCode,
    authToken: ctx.authToken,
    fingerprint: ctx.fingerprint,
    ip: ctx.ip,
    ipSubnet: ctx.ipSubnet
  });
  if (!result.ok) {
    return res.status(result.status || 400).json({
      success: false,
      requireLogin: Boolean(result.requireLogin),
      message: result.message
    });
  }
  return res.json({
    success: true,
    message: result.message,
    quota: result.quota
  });
});

module.exports = router;
