const express = require('express')
const auth = require('../../../lib/auth')
const { friendlyFirebaseError } = require('../../../lib/errors')
const { incrementStats, getStatsAsync } = require('../../../lib/stats')
const { extractClientContext, checkQuotaAllowed, recordActivation } = require('../../../lib/quota')

const router = express.Router()

router.post('/', async (req, res) => {
  const { email, magicLink } = req.body
  if (!email || !email.includes('@')) {
    return res.status(400).json({ success: false, message: 'email wajib diisi.', error: 'email wajib diisi.' })
  }
  if (!magicLink || !magicLink.trim()) {
    return res.status(400).json({ success: false, message: 'link dari email wajib diisi.', error: 'link dari email wajib diisi.' })
  }

  const ctx = extractClientContext(req)
  const quotaCheck = await checkQuotaAllowed(ctx, 1)
  if (!quotaCheck.allowed) {
    return res.status(429).json({
      success: false,
      message: quotaCheck.message,
      error: quotaCheck.message,
      quota: quotaCheck.status
    })
  }

  const em = email.trim().toLowerCase()
  const v = await auth.auth(em, magicLink.trim())
  if (!v.ok) {
    const errMsg = friendlyFirebaseError(v.why)
    return res.status(400).json({ success: false, message: errMsg, error: errMsg, code: v.why })
  }

  const premium = await auth.pro(v.id)
  let updatedQuota = quotaCheck.status

  if (premium.ok) {
    incrementStats()
    updatedQuota = await recordActivation({ ...ctx, amEmail: em })
  }

  const stats = await getStatsAsync()

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
    message: premium.ok ? 'verifikasi berhasil, premium aktif.' : 'login berhasil, aktivasi premium gagal.',
    email: v.user?.email || em,
    validUntil: validUntilStr,
    validUntilTimestamp: validUntilTimestamp,
    idToken: v.id,
    refreshToken: v.ref,
    quota: updatedQuota,
    data: {
      stats: stats,
      quota: updatedQuota,
      uid: v.uid,
      email: v.user?.email || em,
      emailVerified: v.user?.emailVerified ?? true,
      displayName: v.user?.displayName || null,
      photoUrl: v.user?.photoUrl || null,
      createdAt: v.user?.createdAt ? new Date(Number(v.user.createdAt)).toISOString() : null,
      lastLoginAt: v.user?.lastLoginAt ? new Date(Number(v.user.lastLoginAt)).toISOString() : now.toISOString(),
      isNewUser: v.baru,
      status: premium.ok ? 'ACTIVE' : 'INACTIVE',
      membershipStatus: premium.ok ? 'PREMIUM_ACTIVE' : 'LOGIN_ONLY',
      planName: 'Alight Motion Pro / Member',
      subscriptionType: 'Yearly VIP License',
      orderId: premium.order || null,
      activatedAt: now.toISOString(),
      validUntil: validUntilStr,
      validUntilTimestamp: validUntilTimestamp,
      tokenType: 'Bearer',
      idToken: v.id,
      refreshToken: v.ref,
      premiumResponse: premium.ok ? premium.r : null,
      premiumError: premium.ok ? null : premium.why,
      profile: v.user || null
    }
  })
})

module.exports = router
