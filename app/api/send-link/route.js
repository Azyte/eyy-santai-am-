const express = require('express')
const auth = require('../../../lib/auth')
const { friendlyFirebaseError } = require('../../../lib/errors')
const rateLimit = require('../../../lib/rate-limit')

const router = express.Router()

const sendLinkLimiter = rateLimit({
  windowMs: 2 * 60 * 1000,
  max: 5,
  message: 'Terlalu sering mengirim link.'
})

router.post('/', sendLinkLimiter, async (req, res) => {
  const { email } = req.body
  if (!email || !email.includes('@') || !email.includes('.')) {
    return res.status(400).json({ success: false, message: 'email gak valid.' })
  }
  const em = email.trim().toLowerCase()
  const r = await auth.link(em)
  if (!r.ok) {
    return res.status(400).json({ success: false, message: friendlyFirebaseError(r.why), code: r.why })
  }
  return res.json({ success: true, email: em, message: `link dikirim ke ${em}. cek inbox / spam.` })
})

module.exports = router