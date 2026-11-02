const express = require('express')
const auth = require('../../../lib/auth')
const { friendlyFirebaseError } = require('../../../lib/errors')
const { incrementStats, getStats } = require('../../../lib/stats')

const router = express.Router()

router.post('/', async (req, res) => {
  const { refreshToken } = req.body
  if (!refreshToken || !refreshToken.trim()) {
    return res.status(400).json({ success: false, message: 'Refresh token wajib disertakan.' })
  }

  const r = await auth.re(refreshToken.trim())
  if (!r.ok) {
    return res.status(400).json({
      success: false,
      message: friendlyFirebaseError(r.why) || 'Sesi telah kedaluwarsa. Silakan aktivasi ulang via email.',
      code: r.why
    })
  }

  const premium = await auth.pro(r.id)
  const stats = premium.ok ? incrementStats() : getStats()

  const now = new Date()
  let validUntilStr = '3 Juli ' + (now.getMonth() >= 6 ? now.getFullYear() + 1 : now.getFullYear())
  let validUntilTimestamp = new Date(now.getFullYear() + 1, 6, 3).getTime()

  if (premium.r?.expiryTimeMillis) {
    const d = new Date(Number(premium.r.expiryTimeMillis))
    validUntilStr = d.toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' })
    validUntilTimestamp = d.getTime()
  } else if (premium.r?.expiryDate) {
    validUntilStr = premium.r.expiryDate
  }

  return res.json({
    success: true,
    message: premium.ok ? 'Lisensi VIP berhasil diperpanjang!' : 'Token diperbarui, aktivasi gagal.',
    data: {
      stats: stats,
      status: premium.ok ? 'ACTIVE' : 'INACTIVE',
      planName: 'Alight Motion Pro / Member',
      orderId: premium.order || null,
      validUntil: validUntilStr,
      validUntilTimestamp: validUntilTimestamp,
      idToken: r.id,
      refreshToken: r.ref
    }
  })
})

module.exports = router
