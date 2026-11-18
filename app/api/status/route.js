const express = require('express');
const { isDbConfigured } = require('../../../lib/db');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    status: 'online',
    database: isDbConfigured() ? 'configured' : 'memory-fallback',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
