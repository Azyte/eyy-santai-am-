const express = require('express');
const auth = require('../../../lib/auth');
const { friendlyFirebaseError } = require('../../../lib/errors');
const rateLimit = require('../../../lib/rate-limit');

const router = express.Router();

const sendLinkLimiter = rateLimit({
  scope: 'send-link',
  windowMs: 2 * 60 * 1000,
  max: 5,
  message: 'Terlalu sering mengirim tautan.'
});

router.post('/', sendLinkLimiter, async (req, res) => {
  const { email } = req.body || {};
  if (!email || !email.includes('@') || !email.includes('.')) {
    return res.status(400).json({ success: false, message: 'Format email tidak valid.', error: 'Format email tidak valid.' });
  }
  const em = email.trim().toLowerCase();
  const r = await auth.link(em);
  if (!r.ok) {
    const msg = friendlyFirebaseError(r.why);
    return res.status(400).json({ success: false, message: msg, error: msg, code: r.why });
  }
  return res.json({ success: true, email: em, message: `Tautan masuk dikirim ke ${em}. Periksa kotak masuk atau folder Spam.` });
});

module.exports = router;
