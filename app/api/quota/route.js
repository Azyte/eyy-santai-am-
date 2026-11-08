const express = require('express');
const {
  extractClientContext,
  getQuotaStatus,
  createVoucherInvoice,
  confirmVoucherInvoice
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

router.post('/voucher', async (req, res) => {
  const ctx = extractClientContext(req);
  if (!ctx.voucherCode) {
    return res.status(400).json({
      success: false,
      message: 'Masukkan kode voucher terlebih dahulu.'
    });
  }
  const status = await getQuotaStatus(ctx);
  if (!status.isPremium) {
    return res.status(404).json({
      success: false,
      message: 'Kode Voucher tidak valid atau sudah kedaluwarsa.',
      quota: status
    });
  }
  return res.json({
    success: true,
    message: `Voucher ${status.voucherCode} aktif (${status.tier.toUpperCase()} — ${status.remaining}/${status.limit} kuota hari ini).`,
    quota: status
  });
});

router.post('/checkout', async (req, res) => {
  const { plan = 'premium', email = '' } = req.body || {};
  const invoice = await createVoucherInvoice({ plan, buyerEmail: email });
  return res.json({
    success: true,
    invoice
  });
});

router.post('/confirm', async (req, res) => {
  const ctx = extractClientContext(req);
  const { invoiceCode } = req.body || {};
  const result = await confirmVoucherInvoice({
    invoiceCode,
    fingerprint: ctx.fingerprint,
    ip: ctx.ip
  });
  if (!result.ok) {
    return res.status(400).json({
      success: false,
      message: result.message
    });
  }
  const quota = await getQuotaStatus({ ...ctx, voucherCode: result.voucherCode });
  return res.json({
    success: true,
    message: `Pembayaran berhasil! Kode Voucher Anda: ${result.voucherCode}`,
    voucherCode: result.voucherCode,
    tier: result.tier,
    quota
  });
});

module.exports = router;
