const express = require('express');
const { isDbConfigured } = require('../../../lib/db');
const { getEnv } = require('../../../lib/env');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    status: 'online',
    database: isDbConfigured() ? 'configured' : 'memory-fallback',
    adminAuth: Boolean(getEnv('ADMIN_PASSWORD')) ? 'configured' : 'unconfigured',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
