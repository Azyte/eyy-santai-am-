const express = require('express');
const { getStatsAsync } = require('../../../lib/stats');

const router = express.Router();

router.get('/', async (req, res) => {
  const stats = await getStatsAsync();
  res.json({
    success: true,
    total: stats.total,
    today: stats.today,
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
