// routes/system.js
const express = require('express');
const router = express.Router();

router.get('/health', (req, res) => {
  res.json({ ok: true, status: 'System Online', timestamp: new Date().toISOString() });
});

module.exports = router;
