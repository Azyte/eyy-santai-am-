const express = require('express');
const statusRoute = require('./status/route');
const sendLinkRoute = require('./send-link/route');
const verifyLinkRoute = require('./verify-link/route');
const statsRoute = require('./stats/route');
const renewRoute = require('./renew/route');
const quotaRoute = require('./quota/route');
const bulkRoute = require('./bulk/route');

const router = express.Router();

router.use('/status', statusRoute);
router.use('/send-link', sendLinkRoute);
router.use('/verify-link', verifyLinkRoute);
router.use('/stats', statsRoute);
router.use('/renew', renewRoute);
router.use('/quota', quotaRoute);
router.use('/bulk', bulkRoute);

module.exports = router;
